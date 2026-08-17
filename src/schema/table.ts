import { CompileError } from '../errors.js';
import type { InferInsert, InferSelect } from './infer.js';
import { MAX_COLUMNS_PER_TABLE } from '../limits.js';
import type { Query, SQLChunk } from '../sql/sql.js';
import { quoteIdentifier } from '../sql/sql.js';
import type { Column, ColumnBuilder, ColumnMeta, ReferentialAction } from './columns.js';
import { isColumn } from './columns.js';
import type { TableExtra } from './constraints.js';
import { indexName, isTableExtra, uniqueConstraintName } from './constraints.js';
import {
	DrizzleBaseName,
	DrizzleColumns,
	DrizzleExtraConfigBuilder,
	DrizzleExtraConfigColumns,
	DrizzleInlineForeignKeys,
	DrizzleIsAlias,
	DrizzleIsDrizzleTable,
	DrizzleOriginalName,
	DrizzleSchema,
	DrizzleTableName,
	entityKind,
	SQLiteTableEntity,
} from './drizzle-entity.js';

export const TableName = Symbol.for('ormD1:TableName');
export const TableOriginalName = Symbol.for('ormD1:TableOriginalName');
export const TableColumns = Symbol.for('ormD1:TableColumns');
export const TableExtras = Symbol.for('ormD1:TableExtras');
export const IsTable = Symbol.for('ormD1:IsTable');

/**
 * A table's columns by TypeScript name.
 *
 * Nested for subqueries only: a join or a nested selection produces grouped
 * rows, so `sq.users.id` is the honest surface for the statement inside. A
 * declared table is always flat.
 */
export interface ColumnsMap {
	[key: string]: Column<any> | ColumnsMap;
}

/**
 * Type-level marker on a *group* of subquery columns that an outer join can
 * leave null, so `Out<>` can widen it the way it widens a nullable column.
 *
 * A group's nullability has nowhere else to live: it is not a property of any
 * one column in it — every leaf is independently nullable — but of the group as
 * a whole, which the runtime mapper collapses to `null` when all of its columns
 * come back null. The declaration is ambient: the marker is never a real
 * property, only a phantom key on the type `.as()` reports.
 */
export declare const NullableGroup: unique symbol;

/** A group of subquery columns that reads back as `null` on a missed join. */
export type NullableColumns = { readonly [NullableGroup]?: true };

export interface TableMeta<TColumns extends ColumnsMap, TName extends string = string> extends SQLChunk {
	readonly [IsTable]: true;
	/** Effective name — the alias, when the table has been aliased. */
	readonly [TableName]: TName;
	readonly [TableOriginalName]: string;
	readonly [TableColumns]: TColumns;
	readonly [TableExtras]: readonly TableExtra[];
	/**
	 * Type-only — never assigned at runtime. Matches Drizzle's
	 * `typeof table.$inferSelect` / `typeof table.$inferInsert` property
	 * spelling, alongside the free-standing `InferSelectModel<T>` /
	 * `InferInsertModel<T>` helpers, so a schema ported by changing one import
	 * specifier keeps every `typeof X.$inferInsert` annotation compiling.
	 * See `[F-094]` in `AUDIT.md`.
	 */
	readonly $inferSelect: InferSelect<this>;
	readonly $inferInsert: InferInsert<this>;
}

/**
 * A table.
 *
 * Bare `Table` is the *metadata* shape only — every concrete table is
 * assignable to it, which is what lets internals take `Table` without forcing
 * an index signature onto user schemas. With type arguments it also carries
 * the columns, for property access and inference.
 */
export type Table<TColumns extends ColumnsMap = never, TName extends string = string> =
	[TColumns] extends [never] ? TableMeta<ColumnsMap, string>
		: TColumns & TableMeta<TColumns, TName>;

/** The table's name, at the type level — used to key joined result shapes. */
export type NameOf<T> = T extends TableMeta<any, infer N> ? N : string;

export type BuilderMap = Record<string, ColumnBuilder<any>>;

export type BuiltColumns<T extends BuilderMap> = {
	[K in keyof T]: T[K] extends ColumnBuilder<infer M extends ColumnMeta> ? Column<M> : never;
};

type ExtrasResult = readonly TableExtra[] | Record<string, TableExtra> | TableExtra | void;

/**
 * A table is an *instance* of a class whose static `entityKind` chain matches
 * Drizzle's, and it carries Drizzle's symbols alongside our own. That is what
 * makes `is(t, SQLiteTable)`, `getTableColumns(t)` and every existing Drizzle
 * adapter work on an orm-d1 schema unchanged. See `drizzle-entity.ts`.
 */
class OrmD1Table extends SQLiteTableEntity {
	static override readonly [entityKind]: string = 'SQLiteTable';
}

const buildTable = (
	name: string,
	originalName: string,
	columns: ColumnsMap,
	extras: readonly TableExtra[],
	isAliasOf = false,
): Table => {
	// `$inferSelect`/`$inferInsert` are type-only — never assigned, so the
	// literal below is not a `TableMeta` until cast. See `[F-094]`.
	const meta = {
		[IsTable]: true,
		[TableName]: name,
		[TableOriginalName]: originalName,
		[TableColumns]: columns,
		[TableExtras]: extras,
		toQuery: (): Query => ({ sql: quoteIdentifier(name), params: [] }),
	} as unknown as TableMeta<ColumnsMap>;

	const drizzleMeta = {
		[DrizzleTableName]: name,
		[DrizzleOriginalName]: originalName,
		[DrizzleSchema]: undefined,
		[DrizzleColumns]: columns,
		[DrizzleExtraConfigColumns]: columns,
		[DrizzleBaseName]: originalName,
		[DrizzleIsAlias]: isAliasOf,
		[DrizzleIsDrizzleTable]: true,
		[DrizzleExtraConfigBuilder]: undefined,
		[DrizzleInlineForeignKeys]: [],
	};

	const t = Object.assign(new OrmD1Table(), columns, meta, drizzleMeta) as unknown as Table;
	// Skips a nested group, which only a subquery over grouped rows produces.
	// Its leaves still get a `table`, one level down.
	const own = (map: ColumnsMap): void => {
		for (const entry of Object.values(map)) {
			if (isColumn(entry)) entry.table = t;
			else own(entry as ColumnsMap);
		}
	};
	own(columns);
	return t;
};

/**
 * Declare a table. Property keys are the TypeScript-facing names; the column's
 * own `name` argument (if given) is the database name.
 *
 * The third argument accepts both the current array-returning form and the
 * legacy object-returning form, because real codebases contain both.
 */
export function table<TName extends string, TBuilders extends BuilderMap>(
	name: TName,
	builders: TBuilders,
	extras?: (columns: BuiltColumns<TBuilders>) => ExtrasResult,
): Table<BuiltColumns<TBuilders>, TName> {
	const columns: ColumnsMap = {};

	for (const [key, builder] of Object.entries(builders)) {
		const column = builder.build(key);
		column.tableName = name;
		columns[key] = column;
	}

	// D1 caps a table at 100 columns, so a wider one cannot be created and no
	// query against it can succeed. Thrown at declaration — module scope, once
	// per isolate — because there is no later point at which the answer changes,
	// and the alternative is a CREATE TABLE that fails inside a migration batch.
	const columnCount = Object.keys(columns).length;
	if (columnCount > MAX_COLUMNS_PER_TABLE) {
		throw new CompileError(
			`Table "${name}" declares ${columnCount} columns, which exceeds D1's limit of `
				+ `${MAX_COLUMNS_PER_TABLE} per table. Split it, or move the rarely-read columns into a `
				+ 'JSON column.',
		);
	}

	let extraList: TableExtra[] = [];
	if (extras) {
		const result = extras(columns as BuiltColumns<TBuilders>);
		if (Array.isArray(result)) extraList = result.filter(isTableExtra);
		else if (isTableExtra(result)) extraList = [result];
		else if (result) extraList = Object.values(result as Record<string, TableExtra>).filter(isTableExtra);
	}

	return buildTable(name, name, columns, extraList) as unknown as Table<BuiltColumns<TBuilders>, TName>;
}

/** Drizzle-compatible alias for {@link table}. */
export const sqliteTable = table;

export const isTable = (value: unknown): value is Table =>
	typeof value === 'object' && value !== null && (value as Table)[IsTable] === true;

export const getTableName = (t: Table): string => t[TableName];
export const getTableOriginalName = (t: Table): string => t[TableOriginalName];
export const getTableColumns = <T extends Table>(t: T): T[typeof TableColumns] => t[TableColumns];

/**
 * Columns of a *declared* table, which is always flat.
 *
 * `getTableColumns` has to admit nesting, because a subquery over grouped rows
 * exposes `sq.users.id`. Everywhere that is holding a table it declared — the
 * write compilers, chiefly — that case cannot arise, and saying so once beats
 * a cast at each use.
 */
export const getFlatColumns = (t: Table): Record<string, Column<any>> =>
	getTableColumns(t) as Record<string, Column<any>>;
export const getTableExtras = (t: Table): readonly TableExtra[] => t[TableExtras];

/**
 * The introspected shape of a table, matching Drizzle v1's
 * `getTableConfig` from `drizzle-orm/sqlite-core` field for field.
 *
 * Shipping our own is what makes the interop work rather than merely typecheck.
 * Drizzle's version derives every constraint by *running* a table's
 * `ExtraConfigBuilder`, which we set to `undefined` — so on an orm-d1 table it
 * returns the columns correctly and every other field empty. Pothos' drizzle
 * plugin resolves a model's primary key with
 * `columns.find(c => c.primary) ?? primaryKeys.find(…)?.columns ?? [columns.find(c => c.isUnique)]`,
 * so an empty `primaryKeys` means a composite-key table has no primary key at
 * all and the plugin throws. Ours reads our own `extras` instead.
 *
 * The user supplies `getTableConfig` to Pothos in its builder config, so this
 * being *a* correct implementation is enough — Drizzle's never has to work on
 * our tables.
 */
export interface TableConfig {
	readonly name: string;
	/** Always `undefined`: SQLite has no schemas. Present for shape parity. */
	readonly schema: undefined;
	readonly columns: readonly Column<any>[];
	readonly indexes: readonly TableIndex[];
	readonly foreignKeys: readonly TableForeignKey[];
	readonly checks: readonly TableCheck[];
	readonly primaryKeys: readonly TablePrimaryKey[];
	readonly uniqueConstraints: readonly TableUniqueConstraint[];
	/** Our own constraint records, unprocessed. Read by `orm-d1/ddl`. */
	readonly extras: readonly TableExtra[];
}

/**
 * Matches `drizzle-orm/sqlite-core`'s `Index` instance shape: everything but
 * `isNameExplicit` nests under `.config`. See `[F-052]` in `AUDIT.md`.
 */
export interface TableIndex {
	readonly config: {
		readonly name: string;
		readonly table: Table;
		readonly columns: readonly (Column<any> | SQLChunk)[];
		readonly unique: boolean;
		readonly where: SQLChunk | undefined;
	};
	readonly isNameExplicit: boolean;
}

/**
 * Matches `drizzle-orm/sqlite-core`'s `ForeignKey` instance shape: the column
 * lists and foreign table live behind `reference()`, a function, alongside a
 * `getName()`/`isNameExplicit()` pair — only `table`, `onUpdate` and
 * `onDelete` are plain properties. See `[F-052]` in `AUDIT.md`.
 */
export interface TableForeignKey {
	readonly table: Table;
	readonly reference: () => {
		readonly name: string | undefined;
		readonly columns: readonly Column<any>[];
		readonly foreignTable: Table | undefined;
		readonly foreignColumns: readonly Column<any>[];
	};
	readonly getName: () => string;
	readonly isNameExplicit: () => boolean;
	readonly onUpdate: ReferentialAction | undefined;
	readonly onDelete: ReferentialAction | undefined;
}

export interface TableCheck {
	readonly name: string;
	readonly table: Table;
	readonly value: SQLChunk;
}

/**
 * Matches `drizzle-orm/sqlite-core`'s `PrimaryKey` instance shape: `name` is
 * `undefined` unless the PK was given an explicit name — only `getName()`
 * derives `${table}_${cols}_pk` for the unnamed case. Verified against
 * `drizzle-orm/sqlite-core/primary-keys.ts`. See `[F-052]` in `AUDIT.md`.
 */
export interface TablePrimaryKey {
	readonly name: string | undefined;
	readonly table: Table;
	readonly columns: readonly Column<any>[];
	readonly isNameExplicit: boolean;
	readonly getName: () => string;
}

/**
 * Matches `drizzle-orm/sqlite-core`'s `UniqueConstraint` instance shape:
 * `name` is always set (falling back to `${table}_${cols}_unique` when no
 * name was given), alongside `isNameExplicit` and a `getName()` that just
 * returns `name`. Verified against
 * `drizzle-orm/sqlite-core/unique-constraint.ts`. See `[F-052]`.
 */
export interface TableUniqueConstraint {
	readonly name: string;
	readonly table: Table;
	readonly columns: readonly Column<any>[];
	readonly isNameExplicit: boolean;
	readonly getName: () => string;
}

/**
 * Introspect a table.
 *
 * Column-level `.primaryKey()` and `.unique()` stay on the column — as
 * `primary` and `isUnique` — exactly as Drizzle reports them; only the
 * *table-level* `primaryKey({ columns })` and `unique().on(…)` appear in
 * `primaryKeys` and `uniqueConstraints`. That ordering is what Pothos'
 * fallback chain is written against.
 *
 * `foreignKeys` includes the inline ones declared with `.references()`, which
 * Drizzle also folds in.
 */
/**
 * Wraps an already-derived foreign key name into Drizzle's `ForeignKey`
 * instance shape — `reference()` as a function, `getName()`/`isNameExplicit()`
 * as methods — instead of a flat record. See `[F-052]` in `AUDIT.md`. The
 * name itself is derived by the caller so it stays whatever `orm-d1/ddl`
 * actually emits for a *table-level* `foreignKey()` extra; only the *inline*
 * `.references()` case below derives Drizzle's fuller
 * `${table}_${cols}_${foreignTable}_${foreignCols}_fk` (`[F-015]`), because
 * inline references have no `name` option to be explicit about.
 */
const buildForeignKey = (
	t: Table,
	name: string,
	explicitName: string | undefined,
	columns: readonly Column<any>[],
	foreignTable: Table | undefined,
	foreignColumns: readonly Column<any>[],
	onUpdate: ReferentialAction | undefined,
	onDelete: ReferentialAction | undefined,
): TableForeignKey => ({
	table: t,
	reference: () => ({ name: explicitName, columns, foreignTable, foreignColumns }),
	getName: () => name,
	isNameExplicit: () => explicitName !== undefined,
	onUpdate,
	onDelete,
});

export const getTableConfig = (t: Table): TableConfig => {
	const columns = Object.values(getTableColumns(t)) as Column<any>[];
	const extras = getTableExtras(t);
	const name = getTableName(t);

	const indexes: TableIndex[] = [];
	const foreignKeys: TableForeignKey[] = [];
	const checks: TableCheck[] = [];
	const primaryKeys: TablePrimaryKey[] = [];
	const uniqueConstraints: TableUniqueConstraint[] = [];

	for (const column of columns) {
		const reference = column.config.references;
		if (!reference) continue;
		const target = reference.ref();
		const foreignTable = target.table as Table | undefined;
		// Drizzle's `ForeignKey.getName()`: `${table}_${cols}_${foreignTable}_${foreignCols}_fk`.
		// Inline `.references()` has no `name` option, so this is always derived. See `[F-015]`.
		const derivedName = [name, column.name, foreignTable ? getTableName(foreignTable) : '', target.name]
			.join('_') + '_fk';
		foreignKeys.push(
			buildForeignKey(
				t,
				derivedName,
				undefined,
				[column],
				foreignTable,
				[target],
				reference.onUpdate,
				reference.onDelete,
			),
		);
	}

	for (const extra of extras) {
		switch (extra.kind) {
			case 'index':
				indexes.push({
					config: {
						name: indexName(extra.meta, name),
						table: t,
						columns: extra.meta.columns,
						unique: extra.meta.unique,
						where: extra.meta.where,
					},
					isNameExplicit: extra.meta.name !== undefined,
				});
				break;
			case 'primaryKey': {
				// Real drizzle-orm's `PrimaryKey.name` is `undefined` when the PK
				// was not given an explicit name — only `.getName()` derives
				// `${table}_${cols}_pk`. drizzle-kit relies on that: it names an
				// unnamed PK `${table}_pk` (no columns at all), reached through
				// `pk.name ?? nameForPk(tableName)`, never through `.getName()`.
				// So `name` here must stay `undefined`, not the derived string —
				// getting this wrong here doesn't change real migration bytes
				// (this is only the `getTableConfig` shape, not orm-d1's own DDL
				// rendering), but it does change what a drizzle-kit-shaped
				// consumer computes from it. Verified against
				// `drizzle-orm/sqlite-core/primary-keys.ts`. See `[F-052]`.
				const derivedName = `${name}_${extra.meta.columns.map((c) => c.name).join('_')}_pk`;
				primaryKeys.push({
					name: extra.meta.name,
					table: t,
					columns: extra.meta.columns,
					isNameExplicit: extra.meta.name !== undefined,
					getName: () => extra.meta.name ?? derivedName,
				});
				break;
			}
			case 'unique': {
				const uName = uniqueConstraintName(extra.meta, name);
				uniqueConstraints.push({
					name: uName,
					table: t,
					columns: extra.meta.columns,
					isNameExplicit: extra.meta.name !== undefined,
					getName: () => uName,
				});
				break;
			}
			case 'foreignKey': {
				const fkForeignTable = extra.meta.foreignColumns[0]?.table as Table | undefined;
				// Drizzle's `ForeignKey.getName()` for a table-level `foreignKey()`
				// (`drizzle-orm/sqlite-core/foreign-keys.ts`): `name ?? \`${table}_${cols}_${foreignTable}_${foreignCols}_fk\``
				// — the same shape as the inline `.references()` case above
				// (`[F-015]`), but over every column in a (possibly multi-column)
				// composite key rather than just one. This is only the
				// `getTableConfig()` introspection surface; `foreignKeyName()`
				// (`src/schema/constraints.ts`), which DDL rendering and the
				// kit's snapshot diff both key on, is untouched — it derives
				// `${table}_${cols}_fk` deliberately, without the foreign side,
				// so two unnamed FKs to different tables over the same local
				// columns still collide there the same way Drizzle's own
				// `${table}_${cols}_fk`-shaped *index* names do; that is a
				// snapshot-identity concern orthogonal to what an adapter reading
				// `getTableConfig()` expects `getName()` to say.
				const drizzleName = extra.meta.name
					?? [
						name,
						...extra.meta.columns.map((c) => c.name),
						fkForeignTable ? getTableName(fkForeignTable) : '',
						...extra.meta.foreignColumns.map((c) => c.name),
					].join('_') + '_fk';
				foreignKeys.push(
					buildForeignKey(
						t,
						drizzleName,
						extra.meta.name,
						extra.meta.columns,
						fkForeignTable,
						extra.meta.foreignColumns,
						extra.meta.onUpdate,
						extra.meta.onDelete,
					),
				);
				break;
			}
			case 'check':
				checks.push({ name: extra.meta.name, table: t, value: extra.meta.value });
				break;
		}
	}

	return { name, schema: undefined, columns, indexes, foreignKeys, checks, primaryKeys, uniqueConstraints, extras };
};

/** Aliased reference to a table, for self-joins and disambiguation. */
export function alias<T extends Table, TName extends string>(
	t: T,
	aliasName: TName,
): T extends Table<infer C> ? Table<C, TName> : never {
	// Recursive because a subquery over grouped rows nests its columns, and a
	// subquery is a table everywhere except the `from` clause.
	const rebind = (map: ColumnsMap): ColumnsMap => {
		const out: ColumnsMap = {};
		for (const [key, entry] of Object.entries(map)) {
			out[key] = isColumn(entry) ? entry.withTable(aliasName) : rebind(entry as ColumnsMap);
		}
		return out;
	};
	const aliased = buildTable(
		aliasName,
		getTableOriginalName(t),
		rebind(getTableColumns(t)),
		getTableExtras(t),
		true,
	);
	// `alias()` on a subquery (from `.as()`/`createSubquery`) must keep the
	// inner statement — otherwise the aliased table looks exactly like an
	// ordinary table named after the subquery's own alias, and `from` renders
	// `"sq" "x"` (a table that does not exist) instead of inlining
	// `(select …) "x"`. Drizzle's own `alias()` is documented for tables and
	// views, not subqueries, but producing wrong SQL silently is worse than
	// this small extension of it. See [F-085].
	const source = getTableSource(t);
	if (source !== undefined) {
		Object.assign(aliased, {
			[TableSource]: source,
			[TableNullableGroups]: (t as unknown as Partial<Subquery>)[TableNullableGroups] ?? EMPTY_GROUPS,
		});
	}
	return aliased as any;
}

export const isAliased = (t: Table): boolean => t[TableName] !== t[TableOriginalName];

/**
 * A subquery behaves exactly like a table everywhere except the `from` clause,
 * so it is represented as one — with the inner statement hung off a symbol.
 */
export const TableSource = Symbol.for('ormD1:TableSource');

/**
 * Groups inside the subquery's rows that an outer join can leave null, as dotted
 * paths (`posts`, `a.b`) relative to the subquery's own row.
 *
 * Without this, a left join wrapped in `.as()` lost its one interesting
 * property: selecting back out of the subquery re-derived nullability from the
 * *outer* plan's joins, of which there are none, so a missed join came back as
 * an object full of nulls instead of the `null` the same query returns when read
 * directly.
 */
export const TableNullableGroups = Symbol.for('ormD1:TableNullableGroups');

export type Subquery<TColumns extends ColumnsMap = ColumnsMap, TName extends string = string> =
	& Table<TColumns, TName>
	& {
	readonly [TableSource]: SQLChunk;
	readonly [TableNullableGroups]: ReadonlySet<string>;
};

export const createSubquery = <TColumns extends ColumnsMap, TName extends string>(
	aliasName: TName,
	source: SQLChunk,
	columns: TColumns,
	nullableGroups: ReadonlySet<string> = new Set(),
): Subquery<TColumns, TName> => {
	const t = buildTable(aliasName, aliasName, columns, []);
	return Object.assign(t, {
		[TableSource]: source,
		[TableNullableGroups]: nullableGroups,
	}) as unknown as Subquery<TColumns, TName>;
};

export const getTableSource = (t: Table): SQLChunk | undefined =>
	(t as Partial<Subquery>)[TableSource];

const EMPTY_GROUPS: ReadonlySet<string> = new Set();

/** Empty for a declared table: only a subquery can carry a nullable group. */
export const getTableNullableGroups = (t: Table): ReadonlySet<string> =>
	(t as Partial<Subquery>)[TableNullableGroups] ?? EMPTY_GROUPS;
