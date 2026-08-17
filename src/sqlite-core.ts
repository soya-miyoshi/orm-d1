/**
 * `orm-d1/sqlite-core` — the Drizzle-named surface a schema file uses.
 *
 * This entry exists so an existing project can migrate with **zero diff**, by
 * aliasing the module specifier instead of editing imports:
 *
 * ```jsonc
 * // tsconfig.json
 * "baseUrl": ".",
 * "paths": {
 *   "drizzle-orm":             ["./node_modules/orm-d1/dist/index.js"],
 *   "drizzle-orm/sqlite-core": ["./node_modules/orm-d1/dist/sqlite-core.js"]
 * }
 * ```
 *
 * The mapping must point at the **`.js`**, and `baseUrl` must be set. Both are
 * load-bearing and both fail silently: esbuild cannot bundle a `.d.ts` target
 * and ignores a bare path with no `baseUrl`, so in either case it falls through
 * to node resolution and bundles the real `drizzle-orm` — which is present by
 * definition for anyone following this recipe. The result typechecks against
 * orm-d1 and runs on Drizzle. `test/unit/module-resolution.test.ts` pins it.
 *
 * Everything here is a re-export of the native API under Drizzle's names, so
 * the two entry points cannot drift.
 */
export {
	alias,
	blob,
	check,
	Column,
	ColumnBuilder,
	customType,
	foreignKey,
	getTableColumns,
	getTableConfig,
	getTableName,
	index,
	integer,
	numeric,
	primaryKey,
	real,
	sqliteTable,
	table,
	text,
	unique,
	uniqueIndex,
} from './index.js';

export type {
	BlobConfig,
	ColumnConfig,
	ColumnMeta,
	InferInsert,
	InferInsertModel,
	InferSelect,
	InferSelectModel,
	IntegerConfig,
	ReferentialAction,
	SQLiteType,
	Table,
	TableConfig,
	TextConfig,
} from './index.js';

/**
 * Drizzle's spelling for "a column of some table", used to break the type
 * cycle a self-referencing foreign key creates:
 *
 * ```ts
 * threadId: integer('thread_id').references((): AnySQLiteColumn => messages.id)
 * ```
 *
 * Our `Column` is the same type. Only the Drizzle spelling is exported: docs/04
 * requires every symbol a schema file mentions to exist in
 * `drizzle-orm/sqlite-core`, and while `AnySQLiteColumn` does, `AnyColumn` does
 * not — Drizzle keeps that one at the package root, so aliasing it here would
 * hand schema authors a name that breaks reverse-aliasing.
 *
 * The bare spelling is what ports. Drizzle's
 * `AnySQLiteColumn<TPartial extends Partial<ColumnBaseConfig>>` takes a partial
 * config, where our `Column<M extends ColumnMeta>` requires `data`, `notNull`
 * and `hasDefault` — so a parameterized `AnySQLiteColumn<{…}>` will not port
 * even though `AnySQLiteColumn` itself does.
 */
export type { Column as AnySQLiteColumn } from './index.js';

/**
 * Drizzle exposes the D1 driver from `drizzle-orm/d1`; orm-d1's `drizzle()`
 * lives on the root entry and is re-exported here for convenience.
 */
export { ormD1, drizzle } from './index.js';
