/**
 * The single-statement relational plan: correlated subqueries plus JSON
 * aggregation, the shape Drizzle v1 produces on SQLite.
 *
 * The default plan is the split one in `query.ts` — a query per relation
 * level, stitched in JavaScript. It reads well in a log, keeps `rows_read`
 * proportional to what was asked for, and binds no parent-key list wider than
 * `json_each` can carry. What it costs is round trips: one per level, and on
 * `--remote` every round trip is an HTTPS call to Cloudflare.
 *
 * This module trades that the other way. Everything comes back in one
 * statement:
 *
 * ```sql
 * select "d0"."id" as "id",
 *   coalesce((select json_group_array(json_object('id', "id", 'title', "title"))
 *             from (select "d1"."id" as "id", "d1"."title" as "title"
 *                   from "posts" as "d1"
 *                   where "d0"."id" = "d1"."author_id") as "t"), json_array()) as "posts"
 * from "users" as "d0"
 * ```
 *
 * The trade is real in both directions and neither plan dominates: this one
 * makes one call but runs the inner query once per outer row, while the split
 * plan makes N calls but does N index scans. Which wins depends on row counts
 * and latency, so the strategy is a switch rather than a replacement — see
 * `relationalStrategy` on `drizzle()`.
 *
 * SQLite has no `LATERAL`, which is why this is a correlated subquery rather
 * than the lateral join Drizzle emits on Postgres. The two are equivalent
 * here: an inner query evaluated per outer row.
 */
import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { alias, getTableColumns, getTableName, getTableOriginalName } from '../schema/table.js';
import type { SQLChunk } from '../sql/sql.js';
import { isPlaceholder, sql } from '../sql/sql.js';
import type { Relation, RelationsConfig, TableRelationalConfig } from './define.js';
import { fieldNameOf, pickColumns } from './projection.js';
import type { FindConfig } from './query.js';

/** How a level's JSON payload maps back onto decoded values. */
export interface JoinedShape {
	/** Column key → its decoder, when it has one. */
	readonly columns: Record<string, ((value: unknown) => unknown) | undefined>;
	readonly relations: Record<string, { readonly many: boolean; readonly shape: JoinedShape }>;
}

/** Quote an identifier for embedding in raw SQL. */
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Quote a SQL string literal — the keys inside `json_object`. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Whether every relation this config reaches can be expressed as a correlated
 * subquery.
 *
 * `through` (many-to-many across a junction) is the gap: it needs a join
 * inside the inner select, which this builder does not emit. Rather than
 * produce subtly wrong SQL, the caller falls back to the split plan for the
 * whole query — the two return identical results, so falling back costs
 * latency and nothing else.
 */
export function supportsJoined(
	config: FindConfig,
	tableConfig: TableRelationalConfig,
	schema: RelationsConfig,
): boolean {
	for (const [name, value] of Object.entries(config.with ?? {})) {
		if (!value) continue;
		const relation = tableConfig.relations[name];
		if (!relation) return false;
		// A junction relation needs a join in the inner select.
		if (relation.throughTable) return false;
		if (!relation.sourceColumns || !relation.targetColumns) return false;

		const target = schema[relation.targetTableName];
		if (!target) return false;

		const childConfig: FindConfig = value === true ? {} : value as FindConfig;

		// A placeholder in a nested page. This plan could serve it — correlated
		// subqueries make per-parent paging natural — but the split plan cannot,
		// and `relationalStrategy` is a performance switch: it must not change
		// which queries are legal. So this defers to split, which refuses with a
		// message describing the plan that actually ran. If split ever learns to
		// take one, this guard is what to delete.
		if (isPlaceholder(childConfig.limit) || isPlaceholder(childConfig.offset)) return false;

		if (!payloadIsExpressible(childConfig, target)) return false;
		if (!supportsJoined(childConfig, target, schema)) return false;
	}
	return true;
}

/**
 * SQLite's `SQLITE_MAX_FUNCTION_ARG`, which defaults to 127 and is what D1
 * ships. `json_object` costs two arguments per key, so a payload wider than
 * this many keys is rejected with `too many arguments on function json_object`.
 * Confirmed against D1: 63 keys pass, 70 do not.
 */
const MAX_JSON_OBJECT_KEYS = 63;

/**
 * Whether a level's payload can survive a trip through `json_object`.
 *
 * Only *relation* levels are checked. A top-level column is selected directly
 * and never enters JSON, so neither limit applies to it — which is why this is
 * called on the child rather than folded into the loop above.
 */
const payloadIsExpressible = (config: FindConfig, tableConfig: TableRelationalConfig): boolean => {
	// JSON has no binary type: `json_object('b', <blob>)` fails outright with
	// `JSON cannot hold BLOB values`. Every `blob()` mode is affected —
	// `buffer`, and the blob-backed `json` and `bigint` — because all three
	// store the column as `blob`.
	for (const key of pickColumns(tableConfig.columns, config.columns)) {
		if (tableConfig.columns[key]?.config.type === 'blob') return false;
	}

	const keys = pickColumns(tableConfig.columns, config.columns).length
		+ Object.keys(config.with ?? {}).length
		+ Object.keys(config.extras ?? {}).length;
	// `columns: {}` with no nested `with`/`extras` projects zero columns —
	// `sql.join([], ', ')` would render `select  from …`, invalid SQL. Fall
	// back to the split plan, which handles the empty payload correctly.
	if (keys === 0) return false;
	return keys <= MAX_JSON_OBJECT_KEYS;
};

export interface JoinedLevel {
	/** Column key → the expression selected for it. */
	readonly selection: Record<string, SQLChunk>;
	readonly shape: JoinedShape;
}

/**
 * Build one level's selection, with each `with` relation as a JSON subquery.
 *
 * `aliasOf` hands out `d0`, `d1`, … so a self-referencing relation — a comment
 * with its parent comment — gets a distinct name per level and the correlation
 * predicate cannot bind to the wrong one.
 */
export function buildLevel(
	table: Table,
	tableConfig: TableRelationalConfig,
	config: FindConfig,
	schema: RelationsConfig,
	next: () => string,
	compileWhere: (config: FindConfig, tableConfig: TableRelationalConfig, table: Table) => SQLChunk | undefined,
	resolveOrderBy: (config: FindConfig, columns: Record<string, Column<any>>) => SQLChunk[],
	resolveExtras: (config: FindConfig, columns: Record<string, Column<any>>) => Record<string, SQLChunk>,
): JoinedLevel {
	const columns = getTableColumns(table) as unknown as Record<string, Column<any>>;
	const projected = pickColumns(tableConfig.columns, config.columns);

	const selection: Record<string, SQLChunk> = {};
	const shapeColumns: Record<string, ((value: unknown) => unknown) | undefined> = {};
	for (const key of projected) {
		const column = columns[key];
		if (!column) continue;
		selection[key] = column;
		shapeColumns[key] = column.config.decode;
	}

	// Extras are projected like columns. Dropping them was silent: a Pothos
	// computed field or an aggregate simply vanished from the row, with no
	// error and no missing-key complaint anywhere.
	for (const [key, expr] of Object.entries(resolveExtras(config, columns))) {
		selection[key] = expr;
		// No decoder: an extra is an arbitrary expression, exactly as in split.
		shapeColumns[key] = undefined;
	}

	const relations: JoinedShape['relations'] = {};

	for (const [name, value] of Object.entries(config.with ?? {})) {
		if (!value) continue;
		const relation = tableConfig.relations[name]!;
		const childConfig: FindConfig = value === true ? {} : value as FindConfig;
		const targetConfig = schema[relation.targetTableName]!;

		const childAlias = next();
		const childTable = alias(targetConfig.table, childAlias) as unknown as Table;
		const childColumns = getTableColumns(childTable) as unknown as Record<string, Column<any>>;

		const child = buildLevel(
			childTable,
			targetConfig,
			childConfig,
			schema,
			next,
			compileWhere,
			resolveOrderBy,
			resolveExtras,
		);

		// Correlate the inner query to this level: parent source column equals
		// child target column, positionally, for composite keys too.
		const predicates: SQLChunk[] = relation.sourceColumns!.map((source, i) => {
			const target = relation.targetColumns![i]!;
			const parent = columns[fieldNameOf(tableConfig.columns, source)]!;
			const childColumn = childColumns[fieldNameOf(targetConfig.columns, target)]!;
			return sql`${parent} = ${childColumn}`;
		});

		const filter = compileWhere(childConfig, targetConfig, childTable);
		if (filter) predicates.push(filter);

		// The relation's own `where` narrows the target rows every time it is
		// traversed, so it belongs inside the correlated subquery alongside the
		// caller's filter. Compiled through the same hook, which is what keeps
		// the two plans emitting the same predicate for the same declaration —
		// except when the relation is reversed (`adoptReverse`): the `where` was
		// declared on the opposite side and names columns of what is, from
		// here, the *parent* level, not the child. It still belongs inside this
		// correlated subquery, just compiled against the outer table/alias.
		if (relation.where) {
			const declared = relation.isReversed
				? compileWhere({ where: relation.where }, tableConfig, table)
				: compileWhere({ where: relation.where }, targetConfig, childTable);
			if (declared) predicates.push(declared);
		}

		const inner = renderInner(
			childTable,
			child.selection,
			predicates,
			resolveOrderBy(childConfig, childColumns),
			childConfig,
			relation,
		);

		const objectArgs = Object.keys(child.selection)
			.map((key) => `${literal(key)}, ${quote(key)}`)
			.join(', ');

		const many = relation.relationType === 'many';
		// No `coalesce(…, json_array())` around the aggregate. Drizzle emits one,
		// but it cannot fire: `json_group_array` over zero rows returns `[]`, not
		// NULL, and an aggregate subquery always yields exactly one row —
		// verified against D1. The `one` branch genuinely can be NULL, and
		// `decodeJoined` turns that into `null`.
		selection[name] = many
			? sql`(select json_group_array(json_object(${sql.raw(objectArgs)})) from (${inner}) as "t")`
			: sql`(select json_object(${sql.raw(objectArgs)}) from (${inner}) as "t")`;

		relations[name] = { many, shape: child.shape };
	}

	return { selection, shape: { columns: shapeColumns, relations } };
}

/** `select … from <child> where <correlation> [order by …] [limit …]`. */
const renderInner = (
	table: Table,
	selection: Record<string, SQLChunk>,
	predicates: readonly SQLChunk[],
	orderBy: readonly SQLChunk[],
	config: FindConfig,
	relation: Relation,
): SQLChunk => {
	const projection = sql.join(
		Object.entries(selection).map(([key, expr]) => sql`${expr} as ${sql.raw(quote(key))}`),
		', ',
	);

	// `from "posts" as "d1zzle_j1"`, spelled out: rendering the aliased table
	// object directly emits only its alias, which SQLite reads as a table of
	// that name — so the inner query looked for a table called "d1zzle_j1".
	const from = sql.raw(`${quote(getTableOriginalName(table))} as ${quote(getTableName(table))}`);
	// Each predicate is parenthesized before joining: `compileFilter` returns
	// an unwrapped `RAW` fragment for a lone predicate (matching Drizzle's
	// `and()` of one operand), and an unparenthesized `or` inside it would
	// otherwise bind looser than intended once joined with the other
	// predicates by a bare `and`.
	let out = sql`select ${projection} from ${from} where ${sql.join(predicates.map((p) => sql`(${p})`), ' and ')}`;
	if (orderBy.length > 0) out = sql`${out} order by ${sql.join([...orderBy], ', ')}`;

	// A `one` relation takes at most one row whatever the data says, so the
	// limit is not optional: without it a broken key would silently pick an
	// arbitrary row out of several.
	if (relation.relationType === 'one') {
		out = sql`${out} limit 1`;
	} else if (config.limit !== undefined) {
		out = sql`${out} limit ${config.limit}`;
	} else if (config.offset !== undefined) {
		// SQLite parses OFFSET only as a suffix of LIMIT, so `offset` without
		// `limit` is a syntax error rather than a skip. `-1` is SQLite's own
		// spelling for "no limit" and is what its documentation prescribes here.
		out = sql`${out} limit -1`;
	}

	if (config.offset !== undefined) out = sql`${out} offset ${config.offset}`;
	return out;
};

/**
 * Turn one driver row into the shape the split plan returns.
 *
 * The relation payloads arrive as JSON text, so their values never went
 * through a column's decoder — a `timestamp_ms` comes back as a number and a
 * `boolean` as 0/1. Applying the decoders here is what makes the two plans
 * return equal values rather than merely equal shapes.
 *
 * `decodeColumns` is false at the top level only: those columns were selected
 * directly, so the compiler has already decoded them, and decoding twice would
 * hand a `Date` to a decoder expecting a number.
 */
export function decodeJoined(
	row: Record<string, unknown>,
	shape: JoinedShape,
	decodeColumns = false,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		const relation = shape.relations[key];

		if (!relation) {
			const decode = decodeColumns ? shape.columns[key] : undefined;
			out[key] = decode && value !== null ? decode(value) : value;
			continue;
		}

		// SQLite drops the JSON subtype when a value passes through a subquery,
		// so a nested payload arrives as an escaped string rather than an
		// object. Both spellings reach here, and both have to work.
		const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;

		if (relation.many) {
			out[key] = Array.isArray(parsed)
				? parsed.map((entry) => decodeJoined(entry as Record<string, unknown>, relation.shape, true))
				: [];
			continue;
		}

		// `null`, not `undefined`: the split plan returns null for an absent
		// `one`, the declared type is `T | null`, and `undefined` additionally
		// disappears from `JSON.stringify` — so an API response would lose the
		// key rather than report it empty.
		out[key] = parsed === null || parsed === undefined
			? null
			: decodeJoined(parsed as Record<string, unknown>, relation.shape, true);
	}

	return out;
}
