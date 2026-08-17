/**
 * The RQBv2 filter DSL — `where` as an object rather than a callback.
 *
 * ```ts
 * db.query.posts.findMany({
 *   where: { views: { gt: 100 }, author: { role: 'admin' } },
 * })
 * ```
 *
 * Two things are worth knowing about the shape. A bare scalar is shorthand for
 * `eq`, so `{ id: 1 }` and `{ id: { eq: 1 } }` are the same filter. And a key
 * that names a *relation* rather than a column compiles to a correlated
 * `exists (…)` against the target table — genuinely new capability here, and
 * one the split-query executor absorbs without changing how children are
 * fetched, because it lands in the parent's `where`.
 *
 * The semantics are taken from `drizzle-orm@1`'s `relationsFilterToSQL`, down
 * to `false` on a relation key meaning `not exists` and an empty `AND: []`
 * contributing nothing.
 */
import { CompileError } from '../errors.js';
import { isDev } from '../dev.js';
import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { alias, getTableColumns, getTableOriginalName } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import {
	and,
	between,
	eq,
	exists,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	notBetween,
	notExists,
	notIlike,
	notInArray,
	notLike,
	or,
} from '../sql/expressions.js';
import type { Placeholder, SQLChunk } from '../sql/sql.js';
import { isPlaceholder, isSQLChunk, sql } from '../sql/sql.js';
import type { Relation, RelationsConfig } from './define.js';

/**
 * Postgres array operators. SQLite has no array type and no faithful stand-in,
 * so these refuse rather than compile to something that quietly answers wrong.
 */
const postgresOnly = (name: string) => (): never => {
	throw new Error(
		`"${name}" is a Postgres array operator and has no SQLite equivalent. `
			+ 'Store the collection in a related table, or filter it in JavaScript.',
	);
};

/** The operator bag handed to a `RAW` callback, shaped as Drizzle's. */
export const filterOperators = {
	and,
	between,
	eq,
	exists,
	gt,
	gte,
	ilike,
	inArray,
	arrayContains: postgresOnly('arrayContains'),
	arrayContained: postgresOnly('arrayContained'),
	arrayOverlaps: postgresOnly('arrayOverlaps'),
	isNull,
	isNotNull,
	like,
	lt,
	lte,
	ne,
	not,
	notBetween,
	notExists,
	notLike,
	notIlike,
	notInArray,
	or,
	sql,
};

export type FilterOperators = typeof filterOperators;

// ------------------------------------------------------------------- types

/** Anything a comparison will accept on the right-hand side. */
type Operand<T> = T | Placeholder<T>;

/** The operator object for one column. */
export interface ColumnFilterOperators<T> {
	eq?: Operand<T>;
	ne?: Operand<T>;
	gt?: Operand<T>;
	gte?: Operand<T>;
	lt?: Operand<T>;
	lte?: Operand<T>;
	/**
	 * No `Placeholder` here, unlike every operator above it. `in (…)` renders
	 * one `?` per value, so its arity is part of the SQL text and has to be
	 * known at compile time — a placeholder filled afterwards can only ever bind
	 * the whole array to a single `?`, which SQLite reads as a scalar. Bind the
	 * list at build time, or match against a subquery.
	 *
	 * The subquery half is spelled out here rather than left to the runtime:
	 * `assertBindableList` accepts a `SQLChunk` and the error it throws points at
	 * exactly that escape hatch, but the type used to admit only an array — so
	 * the alternative the message recommends needed a cast, which makes the guard
	 * the wall it says it is not.
	 */
	in?: readonly T[] | SQLChunk;
	notIn?: readonly T[] | SQLChunk;
	like?: Operand<string>;
	ilike?: Operand<string>;
	notLike?: Operand<string>;
	notIlike?: Operand<string>;
	isNull?: boolean;
	isNotNull?: boolean;
	NOT?: ColumnFilter<T>;
	OR?: readonly ColumnFilter<T>[];
	AND?: readonly ColumnFilter<T>[];
}

/** A bare value is shorthand for `{ eq: value }`. */
export type ColumnFilter<T> = Operand<T> | ColumnFilterOperators<T>;

/** The `RAW` escape hatch: a fragment, or a callback that builds one. */
export type RawFilter =
	| SQLChunk
	| { getSQL(): unknown }
	| ((table: Table, operators: FilterOperators) => SQLChunk | { getSQL(): unknown });

/**
 * A filter, untyped.
 *
 * `db.query` narrows this per table — see `TypedRelationsFilter` in
 * `relations/index.ts`. This is the shape the compiler actually walks.
 */
export interface RelationsFilter {
	AND?: readonly RelationsFilter[] | undefined;
	OR?: readonly RelationsFilter[] | undefined;
	NOT?: RelationsFilter | undefined;
	RAW?: RawFilter | undefined;
	[key: string]: unknown;
}

// ---------------------------------------------------------------- compiling

/**
 * `in` and `notIn` take a literal list, never a placeholder.
 *
 * The type says so, but the type is not the only way in: a filter built from
 * JSON, or from a `RelationsFilter` that has been widened, reaches here
 * unchecked. Without this the placeholder was passed straight to `inArray`,
 * which sees a `SQLChunk` and renders it as a *subquery* — `in (?)` with the
 * whole array bound to one slot, which D1 rejects at run time with
 * `Type 'object' not supported`. There is no spelling that would work: the
 * number of `?` is part of the SQL text and a placeholder is filled after it.
 */
const assertBindableList = (
	operator: 'in' | 'notIn',
	column: Column<any>,
	value: unknown,
): readonly unknown[] | SQLChunk => {
	// The placeholder check comes first because a placeholder is itself a chunk,
	// and the subquery branch below would otherwise swallow it — which is
	// exactly the confusion that produced the bug.
	if (isPlaceholder(value)) {
		throw new CompileError(
			`"${operator}" on column "${column.name}" was given a placeholder. \`in (…)\` renders one bound `
				+ 'parameter per value, so the list has to be known when the statement is compiled — a '
				+ 'placeholder can only fill a single slot, and SQLite would read the array as one scalar. '
				+ 'Pass the array itself, or match against a subquery.',
		);
	}
	if (isSQLChunk(value)) return value;
	if (!Array.isArray(value)) {
		throw new CompileError(
			`"${operator}" on column "${column.name}" expects an array of values or a subquery; received `
				+ `${value === null ? 'null' : typeof value}.`,
		);
	}
	return value as readonly unknown[];
};

const applyColumnOperator = (column: Column<any>, operator: string, value: unknown): Condition | undefined => {
	switch (operator) {
		case 'eq':
			return eq(column, value);
		case 'ne':
			return ne(column, value);
		case 'gt':
			return gt(column, value);
		case 'gte':
			return gte(column, value);
		case 'lt':
			return lt(column, value);
		case 'lte':
			return lte(column, value);
		case 'like':
			return like(column, value as string);
		case 'notLike':
			return notLike(column, value as string);
		case 'ilike':
			return ilike(column, value as string);
		case 'notIlike':
			return notIlike(column, value as string);
		case 'in':
			return inArray(column, assertBindableList('in', column, value));
		case 'notIn':
			return notInArray(column, assertBindableList('notIn', column, value));
		// `isNull: false` is not `is not null` — it is "no constraint", which is
		// how Drizzle reads it. Only the truthy case emits anything.
		case 'isNull':
			return value ? isNull(column) : undefined;
		case 'isNotNull':
			return value ? isNotNull(column) : undefined;
		case 'arrayContains':
		case 'arrayContained':
		case 'arrayOverlaps':
			return postgresOnly(operator)();
		default:
			throw new Error(
				`Unknown filter operator "${operator}" on column "${column.name}". `
					+ 'Expected one of: eq, ne, gt, gte, lt, lte, in, notIn, like, notLike, ilike, notIlike, '
					+ 'isNull, isNotNull, AND, OR, NOT.',
			);
	}
};

/**
 * Compile the filter for a single column.
 *
 * A value that is not a plain object is the `eq` shorthand — which includes a
 * `Placeholder`, an array (for a column whose data type is a JSON array) and
 * `null`, none of which should be walked as an operator record.
 */
const compileColumnFilter = (column: Column<any>, filter: unknown): Condition | undefined => {
	if (filter === null || typeof filter !== 'object' || isSQLChunk(filter) || Array.isArray(filter)) {
		return eq(column, filter);
	}

	const parts: (Condition | undefined)[] = [];
	for (const [operator, value] of Object.entries(filter as Record<string, unknown>)) {
		if (value === undefined) continue;
		switch (operator) {
			case 'NOT': {
				const inner = compileColumnFilter(column, value);
				if (inner) parts.push(not(inner));
				break;
			}
			case 'OR': {
				const branches = value as readonly unknown[];
				if (branches.length > 0) parts.push(or(...branches.map((b) => compileColumnFilter(column, b))));
				break;
			}
			case 'AND': {
				const branches = value as readonly unknown[];
				if (branches.length > 0) parts.push(and(...branches.map((b) => compileColumnFilter(column, b))));
				break;
			}
			default:
				parts.push(applyColumnOperator(column, operator, value));
		}
	}
	return and(...parts);
};

const resolveRaw = (raw: RawFilter, table: Table): SQLChunk | undefined => {
	const produced = typeof raw === 'function' ? raw(table, filterOperators) : raw;
	if (isSQLChunk(produced)) return produced;
	const wrapped = (produced as { getSQL?: () => unknown }).getSQL?.();
	if (isSQLChunk(wrapped)) return wrapped;
	throw new Error('A `RAW` filter must be a SQL fragment, a SQLWrapper, or a function returning one.');
};

/**
 * A relation key becomes a correlated subquery in the parent's `where`.
 *
 * `true` means "has at least one", `false` means "has none", and an object is
 * a filter the related row must also satisfy. The target is aliased per depth
 * so a self-relation — or the same table reached twice — cannot shadow the
 * outer reference it is being correlated against.
 */
const compileRelationFilter = (
	relation: Relation,
	value: unknown,
	table: Table,
	sourceColumns: Record<string, Column<any>>,
	sourceRelations: Record<string, Relation>,
	config: RelationsConfig,
	depth: number,
): Condition | undefined => {
	if (value === undefined) return undefined;

	const target = alias(relation.targetTable, `ormd1_f${depth}`);
	const targetColumns = getTableColumns(target) as Record<string, Column<any>>;
	const rebind = (columns: Record<string, Column<any>>) => {
		const byName = new Map(Object.values(columns).map((c) => [c.name, c]));
		return (column: Column<any>): Column<any> => byName.get(column.name) ?? column;
	};
	const rename = rebind(targetColumns);

	const targetConfig = config[relation.targetTableName];
	// A relation names the *declared* columns of its two tables. One level
	// down, the table this filter applies to is itself an alias, so the
	// correlating side has to be re-bound too or the subquery would compare
	// against `"posts"."id"` when the outer row is `"ormd1_f0"."id"`.
	const outer = rebind(sourceColumns);
	const source = (relation.sourceColumns ?? []).map(outer);
	const targets = relation.targetColumns ?? [];

	let joinTable: SQLChunk;
	let joinCondition: Condition | undefined;

	if (relation.through && relation.throughTable) {
		const junction = alias(relation.throughTable, `ormd1_ft${depth}`);
		const junctionColumns = getTableColumns(junction) as Record<string, Column<any>>;
		const junctionByName = new Map(Object.values(junctionColumns).map((c) => [c.name, c]));
		const viaSource = relation.through.source.map((ref) => junctionByName.get(ref._.column.name) ?? ref._.column);
		const viaTarget = relation.through.target.map((ref) => junctionByName.get(ref._.column.name) ?? ref._.column);

		joinTable = sql`${sql.identifier(getTableOriginalName(relation.targetTable))} as ${target} inner join ${
			sql.identifier(getTableOriginalName(relation.throughTable))
		} as ${junction} on ${and(...viaTarget.map((c, i) => eq(c, rename(targets[i]!))))}`;
		joinCondition = and(...source.map((c, i) => eq(c, viaSource[i]!)));
	} else {
		joinTable = sql`${sql.identifier(getTableOriginalName(relation.targetTable))} as ${target}`;
		joinCondition = and(...source.map((c, i) => eq(c, rename(targets[i]!))));
	}

	const nested = typeof value === 'boolean' || value === null
		? undefined
		: compileFilter(value as RelationsFilter, target, targetColumns, targetConfig?.relations ?? {}, config, depth + 1);

	// The relation's own `where`, if it has one, applies wherever it is used —
	// against the *target* table normally, but against the *source* table when
	// the relation was adopted via `adoptReverse` (`relation.isReversed`): the
	// `where` was declared on the opposite side, where it names columns of what
	// is, from here, the source. The outer table is already in scope as
	// `sourceColumns`/`table` — no fresh alias is needed, it correlates through
	// the same reference the join condition uses.
	const declared = relation.where
		? relation.isReversed
			? compileFilter(relation.where, table, sourceColumns, sourceRelations, config, depth)
			: compileFilter(relation.where, target, targetColumns, targetConfig?.relations ?? {}, config, depth + 1)
		: undefined;

	const predicate = and(joinCondition, declared, nested);
	const body = predicate
		? sql`select 1 from ${joinTable} where ${predicate} limit 1`
		: sql`select 1 from ${joinTable} limit 1`;

	return value === false ? notExists(body) : exists(body);
};

/**
 * Walk the object DSL and emit our own expressions.
 *
 * @param table the table the filter applies to — aliased, at depth > 0. It is
 * handed to `RAW` callbacks, which is what lets Pothos build its batching
 * predicate against the same columns we are filtering on.
 */
export function compileFilter(
	filter: RelationsFilter | undefined,
	table: Table,
	columns: Record<string, Column<any>>,
	relations: Record<string, Relation>,
	config: RelationsConfig,
	depth = 0,
): Condition | undefined {
	if (!filter) return undefined;

	const parts: (Condition | undefined)[] = [];

	for (const [key, value] of Object.entries(filter)) {
		if (value === undefined) continue;

		switch (key) {
			case 'RAW':
				parts.push(resolveRaw(value as RawFilter, table) as Condition);
				continue;
			case 'AND': {
				const branches = value as readonly RelationsFilter[];
				if (branches?.length) {
					parts.push(and(...branches.map((b) => compileFilter(b, table, columns, relations, config, depth))));
				}
				continue;
			}
			case 'OR': {
				const branches = value as readonly RelationsFilter[];
				if (branches?.length) {
					parts.push(or(...branches.map((b) => compileFilter(b, table, columns, relations, config, depth))));
				}
				continue;
			}
			case 'NOT': {
				const inner = compileFilter(value as RelationsFilter, table, columns, relations, config, depth);
				if (inner) parts.push(not(inner));
				continue;
			}
			default:
				break;
		}

		// `hasOwn`, not a bare index: both bags are plain objects, so
		// `columns['constructor']` resolves to `Object` — truthy — and the
		// unknown-field refusal below never runs. The filter then compiled to
		// `? = ?` with a function in the parameter list, which `.bind()` rejects
		// at run time. Callers hand this DSL a `where` straight from JSON (and
		// `JSON.parse` makes `__proto__` an *own* key, so `Object.entries`
		// yields it), which makes every prototype member a spelling that turns a
		// clean 400 into an unhandled 500 — see `docs/07` for the boundary this
		// sits on. Same trap as `plan/params.ts`, `plan/compile.ts`'s
		// `writeAssignments`, `relations/query.ts` and `runtime/database.ts`.
		if (Object.hasOwn(columns, key)) {
			parts.push(compileColumnFilter(columns[key]!, value));
			continue;
		}

		if (Object.hasOwn(relations, key)) {
			parts.push(compileRelationFilter(relations[key]!, value, table, columns, relations, config, depth));
			continue;
		}

		// The documented Pothos use case passes a user-controlled `where`
		// straight into this DSL, and GraphQL servers commonly surface
		// `error.message` to the client — so the full column/relation list is
		// useful during development but a schema-disclosure leak in
		// production. Same `__DEV__` gate `dev.ts`'s other diagnostics use.
		throw new Error(
			isDev()
				? `Unknown filter field "${key}". It is neither a column nor a relation of this table. `
					+ `Columns: ${Object.keys(columns).join(', ')}. `
					+ `Relations: ${Object.keys(relations).join(', ') || '(none)'}.`
				: `Unknown filter field "${key}". It is neither a column nor a relation of this table.`,
		);
	}

	return and(...parts);
}
