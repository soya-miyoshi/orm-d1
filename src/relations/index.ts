/**
 * `d1zzle/relations` — `defineRelations` and `db.query`.
 *
 * A separate entry point, so users who never touch relational queries never
 * parse this code (rule R5).
 */
import type { D1zzleDatabase } from '../runtime/database.js';
import type { Column, ColumnMeta } from '../schema/columns.js';
import type { InferSelect, Simplify } from '../schema/infer.js';
import type { Table, TableColumns } from '../schema/table.js';
import type { Placeholder, SQLChunk } from '../sql/sql.js';
import type { Many, One, Relation, RelationsConfig, RelationsSchema, RelationsShape } from './define.js';
import { tableNamesMapOf } from './define.js';
import type { ColumnFilter, RawFilter } from './filter.js';
import type { ExtrasArg, Operators, OrderByArg } from './query.js';
import { RelationalQuery, RelationalQueryBuilder } from './query.js';

export { ColumnRef, defineRelations, isRelation, Many, One, Relation, tableNamesMapOf } from './define.js';
export type {
	DefinedRelations,
	ManyConfig,
	OneConfig,
	RelationBaseConfig,
	RelationsBuilder,
	RelationsConfig,
	RelationsDeclaration,
	RelationType,
	TableRelationalConfig,
	ThroughColumns,
} from './define.js';
export { compileFilter, filterOperators } from './filter.js';
export type {
	ColumnFilter,
	ColumnFilterOperators,
	FilterOperators,
	RawFilter,
	RelationsFilter,
} from './filter.js';
export { operators, RelationalQuery, RelationalQueryBuilder } from './query.js';
export type { ExtrasArg, FindConfig, Operators, OrderByArg } from './query.js';

// ----------------------------------------------------------------- types

/**
 * The relations declared for one table, recovered from the `defineRelations`
 * callback's return type. `{}` when the table declared none.
 */
type RelationsFor<TRelations, K> = TRelations extends { [RelationsShape]?: infer TConfig }
	? K extends keyof TConfig ? TConfig[K] extends Record<string, Relation> ? TConfig[K] : {}
	: {}
	: {};

/** The schema module a `defineRelations` result was built from. */
type SchemaOf<TRelations> = TRelations extends { [RelationsSchema]?: infer TSchema } ? TSchema : never;

/** The table a relation points at. */
type TargetOf<R> = R extends { $target?: infer T extends Table } ? T : Table;

type ColumnsOf<T extends Table> = T[typeof TableColumns];

type Out<C> = C extends Column<infer M extends ColumnMeta>
	? M['notNull'] extends true ? M['data'] : M['data'] | null
	: never;

/** The table keyed under `TName` in the schema a result was built from. */
type TableOf<TRelations, TName> = TName extends keyof SchemaOf<TRelations>
	? SchemaOf<TRelations>[TName] extends Table ? SchemaOf<TRelations>[TName] : Table
	: Table;

/**
 * The key a relation's target is filed under.
 *
 * Recovered by matching the target table back to the schema, because a relation
 * carries only the table itself at the type level.
 */
type NameOfTarget<TRelations, R> = {
	[K in keyof SchemaOf<TRelations>]: SchemaOf<TRelations>[K] extends TargetOf<R> ? K : never;
}[keyof SchemaOf<TRelations>];

// ------------------------------------------------------------ filter types

/**
 * `where`, narrowed to one table.
 *
 * Every column takes the operator object or the bare-value shorthand; every
 * relation takes `true`, `false`, or a filter on the target. `AND`/`OR`/`NOT`
 * and the `RAW` escape hatch are always available.
 */
export type TypedRelationsFilter<TRelations, TName> =
	& { [K in keyof ColumnsOf<TableOf<TRelations, TName>>]?: ColumnFilter<Out<ColumnsOf<TableOf<TRelations, TName>>[K]>> }
	& {
		[K in keyof RelationsFor<TRelations, TName>]?:
			| boolean
			| TypedRelationsFilter<TRelations, NameOfTarget<TRelations, RelationsFor<TRelations, TName>[K]>>;
	}
	& {
		AND?: readonly TypedRelationsFilter<TRelations, TName>[];
		OR?: readonly TypedRelationsFilter<TRelations, TName>[];
		NOT?: TypedRelationsFilter<TRelations, TName>;
		RAW?: RawFilter;
	};

// ------------------------------------------------------------ result types

type SelectedColumns<T extends Table, TColumns> = TColumns extends Record<string, boolean | undefined>
	? true extends TColumns[keyof TColumns] ? {
			[K in keyof TColumns as TColumns[K] extends true ? K & keyof ColumnsOf<T> : never]: Out<
				ColumnsOf<T>[K & keyof ColumnsOf<T>]
			>;
		}
	: {
		[K in keyof InferSelect<T> as TColumns[K & keyof TColumns] extends false ? never : K]: InferSelect<T>[K];
	}
	: InferSelect<T>;

/**
 * A `one` relation yields `T | null` when it is `optional` (the default) *or*
 * when the include carries a `where` — a filtered traversal can miss even where
 * the foreign key is not nullable. `optional: false` with no `where` is the one
 * combination that yields a bare `T`.
 */
type RelationResult<TRelations, R, TConfig> = R extends Many<any>
	? FindResult<TRelations, NameOfTarget<TRelations, R>, TConfig>[]
	: TConfig extends { where: {} } ? FindResult<TRelations, NameOfTarget<TRelations, R>, TConfig> | null
	: R extends { $optional?: false } ? FindResult<TRelations, NameOfTarget<TRelations, R>, TConfig>
	: FindResult<TRelations, NameOfTarget<TRelations, R>, TConfig> | null;

type SelectedRelations<TRelations, TName, TWith> = TWith extends Record<string, unknown> ? {
		[K in keyof TWith as TWith[K] extends undefined | false ? never : K]: K extends
			keyof RelationsFor<TRelations, TName>
			? RelationResult<TRelations, RelationsFor<TRelations, TName>[K], TWith[K] extends object ? TWith[K] : {}>
			: never;
	}
	: {};

/** `extras` may be a fragment or a callback; both carry their own row type. */
type ExtraValue<E> = E extends SQLChunk<infer V> ? V
	: E extends (...args: never[]) => SQLChunk<infer V> ? V
	: unknown;

type Extras<TExtras> = TExtras extends Record<string, unknown> ? { [K in keyof TExtras]: ExtraValue<TExtras[K]> }
	: {};

/** The row shape a `findMany`/`findFirst` produces for a given config. */
export type FindResult<TRelations, TName, TConfig> = Simplify<
	& SelectedColumns<TableOf<TRelations, TName>, TConfig extends { columns: infer C } ? C : undefined>
	& SelectedRelations<TRelations, TName, TConfig extends { with: infer W } ? W : undefined>
	& Extras<TConfig extends { extras: infer E } ? E : undefined>
>;

// ------------------------------------------------------------ config types

/**
 * Config accepted by `findMany`, narrowed to one table.
 *
 * `limit` is present only when the level can return more than one row. On a
 * `one` relation a limit means nothing — there is at most one row to take — and
 * offering it invites the reading that it caps the *parents*. The runtime
 * ignores it either way; this makes it unwritable. `offset` stays on both,
 * matching Drizzle's own `DBQueryConfig`.
 */
export type TypedFindConfig<TRelations, TName, TRelationType extends 'one' | 'many' = 'many'> =
	& {
		columns?: { [K in keyof ColumnsOf<TableOf<TRelations, TName>>]?: boolean };
		with?: {
			[K in keyof RelationsFor<TRelations, TName>]?:
				| true
				| TypedFindConfig<
					TRelations,
					NameOfTarget<TRelations, RelationsFor<TRelations, TName>[K]>,
					RelationsFor<TRelations, TName>[K] extends Many<any> ? 'many' : 'one'
				>;
		};
		extras?: ExtrasArg<ColumnsOf<TableOf<TRelations, TName>>>;
		where?: TypedRelationsFilter<TRelations, TName>;
		orderBy?: OrderByArg<ColumnsOf<TableOf<TRelations, TName>>>;
		offset?: number | Placeholder<number>;
		comment?: string;
	}
	& (TRelationType extends 'many' ? { limit?: number | Placeholder<number> } : {});

export interface TypedRelationalQueryBuilder<TRelations, TName> {
	findMany<TConfig extends TypedFindConfig<TRelations, TName>>(
		config?: TConfig,
	): RelationalQuery<FindResult<TRelations, TName, TConfig>[]>;
	findFirst<TConfig extends TypedFindConfig<TRelations, TName>>(
		config?: TConfig,
	): RelationalQuery<FindResult<TRelations, TName, TConfig> | undefined>;
}

/** `db.query`, keyed by the TypeScript names in the `defineRelations` schema. */
export type QueryAPI<TRelations> = {
	[K in keyof SchemaOf<TRelations> as SchemaOf<TRelations>[K] extends Table ? K : never]: TypedRelationalQueryBuilder<
		TRelations,
		K
	>;
};

// --------------------------------------------------------------- runtime

/**
 * `_` mirrors Drizzle v1's internal shape.
 *
 * Adapters read it rather than a public API: Pothos' drizzle plugin falls back
 * to `client._.relations` when its builder config omits `relations`, and
 * `schema` is the same object under the name other code looks for.
 */
export interface RelationalMeta<TRelations> {
	readonly relations: TRelations;
	readonly schema: RelationsConfig;
	readonly fullSchema: Record<string, Table>;
	readonly tableNamesMap: Record<string, string>;
	readonly session: unknown;
}

/**
 * Attach `db.query` and `db._` to a database.
 *
 * `drizzle({ client, relations })` calls this for you — this export exists so
 * the relational layer stays out of the core bundle for anyone who does not
 * pass relations, and so it can be attached to an existing db after the fact.
 */
export type { RelationalStrategy } from '../runtime/database.js';
import type { RelationalStrategy } from '../runtime/database.js';

export function withRelations<TRelations extends RelationsConfig>(
	db: D1zzleDatabase,
	relations: TRelations,
	strategy: RelationalStrategy = 'split',
): D1zzleDatabase & { query: QueryAPI<TRelations>; _: RelationalMeta<TRelations> } {
	const config = relations as RelationsConfig;
	const query: Record<string, RelationalQueryBuilder> = {};
	const fullSchema: Record<string, Table> = {};

	for (const [tsName, table] of Object.entries(config)) {
		query[tsName] = new RelationalQueryBuilder(db, config, table, strategy);
		fullSchema[tsName] = table.table;
	}

	const meta: RelationalMeta<TRelations> = {
		relations,
		schema: config,
		fullSchema,
		tableNamesMap: tableNamesMapOf(config),
		session: db.$client,
	};

	// `withSession()` builds a fresh database around the session binding, and
	// cannot reach this module to re-attach the relational surface itself. The
	// hook is how it gets it back — see `D1zzleDatabase.withSession`.
	const attached = Object.assign(db, {
		query,
		_: meta,
		$reattach: (derived: D1zzleDatabase) => void withRelations(derived, relations, strategy),
	});

	return attached as unknown as
		& D1zzleDatabase
		& { query: QueryAPI<TRelations>; _: RelationalMeta<TRelations> };
}

export type { Relation as AnyRelation };
export type { Operators as QueryOperators };
