import { warn } from '../dev.js';
import { CompileError } from '../errors.js';
import { exceedsBytes, MAX_STATEMENT_BYTES } from '../limits.js';
import type { Column } from '../schema/columns.js';
import { isColumn } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import {
	getFlatColumns,
	getTableColumns,
	getTableName,
	getTableNullableGroups,
	getTableOriginalName,
	getTableSource,
	isAliased,
} from '../schema/table.js';
import { hasDecode } from '../sql/functions.js';
import type { ParamSlot, Query, RenderContext, SQLChunk } from '../sql/sql.js';
import { isPlaceholder, isSQLChunk, quoteIdentifier, render, resolveParamBudget } from '../sql/sql.js';
import type { FieldPlan } from './mapper.js';
import { buildKeyedMapper, buildPositionalMapper, buildShape } from './mapper.js';
import type { DeletePlan, InsertPlan, Plan, Selection, SelectPlan, UpdatePlan } from './plan.js';

export interface CompileOptions {
	/** Bound-parameter ceiling; drives insert chunking and `inArray` strategy. */
	readonly maxParams?: number;
	readonly jsonEachThreshold?: number;
}

export interface CompiledQuery<TRow = unknown> {
	readonly kind: Plan['kind'];
	readonly sql: string;
	readonly params: readonly ParamSlot[];
	/**
	 * Every statement this query compiles to. Length > 1 only for multi-row
	 * inserts that exceed the bound-parameter budget, which the runtime then
	 * submits as a single `batch()` — still atomic, still one round trip.
	 */
	readonly parts: readonly Query[];
	/** Positional path — used with `D1PreparedStatement.raw()`. */
	readonly map: (rows: unknown[][]) => TRow[];
	/** Keyed path — used inside `batch()`, where `raw()` is unavailable. */
	readonly mapKeyed: (rows: Record<string, unknown>[]) => TRow[];
	/** True when the statement returns rows (a select, or `.returning()`). */
	readonly hasRows: boolean;
	/** Output column names, in order. Used by the `__DEV__` header assertion. */
	readonly columnNames: readonly string[];
	/** Tables touched; used by `onQuery` hooks and dev diagnostics. */
	readonly tables: readonly string[];
}

export { CompileError };

/** Accumulates SQL text and the parameter slots in the order they appear. */
class Writer {
	sql = '';
	readonly params: ParamSlot[] = [];

	constructor(private readonly ctx: RenderContext) {}

	text(value: string): this {
		this.sql += value;
		return this;
	}

	chunk(chunk: SQLChunk): this {
		const rendered = render(chunk, this.ctx);
		this.sql += rendered.sql;
		this.params.push(...rendered.params);
		return this;
	}

	join(chunks: readonly SQLChunk[], separator = ', '): this {
		for (const [i, chunk] of chunks.entries()) {
			if (i > 0) this.text(separator);
			this.chunk(chunk);
		}
		return this;
	}

	/** Splice in an already-rendered `Query` verbatim — no re-rendering. */
	query(rendered: Query): this {
		this.sql += rendered.sql;
		this.params.push(...rendered.params);
		return this;
	}

	toQuery(): Query {
		return { sql: this.sql, params: this.params };
	}
}

// --------------------------------------------------------------- projection

interface Leaf {
	readonly path: readonly string[];
	readonly expr: SQLChunk;
	readonly column: Column<any> | undefined;
	readonly natural: string;
	readonly decode: ((value: unknown) => unknown) | undefined;
	/** True when the expression is a plain column rendered under its own name. */
	readonly bareColumn: boolean;
}

const decoderOf = (expr: unknown): ((value: unknown) => unknown) | undefined => {
	if (isColumn(expr)) return expr.config.decode;
	if (hasDecode(expr)) return expr.decode;
	return undefined;
};

const isSelectionObject = (value: unknown): value is Selection =>
	typeof value === 'object' && value !== null && !isSQLChunk(value);

const flattenSelection = (selection: Selection, prefix: readonly string[] = []): Leaf[] => {
	const leaves: Leaf[] = [];
	for (const [key, entry] of Object.entries(selection)) {
		const path = [...prefix, key];
		if (isSelectionObject(entry)) {
			leaves.push(...flattenSelection(entry, path));
			continue;
		}
		const column = isColumn(entry) ? entry : undefined;
		leaves.push({
			path,
			expr: entry,
			column,
			natural: key,
			decode: decoderOf(entry),
			bareColumn: column !== undefined && column.name === key,
		});
	}
	return leaves;
};

const tableSelection = (t: Table): Selection => getTableColumns(t) as unknown as Selection;

/**
 * A source's own nullable groups, re-pathed for where it sits in this row.
 *
 * Only a subquery has any: `.as()` records the groups its inner plan left
 * nullable, because reading them back out of the subquery gives the outer plan
 * nothing to re-derive them from — its `joins` are empty, and the columns it
 * sees are the subquery's, all of them ordinarily nullable on their own.
 */
const inheritedNullable = (t: Table, prefix: string): string[] =>
	[...getTableNullableGroups(t)].map((path) => (prefix ? `${prefix}.${path}` : path));

/**
 * The tables (keyed by their in-plan name — post-alias) whose columns an
 * outer/full join can turn into a row of `null`s. Shared by the implicit
 * per-table grouping below and by `explicitNullableGroups`, which needs the
 * same set to decide whether a hand-written nested group can collapse.
 */
const nullableTables = (plan: SelectPlan): Set<string> => {
	const tables = new Set<string>();
	if (!plan.from) return tables;
	// An ordered fold matching Drizzle's own
	// (`drizzle-orm/sqlite-core/query-builders/select.js:111-121`): each join
	// is applied in declaration order against everything already known, not
	// just `plan.from` — a `right`/`full` join nullifies every table already
	// in the accumulator, not only the first one.
	const seen = new Set<string>([getTableName(plan.from)]);
	for (const join of plan.joins) {
		const name = getTableName(join.table);
		seen.add(name);
		if (join.type === 'left') {
			tables.add(name);
		} else if (join.type === 'inner' || join.type === 'cross') {
			tables.delete(name);
		} else if (join.type === 'right') {
			for (const t of seen) tables.add(t);
			tables.delete(name);
		} else if (join.type === 'full') {
			for (const t of seen) tables.add(t);
			tables.add(name);
		}
	}
	return tables;
};

const implicitSelection = (plan: SelectPlan): { selection: Selection; nullable: Set<string> } => {
	const nullable = new Set<string>();
	if (!plan.from) return { selection: {}, nullable };

	if (plan.joins.length === 0) {
		return { selection: tableSelection(plan.from), nullable: new Set(inheritedNullable(plan.from, '')) };
	}

	// With joins, an unqualified select produces one nested group per table,
	// keyed by table name — this is where duplicate column names would
	// otherwise collide.
	const selection: Record<string, Selection> = {
		[getTableName(plan.from)]: tableSelection(plan.from),
	};
	const nullableGroupNames = nullableTables(plan);
	for (const path of inheritedNullable(plan.from, getTableName(plan.from))) nullable.add(path);
	for (const join of plan.joins) {
		const name = getTableName(join.table);
		selection[name] = tableSelection(join.table);
		for (const path of inheritedNullable(join.table, name)) nullable.add(path);
	}
	for (const name of nullableGroupNames) nullable.add(name);
	return { selection, nullable };
};

/**
 * The same collapsing `implicitSelection` derives for its per-table groups,
 * computed instead for a hand-written nested projection: for a depth-1 group
 * whose Column leaves are all from exactly one table on the nullable side of
 * an outer/full join, the group's path collapses to `null` rather than
 * materialising as an object of nulls.
 *
 * Matches Drizzle's `mapResultRow`/`processNullifyMap` (`drizzle-orm/utils.js`)
 * on two points that are easy to get wrong:
 *
 *  - Only a group's *own* depth matters (`path.length === 2`, i.e. `[key,
 *    leafName]`). A leaf nested two levels down (`{ p: { inner: { id } } }`)
 *    does not make `p` collapse — only `p.inner` could, were it examined on
 *    its own. Recursing into deeper leaves here would nullify an ancestor
 *    group Drizzle leaves as a live (if all-null) object.
 *  - A non-Column leaf (`sql`, an expression) does not disqualify the group;
 *    Drizzle simply never installs a nullify entry for it (`is(field,
 *    Column)`) and lets it ride along. Only the Column leaves decide whether
 *    the group is single-table and nullable. A group with no Column leaves
 *    at all never collapses — there is nothing to key off of.
 */
const explicitNullableGroups = (plan: SelectPlan): Set<string> => {
	const groups = new Set<string>();
	if (!plan.selection) return groups;
	const nullable = nullableTables(plan);
	if (nullable.size === 0) return groups;
	for (const [key, entry] of Object.entries(plan.selection)) {
		if (!isSelectionObject(entry)) continue;
		const allLeaves = flattenSelection(entry, [key]);
		if (allLeaves.length === 0) continue;
		// Only this group's own depth is eligible — a leaf that sits deeper
		// belongs to a nested group of its own, not to this one. Drizzle applies
		// `path.length === 2` per leaf (`drizzle-orm/utils.js:136`): a deeper
		// leaf is simply skipped, it does not veto the whole group.
		const leaves = allLeaves.filter((leaf) => leaf.path.length === 2);
		if (leaves.length === 0) continue;
		const tableNames = new Set<string>();
		for (const leaf of leaves) {
			if (!leaf.column) continue;
			tableNames.add(leaf.column.tableName);
		}
		if (tableNames.size !== 1) continue;
		const [tableName] = tableNames;
		if (tableName && nullable.has(tableName)) groups.add(key);
	}
	return groups;
};

/**
 * Assign output names, aliasing the whole projection to `c0…cN` if any two
 * collide. Selects read positionally so duplicates are harmless on the direct
 * path — but not inside `batch()`, where D1 returns keyed objects.
 */
const assignKeys = (leaves: readonly Leaf[]): string[] => {
	const natural = leaves.map((leaf) => leaf.natural);
	const collides = new Set(natural).size !== natural.length;
	return collides ? leaves.map((_, i) => `c${i}`) : natural;
};

/** One output column of a select, as the statement will actually name it. */
export interface ProjectedColumn {
	/** Where it sits in the row: `['id']`, or `['users', 'id']` under a join. */
	readonly path: readonly string[];
	/** The name the statement emits — `c0…cN` once anything collides. */
	readonly key: string;
	/** Set when the projected expression is a plain column. */
	readonly column: Column<any> | undefined;
	readonly decode: ((value: unknown) => unknown) | undefined;
}

/**
 * The projection a plan will compile to, without compiling it.
 *
 * `.as()` needs exactly this and cannot recompute it: deriving the names from
 * `plan.selection` misses `assignKeys`' renaming, and falling back to the
 * `from` table's columns misses every joined table. Both produced a subquery
 * whose declared surface named columns the statement inside it does not emit —
 * `no such column`, from SQL that looked right.
 */
/**
 * The groups this plan's rows can return as `null`, by the same paths
 * `projectedColumns` reports — what `.as()` has to carry so the property
 * survives being read back out of a subquery.
 *
 * An explicit selection collapses too, via `explicitNullableGroups`: a
 * depth-1 group whose leaves are all bare columns from one table on the
 * nullable side of an outer/full join returns `null` rather than an object
 * of nulls, same as the implicit per-table grouping.
 */
export const projectedNullableGroups = (plan: SelectPlan): ReadonlySet<string> =>
	plan.selection === undefined ? implicitSelection(plan).nullable : explicitNullableGroups(plan);

export const projectedColumns = (plan: SelectPlan): readonly ProjectedColumn[] => {
	const selection = plan.selection ?? implicitSelection(plan).selection;
	const leaves = flattenSelection(selection);
	const keys = assignKeys(leaves);
	return leaves.map((leaf, i) => ({
		path: leaf.path,
		key: keys[i]!,
		column: leaf.column,
		decode: leaf.decode,
	}));
};

const writeProjection = (
	writer: Writer,
	leaves: readonly Leaf[],
	keys: readonly string[],
	/** `returning` cannot qualify column names with a table. */
	unqualified = false,
): void => {
	for (const [i, leaf] of leaves.entries()) {
		if (i > 0) writer.text(', ');
		if (unqualified && leaf.column) writer.text(quoteIdentifier(leaf.column.name));
		else writer.chunk(leaf.expr);
		const key = keys[i]!;
		if (!leaf.bareColumn || key !== leaf.natural) writer.text(` as ${quoteIdentifier(key)}`);
	}
};

const buildMappers = <TRow>(
	leaves: readonly Leaf[],
	keys: readonly string[],
	nullableGroups: ReadonlySet<string>,
): Pick<CompiledQuery<TRow>, 'map' | 'mapKeyed' | 'columnNames'> => {
	const fields: FieldPlan[] = leaves.map((leaf, index) => ({
		path: leaf.path,
		index,
		key: keys[index]!,
		decode: leaf.decode,
		isColumn: leaf.column !== undefined,
	}));
	const shape = buildShape(fields, nullableGroups);
	return {
		map: buildPositionalMapper<TRow>(shape),
		mapKeyed: buildKeyedMapper<TRow>(shape, fields),
		columnNames: keys,
	};
};

const noRows = {
	map: () => [],
	mapKeyed: () => [],
	columnNames: [] as readonly string[],
};

// ------------------------------------------------------------------ select

const writeFrom = (writer: Writer, t: Table): void => {
	const source = getTableSource(t);
	if (source) {
		writer.text('(').chunk(source).text(`) ${quoteIdentifier(getTableName(t))}`);
		return;
	}
	writer.text(quoteIdentifier(getTableOriginalName(t)));
	if (isAliased(t)) writer.text(` ${quoteIdentifier(getTableName(t))}`);
};

/**
 * `limit`/`offset` are the only values that reach the SQL text unbound —
 * SQLite accepts a parameter here, but keeping them literal is what lets a
 * query with a fixed limit memoize. That makes this the one place where a
 * non-number would be interpolated verbatim, so it is validated rather than
 * trusted to the types: `limit(Number(searchParams.get('n')))` is common, and
 * it produces `NaN` far more often than it produces an injection.
 */
const writeLimit = (writer: Writer, keyword: string, value: SelectPlan['limit']): void => {
	if (value === undefined) return;
	writer.text(` ${keyword} `);
	if (isPlaceholder(value)) {
		writer.chunk(value);
		return;
	}
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		throw new CompileError(`${keyword} must be a finite number; received ${JSON.stringify(value)}.`);
	}
	writer.text(String(Math.trunc(numeric)));
};

/**
 * D1 caps a statement at 100 KB of SQL text, independently of the parameter
 * budget — bound parameters travel beside the statement, not inside it.
 *
 * Nothing chunks on bytes. Chunking divides by `maxParams`, which is the right
 * divisor for the case that actually reaches this (a wide multi-row insert),
 * so lowering `maxParams` shortens the statements proportionally and is the
 * fix. Naming the budget and the lever beats silently re-chunking on a second
 * axis, and matches how `inArray` reports an array it cannot collapse.
 *
 * A `json_each` payload is a bound parameter and so is not counted here — which
 * is the point of that strategy, and worth knowing when a long `inArray` does
 * *not* trip this.
 */
const assertStatementLength = (query: CompiledQuery<unknown>, maxParams: number): void => {
	for (const part of query.parts) {
		if (!exceedsBytes(part.sql, MAX_STATEMENT_BYTES)) continue;
		throw new CompileError(
			`A statement of ${part.sql.length} characters exceeds D1's ${MAX_STATEMENT_BYTES}-byte limit on SQL `
				+ `text. Bound parameters do not count toward it, so this is statement text: a very wide insert, `
				+ `or a large sql.raw(…) fragment. Lower maxParams (currently ${maxParams}) to chunk into shorter `
				+ 'statements, or shorten the fragment.',
		);
	}
};

/**
 * The last thing every compiler does.
 *
 * It lives on the four per-kind compilers rather than on `compilePlan`, because
 * `compilePlan` is not the path anything real takes: every builder calls its
 * own compiler directly (`select.ts`, `insert.ts`, `update.ts`, `delete.ts`),
 * so a check placed on `compilePlan` alone is reachable only from tests. That
 * is precisely how the length limit shipped unenforced once already.
 */
const sealed = <TRow>(query: CompiledQuery<TRow>, ctx: RenderContext): CompiledQuery<TRow> => {
	assertStatementLength(query, ctx.maxParams);
	return query;
};

export function compileSelect<TRow>(plan: SelectPlan, ctx: RenderContext): CompiledQuery<TRow> {
	const implicit = plan.selection === undefined ? implicitSelection(plan) : undefined;
	const selection = plan.selection ?? implicit!.selection;
	const nullableGroups = implicit?.nullable ?? explicitNullableGroups(plan);
	const leaves = flattenSelection(selection);
	if (leaves.length === 0) throw new CompileError('A select must project at least one column.');

	const keys = assignKeys(leaves);
	const writer = new Writer(ctx);

	writer.text(plan.distinct ? 'select distinct ' : 'select ');
	writeProjection(writer, leaves, keys);

	if (plan.from) {
		writer.text(' from ');
		writeFrom(writer, plan.from);
	}

	for (const join of plan.joins) {
		writer.text(` ${join.type} join `);
		writeFrom(writer, join.table);
		if (join.on) writer.text(' on ').chunk(join.on);
	}

	if (plan.where) writer.text(' where ').chunk(plan.where);
	if (plan.groupBy.length > 0) writer.text(' group by ').join(plan.groupBy);
	if (plan.having) writer.text(' having ').chunk(plan.having);
	if (plan.orderBy.length > 0) writer.text(' order by ').join(plan.orderBy);
	writeLimit(writer, 'limit', plan.limit);
	// SQLite requires a limit before an offset.
	if (plan.offset !== undefined && plan.limit === undefined) writer.text(' limit -1');
	writeLimit(writer, 'offset', plan.offset);

	const query = writer.toQuery();
	const tables = new Set<string>();
	if (plan.from) tables.add(getTableOriginalName(plan.from));
	for (const join of plan.joins) tables.add(getTableOriginalName(join.table));

	return sealed({
		kind: 'select',
		sql: query.sql,
		params: query.params,
		parts: [query],
		hasRows: true,
		tables: [...tables],
		...buildMappers<TRow>(leaves, keys, nullableGroups),
	}, ctx);
}

// -------------------------------------------------------------- write plans

const writeReturning = <TRow>(
	writer: Writer,
	t: Table,
	returning: Selection | true | undefined,
	ctx: RenderContext,
): Pick<CompiledQuery<TRow>, 'map' | 'mapKeyed' | 'columnNames' | 'hasRows'> => {
	if (!returning) return { ...noRows, hasRows: false };

	const selection = returning === true ? tableSelection(t) : returning;
	const leaves = flattenSelection(selection);
	const keys = assignKeys(leaves);
	writer.text(' returning ');
	writeProjection(writer, leaves, keys, true);
	void ctx;
	return { ...buildMappers<TRow>(leaves, keys, new Set()), hasRows: true };
};

/** Encode one value destined for a column, honouring placeholders and `sql`. */
const valueChunk = (column: Column<any>, value: unknown): SQLChunk => {
	if (isPlaceholder(value)) return value.withEncoder(column.config.encode);
	if (isSQLChunk(value)) return value;
	const encoded = value === null || value === undefined ? null : column.config.encode(value);
	return { toQuery: (): Query => ({ sql: '?', params: [{ k: 'const', v: encoded }] }) };
};

const defaultChunk = (column: Column<any>): SQLChunk => ({
	toQuery: (): Query => ({
		sql: '?',
		params: [{
			k: 'fn',
			// Matches drizzle-orm's sqlite-core `buildInsertQuery`: a plain
			// `default` always wins; `onUpdateFn` only supplies the insert-time
			// value when there is no `default` to fall back to instead.
			fn: column.config.defaultFn ?? column.config.onUpdateFn!,
			encode: column.config.encode,
		}],
	}),
});

export function compileInsert<TRow>(plan: InsertPlan, ctx: RenderContext): CompiledQuery<TRow> {
	const columns = getFlatColumns(plan.table);
	if (plan.values.length === 0) throw new CompileError('insert().values([]) has nothing to insert.');

	// Rows with different key sets cannot share one VALUES list, so consecutive
	// runs of identical shapes become separate statements.
	// NUL as the separator: it cannot appear in a JavaScript identifier, so two
	// different field lists can never produce the same key. Written as an escape
	// rather than a literal so tools do not read this file as binary.
	const FIELD_SEPARATOR = '\u0000';
	// Whether a column is eligible for a row's field list depends only on the
	// column's own static config — never on which row is being looked at — so
	// it is decided once per column here rather than re-read (several
	// `.config.*` property chases through every column, every row) inside the
	// per-row loop below. Only `row[field] !== undefined` genuinely varies per
	// row and stays there.
	const columnEntries = Object.entries(columns).map(([field, column]) => ({
		field,
		notGenerated: !column.config.generated,
		alwaysIncluded: column.config.defaultFn !== undefined
			|| (column.config.onUpdateFn !== undefined && column.config.default === undefined),
	}));
	const groups: { fields: string[]; rows: Record<string, unknown>[] }[] = [];
	for (const row of plan.values) {
		// A generated column can never be written: SQLite rejects the statement.
		// The insert type already omits it, so this only catches plain JavaScript
		// callers — and it fails here with a name rather than at D1 with
		// `cannot INSERT into generated column`.
		for (const field of Object.keys(row)) {
			if (row[field] !== undefined && columns[field]?.config.generated) {
				throw new CompileError(`"${field}" is a generated column and cannot be inserted into.`);
			}
		}
		const fields: string[] = [];
		for (const entry of columnEntries) {
			if (entry.notGenerated && (row[entry.field] !== undefined || entry.alwaysIncluded)) fields.push(entry.field);
		}
		if (fields.length === 0) throw new CompileError('An inserted row has no values and no defaults.');
		const key = fields.join(FIELD_SEPARATOR);
		const last = groups.at(-1);
		if (last && last.fields.join(FIELD_SEPARATOR) === key) last.rows.push(row);
		else groups.push({ fields, rows: [row] });
	}

	const parts: Query[] = [];
	let returningInfo: Pick<CompiledQuery<TRow>, 'map' | 'mapKeyed' | 'columnNames' | 'hasRows'> = {
		...noRows,
		hasRows: false,
	};

	const conflictParams = plan.onConflict ? countOnConflictParams(plan.onConflict, columns, ctx) : 0;
	const returningParams = countReturningParams(plan.table, plan.returning, ctx);
	const reservedParams = conflictParams + returningParams;

	for (const group of groups) {
		const cols = group.fields.map((field) => columns[field]!);
		// Actual bound parameters per row, not `cols.length`: a value supplied
		// as a zero-parameter `sql` fragment occupies a column without binding
		// anything, and a fragment like `sql`${a} || ${b}`` can bind more than
		// one. Rendered rather than guessed, the same way `countOnConflictParams`
		// counts the conflict clause — see [F-055], [F-058]. Where that render
		// was needed, it is kept (`.rendered`) rather than thrown away, so the
		// write pass below splices it in instead of rendering the row again —
		// see `rowParamCount`.
		// Two pre-sized parallel arrays rather than `group.rows.map(row =>
		// rowParamCount(...))`: the latter allocates one `{ count, rendered }`
		// wrapper object per row on top of the array itself, for a value only ever
		// read back as `rowCounts[i]`/`rowRendered[i]`.
		const rowCounts: number[] = new Array(group.rows.length);
		const rowRendered: (Query | undefined)[] = new Array(group.rows.length);
		for (let i = 0; i < group.rows.length; i++) {
			const result = rowParamCount(group.rows[i]!, group.fields, cols, ctx);
			rowCounts[i] = result.count;
			rowRendered[i] = result.rendered;
		}
		// Not `Math.max(...rowCounts)`: spreading one call argument per row
		// overflows the call stack around ~125k rows (`RangeError: Maximum call
		// stack size exceeded`).
		let maxRowParams = 0;
		for (const count of rowCounts) if (count > maxRowParams) maxRowParams = count;
		if (maxRowParams + reservedParams > ctx.maxParams) {
			throw new CompileError(
				`A row binds ${maxRowParams} parameter(s) plus ${reservedParams} bound parameter(s) from `
					+ '"on conflict"/"returning" exceed the bound-parameter limit of '
					+ `${ctx.maxParams}; no chunking can satisfy it. Insert fewer columns, bind fewer `
					+ 'parameters per row, or bind fewer parameters in the conflict/returning clauses.',
			);
		}
		const budget = ctx.maxParams - reservedParams;
		// A row built entirely from `sql\`...\`` fragments (or all-default values)
		// can bind zero parameters, so `sum + rowParams[end] <= budget` never trips
		// and every row would land in one chunk regardless of `maxParams` — a
		// statement that can exceed D1's 100KB text limit no matter how low
		// `maxParams` is set. `rowsPerChunk` is the row-count cap main had before
		// param counts were rendered exactly: a fallback bound derived from column
		// count, independent of how many of those columns actually bind a param.
		const rowsPerChunk = Math.max(1, Math.floor(budget / cols.length));

		let start = 0;
		while (start < group.rows.length) {
			let sum = 0;
			let end = start;
			while (
				end < group.rows.length
				&& sum + rowCounts[end]! <= budget
				&& end - start < rowsPerChunk
			) {
				sum += rowCounts[end]!;
				end++;
			}
			// `maxRowParams + reservedParams <= ctx.maxParams` above guarantees
			// every individual row fits the budget alone, and `rowsPerChunk >= 1`,
			// so `end` always advances past `start` here.
			const chunkStart = start;
			start = end;
			const writer = new Writer(ctx);
			writer
				.text(`insert into ${quoteIdentifier(getTableName(plan.table))} (`)
				.text(cols.map((c) => quoteIdentifier(c.name)).join(', '))
				.text(') values ');

			for (let i = chunkStart; i < end; i++) {
				if (i > chunkStart) writer.text(', ');
				const rendered = rowRendered[i];
				// Already rendered once while counting its params — splice it in
				// verbatim rather than rendering this row's columns again.
				if (rendered) {
					writer.query(rendered);
					continue;
				}
				const row = group.rows[i]!;
				writer.text('(');
				for (const [c, column] of cols.entries()) {
					if (c > 0) writer.text(', ');
					const field = group.fields[c]!;
					const value = row[field];
					writer.chunk(
						value === undefined ? defaultChunk(column) : valueChunk(column, value),
					);
				}
				writer.text(')');
			}

			if (plan.onConflict) writeOnConflict(writer, plan.onConflict, columns, ctx);
			returningInfo = writeReturning<TRow>(writer, plan.table, plan.returning, ctx);
			parts.push(writer.toQuery());
		}
	}

	const first = parts[0]!;
	return sealed({
		kind: 'insert',
		sql: first.sql,
		params: first.params,
		parts,
		tables: [getTableOriginalName(plan.table)],
		...returningInfo,
	}, ctx);
}

/** The entries that will actually render; `undefined` means "not set". */
const definedValues = (
	values: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
	if (!values) return undefined;
	// Null-prototype, because `out['__proto__'] = v` on a plain object invokes
	// the inherited setter and re-points the prototype instead of creating an
	// own key. A `set()` parsed from JSON carries `__proto__` as an own key, so
	// the assignment vanished here and the statement failed one step later with
	// "nothing to set" — a refusal, but one that names the wrong problem and
	// hides that the caller sent a field no column answers to. With no
	// prototype the key survives to `writeAssignments`, which reports it.
	const out: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Fold `$onUpdate` columns into a set of values, the same way both the update
 * half of `update().set()` and the update half of an upsert need to: any
 * column with `onUpdateFn` that the caller did not already set gets its
 * generator chunk added. Drizzle routes both through the same `buildUpdateSet`
 * (`drizzle-orm/sqlite-core/dialect.js`); this is the shared equivalent.
 */
const withOnUpdate = (
	values: Record<string, unknown>,
	columns: Record<string, Column<any>>,
): Record<string, unknown> => {
	const out: Record<string, unknown> = { ...values };
	for (const [field, column] of Object.entries(columns)) {
		if (column.config.onUpdateFn && out[field] === undefined) {
			out[field] = { toQuery: () => ({ sql: '?', params: [{ k: 'fn', fn: column.config.onUpdateFn!, encode: column.config.encode }] }) } satisfies SQLChunk;
		}
	}
	return out;
};

/**
 * How many bound parameters `writeOnConflict` will add to *every* statement
 * in the insert, outside the `VALUES` list: the folded `$onUpdate` columns,
 * the user's own `set`, and `targetWhere`/`where`. The row chunker must
 * reserve this many slots out of `maxParams` before dividing the remainder
 * among `VALUES` rows, or a chunk that lands exactly on the budget from
 * `VALUES` alone overflows once this clause is appended.
 *
 * Rendered once against a scratch writer rather than estimated, because the
 * user's own `set`/`where` can themselves be `sql` fragments that bind zero,
 * one, or many parameters — counting must match what `writeOnConflict` will
 * actually emit, not guess "one param per assignment".
 */
/**
 * Render one row's `(col1, col2, …)` text exactly as the real `VALUES` writer
 * would, against a scratch writer — not assumed to be one param per column, a
 * value supplied as a `sql` fragment can bind zero, one, or many parameters.
 * See `countOnConflictParams` below, which the same reasoning is lifted from.
 */
const renderRow = (
	row: Record<string, unknown>,
	fields: readonly string[],
	cols: readonly Column<any>[],
	ctx: RenderContext,
): Query => {
	const scratch = new Writer(ctx);
	scratch.text('(');
	for (const [c, column] of cols.entries()) {
		if (c > 0) scratch.text(', ');
		const field = fields[c]!;
		const value = row[field];
		scratch.chunk(value === undefined ? defaultChunk(column) : valueChunk(column, value));
	}
	scratch.text(')');
	return scratch.toQuery();
};

/**
 * A value that can only ever render to exactly one bound parameter: not a
 * `sql\`...\`` fragment (zero, one, or many params), not a `Placeholder`
 * (deferred, but still exactly one — excluded anyway to keep this check a
 * cheap syntactic one rather than one that has to reason about *why* a shape
 * is safe), and not an array (never valid as a single column's value, but not
 * this function's job to reject it).
 */
const isDynamicRowValue = (value: unknown): boolean => isSQLChunk(value) || isPlaceholder(value) || Array.isArray(value);

/**
 * How many bound parameters one row of `VALUES` will add, plus — when it had
 * to render to find out — the rendered `(col1, col2, …)` text so the later
 * write pass can splice it in with `Writer.query()` instead of re-rendering.
 *
 * The common case — every value a plain scalar (or `undefined`, using a
 * column default) — binds exactly one parameter per column with no rendering
 * needed to know that: `valueChunk`/`defaultChunk` always emit a single `?`
 * for those, so `rendered` stays `undefined` and the write pass renders once,
 * there. Only when a row actually contains a `sql` fragment, a `Placeholder`,
 * or an array does this need to render the row against a scratch `Writer` to
 * count its params — previously that render was thrown away and the row
 * rendered *again* at write time, re-running every column's `encode` twice.
 * Memoizing it here means every row is rendered exactly once either way.
 */
const rowParamCount = (
	row: Record<string, unknown>,
	fields: readonly string[],
	cols: readonly Column<any>[],
	ctx: RenderContext,
): { readonly count: number; readonly rendered: Query | undefined } => {
	let dynamic = false;
	for (const field of fields) {
		if (isDynamicRowValue(row[field])) {
			dynamic = true;
			break;
		}
	}
	if (!dynamic) return { count: cols.length, rendered: undefined };
	const rendered = renderRow(row, fields, cols, ctx);
	return { count: rendered.params.length, rendered };
};

/**
 * How many bound parameters `writeReturning` will add to *every* statement in
 * the insert, outside the `VALUES` list — zero unless `returning()` was given
 * a `Selection` containing a `sql` expression that itself binds parameters.
 */
const countReturningParams = (
	t: Table,
	returning: Selection | true | undefined,
	ctx: RenderContext,
): number => {
	if (!returning) return 0;
	const scratch = new Writer(ctx);
	writeReturning(scratch, t, returning, ctx);
	return scratch.toQuery().params.length;
};

const countOnConflictParams = (
	conflict: NonNullable<InsertPlan['onConflict']>,
	columns: Record<string, Column<any>>,
	ctx: RenderContext,
): number => {
	const scratch = new Writer(ctx);
	writeOnConflict(scratch, conflict, columns, ctx);
	return scratch.toQuery().params.length;
};

const writeOnConflict = (
	writer: Writer,
	conflict: NonNullable<InsertPlan['onConflict']>,
	columns: Record<string, Column<any>>,
	ctx: RenderContext,
): void => {
	writer.text(' on conflict');
	if (conflict.target) {
		writer
			.text(' (')
			.text(conflict.target.columns.map((c) => quoteIdentifier(c.name)).join(', '))
			.text(')');
		if (conflict.target.where) writer.text(' where ').chunk(conflict.target.where);
	}
	// Same rule as `update().set()`: `undefined` means unset, so a `set` whose
	// values are all undefined has nothing to assign and used to render the
	// invalid `do update set `. There is a sensible answer here that there is
	// not for `update()` — an upsert with nothing to update is `do nothing`.
	// That decision is made on the user's own set alone — $onUpdate columns are
	// folded in only after we already know we're emitting `do update set`, so an
	// empty user set still yields `do nothing`.
	const assignments = definedValues(conflict.set);
	if (conflict.doNothing || !assignments) {
		writer.text(' do nothing');
		return;
	}
	writer.text(' do update set ');
	writeAssignments(writer, withOnUpdate(assignments, columns), columns);
	if (conflict.setWhere) writer.text(' where ').chunk(conflict.setWhere);
	void ctx;
};

const writeAssignments = (
	writer: Writer,
	values: Record<string, unknown>,
	columns: Record<string, Column<any>>,
): void => {
	const entries = Object.entries(values).filter(([, v]) => v !== undefined);
	for (const [i, [field, value]] of entries.entries()) {
		if (i > 0) writer.text(', ');
		// `hasOwn`, not a bare index: `set()` takes an object that routinely comes
		// from a request body, and `columns['constructor']` resolves to `Object` —
		// truthy — so the refusal below never ran. What followed was worse than an
		// error: `Object.name` is the string `"Object"`, so the assignment rendered
		// as `"Object" = ?` against a column of that name, and only then died in
		// `valueChunk` on `column.config` being undefined. Same trap as
		// `plan/params.ts`, `relations/filter.ts` and `runtime/database.ts`.
		const column = Object.hasOwn(columns, field) ? columns[field] : undefined;
		if (!column) throw new CompileError(`Unknown column "${field}" in update set.`);
		writer.text(`${quoteIdentifier(column.name)} = `).chunk(valueChunk(column, value));
	}
};

export function compileUpdate<TRow>(plan: UpdatePlan, ctx: RenderContext): CompiledQuery<TRow> {
	const columns = getFlatColumns(plan.table);
	const writer = new Writer(ctx);

	// `undefined` means "not set", the same as absent — `{ x: cond ? v : undefined }`
	// is how conditional updates get written. Keeping the key produced a
	// non-empty `set` object whose assignments all rendered to nothing, so the
	// statement came out as the invalid `update "t" set `.
	const values = withOnUpdate(definedValues(plan.set) ?? {}, columns);
	if (Object.keys(values).length === 0) throw new CompileError('update().set({}) has nothing to set.');

	writer.text(`update ${quoteIdentifier(getTableName(plan.table))} set `);
	writeAssignments(writer, values, columns);
	if (plan.where) writer.text(' where ').chunk(plan.where);
	else warnWhereless('update', plan.table);
	const returningInfo = writeReturning<TRow>(writer, plan.table, plan.returning, ctx);

	const query = writer.toQuery();
	return sealed({
		kind: 'update',
		sql: query.sql,
		params: query.params,
		parts: [query],
		tables: [getTableOriginalName(plan.table)],
		...returningInfo,
	}, ctx);
}

/**
 * A whole-table write is legal and occasionally intended, so this warns rather
 * than throws — and only in `__DEV__`, where the cost is nothing in production.
 *
 * It is easy to reach by accident: `and()` returns `undefined` when every one
 * of its arguments is undefined, so a `where` built from optional filters
 * silently becomes no `where` at all.
 */
const warnWhereless = (kind: 'update' | 'delete', table: Table): void => {
	warn(
		`${kind} on "${getTableName(table)}" has no where clause, so it affects every row. `
			+ 'If that is deliberate, say so explicitly with `where(sql`1 = 1`)`; if the predicate came '
			+ 'from `and(...)` over optional filters, note that `and()` of all-undefined is undefined.',
	);
};

export function compileDelete<TRow>(plan: DeletePlan, ctx: RenderContext): CompiledQuery<TRow> {
	const writer = new Writer(ctx);
	writer.text(`delete from ${quoteIdentifier(getTableName(plan.table))}`);
	if (plan.where) writer.text(' where ').chunk(plan.where);
	else warnWhereless('delete', plan.table);
	const returningInfo = writeReturning<TRow>(writer, plan.table, plan.returning, ctx);

	const query = writer.toQuery();
	return sealed({
		kind: 'delete',
		sql: query.sql,
		params: query.params,
		parts: [query],
		tables: [getTableOriginalName(plan.table)],
		...returningInfo,
	}, ctx);
}

export function compilePlan<TRow = unknown>(plan: Plan, options: CompileOptions = {}): CompiledQuery<TRow> {
	const ctx: RenderContext = resolveParamBudget(options.maxParams, options.jsonEachThreshold);

	switch (plan.kind) {
		case 'select':
			return compileSelect<TRow>(plan, ctx);
		case 'insert':
			return compileInsert<TRow>(plan, ctx);
		case 'update':
			return compileUpdate<TRow>(plan, ctx);
		case 'delete':
			return compileDelete<TRow>(plan, ctx);
	}
}
