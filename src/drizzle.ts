/**
 * `orm-d1/drizzle` — the type-level bridge to Drizzle's own types.
 *
 * At runtime an orm-d1 schema already *is* a Drizzle schema: the entity kinds,
 * the symbols and the column surface all match, and `drizzle-orm`'s `is()`,
 * `getTableColumns()` and `getTableName()` work on it unchanged
 * (see `schema/drizzle-entity.ts`).
 *
 * The types cannot be made assignable the same way. Drizzle's `Column` class
 * declares a `protected config`, and TypeScript only considers a protected
 * member compatible when both types originate from the same declaration — so
 * no independent class can ever be assignable to it. That is a language rule,
 * not something a different phantom shape could work around.
 *
 * This module closes the gap with a cast whose *output* type is computed from
 * the metadata each column already carries, so an adapter typed against
 * `drizzle-orm` accepts our schema and infers exactly the same row types:
 *
 * ```ts
 * import { asDrizzleSchema } from 'orm-d1/drizzle';
 * import { buildSchema } from 'drizzle-graphql';
 *
 * const graphql = buildSchema(db as never, { schema: asDrizzleSchema(schema) });
 * ```
 *
 * `drizzle-orm` is an optional peer. Everything here except `asDrizzleRelations`
 * imports only its types and contributes nothing at runtime; that one function
 * needs Drizzle's `One`/`Many` classes themselves, for the reason documented on
 * it. Nothing outside this module imports `drizzle-orm` at all, so a project
 * that never touches an adapter never loads it.
 */
import { Many as DrizzleMany, One as DrizzleOne } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import type { Column, ColumnMeta } from './schema/columns.js';
import type { ToDrizzleDataType } from './schema/drizzle-entity.js';
import type {
	Many as D1Many,
	One as D1One,
	Relation,
	RelationsSchema,
	RelationsShape,
	TableRelationalConfig,
} from './relations/define.js';
import type { ColumnsMap, NameOf, Table, TableColumns } from './schema/table.js';

type ColumnsOf<T> = T extends { [TableColumns]: infer C extends ColumnsMap } ? C : never;

/** One of our columns, expressed as the Drizzle column it behaves like. */
export type ToDrizzleColumn<C, TTableName extends string, TKey extends string> = C extends
	Column<infer M extends ColumnMeta> ? SQLiteColumn<{
		name: TKey;
		tableName: TTableName;
		dataType: ToDrizzleDataType<M['dataType']>;
		data: M['data'];
		driverParam: M['driverParam'];
		notNull: M['notNull'] extends true ? true : false;
		hasDefault: M['hasDefault'] extends true ? true : false;
		isPrimaryKey: boolean;
		isAutoincrement: boolean;
		hasRuntimeDefault: boolean;
		enumValues: M['enumValues'] extends readonly string[] ? [...M['enumValues']] : undefined;
		// Both are pinned to `undefined`, never `M['generated']`. Drizzle's
		// `OptionalKeyOnly` drops any column whose `generated` is set, which
		// would take every defaultable column out of the inferred insert model.
		// Generated columns are excluded from ours by `InferInsert` instead.
		generated: undefined;
		identity: undefined;
	}>
	: never;

export type ToDrizzleTable<T> = T extends Table ? SQLiteTableWithColumns<{
		name: NameOf<T>;
		schema: undefined;
		dialect: 'sqlite';
		columns: {
			[K in keyof ColumnsOf<T> & string]: ToDrizzleColumn<ColumnsOf<T>[K], NameOf<T>, K>;
		};
	}>
	: T;

export type ToDrizzleSchema<TSchema> = { [K in keyof TSchema]: ToDrizzleTable<TSchema[K]> };

/**
 * Re-type a schema module as Drizzle's. Identity at runtime — the objects
 * already satisfy every check Drizzle makes of them.
 */
export const asDrizzleSchema = <TSchema extends Record<string, unknown>>(
	schema: TSchema,
): ToDrizzleSchema<TSchema> => schema as unknown as ToDrizzleSchema<TSchema>;

/** Re-type a single table. */
export const asDrizzleTable = <T extends Table>(t: T): ToDrizzleTable<T> =>
	t as unknown as ToDrizzleTable<T>;

/**
 * Re-prototype a `defineRelations` result onto Drizzle's `One`/`Many` classes.
 *
 * Needed by `@pothos/plugin-drizzle`, and by nothing else so far. The plugin is
 * duck-typed everywhere but one line, where it decides whether a relation field
 * is a GraphQL list:
 *
 * ```js
 * type: relationField instanceof Many ? [ref] : ref
 * ```
 *
 * That is a bare `instanceof`, not the `is()`/`entityKind` walk the rest of the
 * ecosystem uses, and `instanceof` consults the *right-hand* constructor — so
 * no amount of matching `entityKind` on our side can satisfy it. Without this,
 * every `many` relation silently resolves as a single object instead of a list.
 *
 * Each relation becomes a shallow copy whose prototype is Drizzle's, so it
 * carries every field the plugin reads (`targetTableName`, `sourceColumns`,
 * `targetColumns`) *and* answers `instanceof` correctly. The originals are
 * untouched: `db._.relations` and the query executor keep working on ours.
 *
 * This is the one function in this module with a runtime cost — it is why
 * `drizzle-orm` has to be installed to call it, which anyone using an adapter
 * already does.
 */
export function asDrizzleRelations<TRelations extends Record<string, unknown>>(relations: TRelations): TRelations {
	const adapted: Record<string, unknown> = {};

	for (const [tsName, entry] of Object.entries(relations as Record<string, TableRelationalConfig>)) {
		const rebuilt: Record<string, unknown> = {};
		for (const [name, relation] of Object.entries(entry.relations)) {
			const prototype = (relation.relationType === 'many' ? DrizzleMany : DrizzleOne).prototype;
			rebuilt[name] = Object.assign(Object.create(prototype), relation);
		}
		adapted[tsName] = { ...entry, relations: rebuilt };
	}

	return adapted as TRelations;
}

/**
 * Guard against two resolved `drizzle-orm` copies — see `[F-095]` in
 * `AUDIT.md`.
 *
 * `asDrizzleRelations` re-prototypes onto the `Many`/`One` classes **this
 * module** resolved. If the adapter reading the result (e.g. Pothos' drizzle
 * plugin) resolves a *different* copy of `drizzle-orm` — a lockfile that
 * hoists two versions, a range bump in any dependency — its own `instanceof
 * Many` is `false` for every relation, and every list field silently
 * resolves as a single object instead of an array. No error, no type
 * failure: the two copies' relation types are mutually unassignable, but
 * adapters already require casts at exactly the seams where that
 * assignability would have been checked.
 *
 * Call this once, in the adopter's own test suite, with the `Many` *the app
 * itself* resolves:
 *
 * ```ts
 * import { Many } from 'drizzle-orm';
 * import { assertSameDrizzle } from 'orm-d1/drizzle';
 * assertSameDrizzle({ Many });
 * ```
 *
 * It throws exactly when the two copies diverge. Pinning `drizzle-orm` to an
 * exact version sidesteps the class of bug; this catches the day someone
 * changes that.
 */
export function assertSameDrizzle(other: { readonly Many: unknown }): void {
	if (other.Many !== DrizzleMany) {
		throw new Error(
			'orm-d1/drizzle resolved a different `drizzle-orm` copy than the one this check was called with. '
				+ '`instanceof Many` will be false for every relation an adapter reads through '
				+ '`asDrizzleRelations`, and every "many" relation will silently resolve as a single object. '
				+ 'Pin `drizzle-orm` to one exact version across the dependency tree.',
		);
	}
}

// ------------------------------------------------------- Pothos' generic slot

/**
 * The schema module a `defineRelations` result was built from, and the relation
 * record its callback returned. Recovered from the two phantom keys the result
 * carries; `relations/index.ts` reads the same pair to type `db.query`.
 */
type SchemaOf<TRelations> = TRelations extends { [RelationsSchema]?: infer TSchema } ? TSchema : never;
type ShapeOf<TRelations> = TRelations extends { [RelationsShape]?: infer TConfig } ? TConfig : never;

type RelationsFor<TRelations, K> = K extends keyof ShapeOf<TRelations>
	? ShapeOf<TRelations>[K] extends infer R extends Record<string, Relation> ? R : {}
	: {};

/** The table a relation points at, as its phantom carries it. */
type TargetOf<R> = R extends { $target?: infer T extends Table } ? T : Table;

/**
 * The key a relation's target is filed under in the schema.
 *
 * Drizzle names a relation's target by its *TypeScript* key, but our `One`/
 * `Many` carry the target table itself, so the name is recovered by matching
 * the table back against the schema — the same recovery `NameOfTarget` does in
 * `relations/index.ts`.
 */
type TargetNameOf<TSchema, R> = {
	[K in keyof TSchema & string]: TSchema[K] extends TargetOf<R> ? K : never;
}[keyof TSchema & string];

/**
 * One of our relations, expressed as the Drizzle relation it behaves like.
 *
 * Drizzle's `One`/`Many` are referenced rather than reconstructed: both declare
 * a `protected $relationBrand`, so — unlike `TableRelationalConfig['table']` —
 * these two genuinely are unsatisfiable by an independent declaration, and the
 * only assignable spelling is Drizzle's own class with our type arguments.
 */
type ToDrizzleRelation<TSchema, R> = R extends D1Many<any> ? DrizzleMany<TargetNameOf<TSchema, R>>
	: R extends D1One<any, infer TOptional extends boolean> ? DrizzleOne<TargetNameOf<TSchema, R>, TOptional>
	: never;

/**
 * A `defineRelations` result, expressed as Drizzle's `TablesRelationalConfig` —
 * the type `@pothos/plugin-drizzle` slots into its `DrizzleRelations` generic:
 *
 * ```ts
 * const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof relations> }>({
 *   plugins: [DrizzlePlugin],
 *   drizzle: { client: db, getTableConfig, relations: asPothosRelations(relations) },
 * });
 * ```
 *
 * The protected-member wall documented at the top of this module applies to
 * *our* table type, not to this: Drizzle's `TableRelationalConfig` asks only for
 * `{ table: SchemaEntry; name: string; relations: RelationsRecord }`, and
 * `SchemaEntry` is `Table<any> | View<…>` — so `ToDrizzleTable` satisfies it
 * outright, and no member of the interface is ever compared nominally.
 *
 * The typing is genuine, not vacuous: an unknown column, a mistyped resolver
 * return and an unknown relation name are each rejected. See
 * `test/unit/pothos-types.test.ts`, which pins all three as negative controls.
 */
export type PothosRelations<TRelations> = {
	[K in keyof SchemaOf<TRelations> & string as SchemaOf<TRelations>[K] extends Table ? K : never]: {
		table: ToDrizzleTable<SchemaOf<TRelations>[K]>;
		name: K;
		relations: {
			[R in keyof RelationsFor<TRelations, K>]: ToDrizzleRelation<
				SchemaOf<TRelations>,
				RelationsFor<TRelations, K>[R]
			>;
		};
	};
};

/**
 * {@link asDrizzleRelations}, typed as {@link PothosRelations}.
 *
 * Identical at runtime — the re-prototyping is the whole job, and it is why
 * this exists as well as the type. Separate from `asDrizzleRelations` because
 * that one is deliberately identity-typed for adapters that read our shape
 * back; this one is for handing the result to Pothos' builder config, where the
 * value has to line up with the generic above.
 */
export const asPothosRelations = <TRelations extends Record<string, unknown>>(
	relations: TRelations,
): PothosRelations<TRelations> =>
	asDrizzleRelations(relations) as unknown as PothosRelations<TRelations>;

// ------------------------------------------- Pothos' resolver-side find-config

/**
 * Pothos' `query()` result, retyped as the orm-d1 find-config it already is.
 *
 * `@pothos/plugin-drizzle` hands every drizzle-backed resolver a `query()` that
 * merges the caller's selection with the columns and relations the GraphQL
 * selection set needs, and the result goes straight to
 * `db.query.<table>.findMany` / `findFirst`.
 *
 * The merged config is a valid orm-d1 config at runtime, but not at the type
 * level, because the plugin declares one extra key:
 *
 * ```ts
 * extras: { $pothosQueryFor: SQL<'places' | undefined> }
 * ```
 *
 * where `SQL` is Drizzle's. Ours renders through `toQuery(ctx?: RenderContext)`
 * and Drizzle's through `toQuery(config: BuildQueryConfig)`, so the marker is
 * not assignable to `ExtrasArg` and the whole config is rejected with it.
 *
 * The marker is **phantom**: it appears only in the plugin's `.d.ts` files and
 * is never constructed — there are zero occurrences in its emitted JavaScript.
 * So there is nothing to render and nothing for `ExtrasArg` to learn to accept;
 * the type just has to stop being threaded through. This drops it, and returns
 * the selection's own type so the config keeps being checked.
 *
 * ```ts
 * ctx.db.query.places.findMany(pothosFindConfig(query, { where: { clubId } }))
 * ```
 *
 * `where`, `columns`, `with` and `orderBy` are checked against the schema by
 * `findMany`'s own `TConfig extends TypedFindConfig<…>` constraint, which is
 * what the previous `as never` laundering gave up.
 */
export const pothosFindConfig = <TConfig>(
	query: (selection?: never) => unknown,
	selection: TConfig,
): TConfig => (query as unknown as (s: TConfig) => TConfig)(selection);
