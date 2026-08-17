/**
 * Structural compatibility with Drizzle's entity system.
 *
 * Drizzle's ecosystem (drizzle-graphql, the Zod/Valibot adapters, Studio, and
 * drizzle-kit itself) does not read a schema through a public API — it reads
 * well-known symbols and walks the `entityKind` chain of the constructor:
 *
 * ```js
 * // drizzle-orm/entity.js
 * let cls = Object.getPrototypeOf(value).constructor;
 * while (cls) { if (cls[entityKind] === type[entityKind]) return true; … }
 * ```
 *
 * So an orm-d1 table has to *be* an instance of a class whose static
 * `entityKind` chain matches Drizzle's, and carry Drizzle's symbols. Both are
 * a handful of empty classes and symbol assignments; the cost is a few dozen
 * bytes and it is what makes every existing adapter work unchanged.
 *
 * This is the one place where the "no class hierarchy deeper than 1" rule from
 * [03-architecture.md] is deliberately broken, and interop is the reason.
 */

export const entityKind = Symbol.for('drizzle:entityKind');
export const hasOwnEntityKind = Symbol.for('drizzle:hasOwnEntityKind');

// Table symbols, exactly as drizzle-orm/table.js declares them.
export const DrizzleTableName = Symbol.for('drizzle:Name');
export const DrizzleOriginalName = Symbol.for('drizzle:OriginalName');
export const DrizzleSchema = Symbol.for('drizzle:Schema');
export const DrizzleColumns = Symbol.for('drizzle:Columns');
export const DrizzleExtraConfigColumns = Symbol.for('drizzle:ExtraConfigColumns');
export const DrizzleBaseName = Symbol.for('drizzle:BaseName');
export const DrizzleIsAlias = Symbol.for('drizzle:IsAlias');
export const DrizzleExtraConfigBuilder = Symbol.for('drizzle:ExtraConfigBuilder');
export const DrizzleIsDrizzleTable = Symbol.for('drizzle:IsDrizzleTable');
export const DrizzleInlineForeignKeys = Symbol.for('drizzle:SQLiteInlineForeignKeys');

/** Root of the table chain: `is(t, Table)`. */
export class DrizzleTableEntity {
	static readonly [entityKind]: string = 'Table';
}

/** `is(t, SQLiteTable)` — what every SQLite-dialect adapter checks. */
export class SQLiteTableEntity extends DrizzleTableEntity {
	static override readonly [entityKind]: string = 'SQLiteTable';
}

/** Root of the column chain: `is(c, Column)`. */
export class DrizzleColumnEntity {
	static readonly [entityKind]: string = 'Column';
}

/** `is(c, SQLiteColumn)`. */
export class SQLiteColumnEntity extends DrizzleColumnEntity {
	static override readonly [entityKind]: string = 'SQLiteColumn';
}

/**
 * Drizzle's per-type column classes, keyed by `entityKind`. Adapters branch on
 * these — drizzle-graphql, for instance, does `is(column, SQLiteInteger)` to
 * decide whether a primary key is auto-generated.
 */
export type DrizzleColumnType =
	| 'SQLiteInteger'
	| 'SQLiteBoolean'
	| 'SQLiteTimestamp'
	| 'SQLiteText'
	| 'SQLiteTextJson'
	| 'SQLiteReal'
	| 'SQLiteNumeric'
	| 'SQLiteBlobBuffer'
	| 'SQLiteBlobJson'
	| 'SQLiteBigInt'
	| 'SQLiteCustomColumn';

/**
 * Drizzle's `dataType`, which adapters map onto their own type systems.
 *
 * Drizzle v1 spells this as a `"<type> <constraint>"` pair string rather than
 * a flat name — `'object date'`, `'string enum'`, `'number int53'` — so a v1
 * adapter (its Zod integration, in particular) can dispatch on the pair
 * without re-deriving it from `columnType`. These are the exact strings
 * `drizzle-orm/sqlite-core`'s column builders pass to `super()`.
 */
export type DrizzleDataType =
	| 'number int53'
	| 'number double'
	| 'number'
	| 'string'
	| 'string enum'
	| 'string numeric'
	| 'boolean'
	| 'object date'
	| 'object json'
	| 'object buffer'
	| 'bigint int64'
	| 'custom';

/**
 * No longer a remapping step — `DataTypeOf<CT>` (columns.ts) already computes
 * the v1 pair spelling at the type level, so this is just an identity guard.
 * Kept because `src/drizzle.ts` still names it.
 */
export type ToDrizzleDataType<T> = T extends DrizzleDataType ? T : 'string';

/** The subset of `ColumnConfig` `dataTypeOf` needs to disambiguate a pair string. */
export interface DataTypeInput {
	columnType: DrizzleColumnType;
	enumValues?: readonly string[] | undefined;
}

export const dataTypeOf = (config: DataTypeInput): DrizzleDataType => {
	switch (config.columnType) {
		case 'SQLiteInteger':
			return 'number int53';
		case 'SQLiteReal':
			return 'number double';
		case 'SQLiteBoolean':
			return 'boolean';
		case 'SQLiteTimestamp':
			return 'object date';
		case 'SQLiteText':
			return config.enumValues?.length ? 'string enum' : 'string';
		case 'SQLiteTextJson':
		case 'SQLiteBlobJson':
			return 'object json';
		case 'SQLiteBlobBuffer':
			return 'object buffer';
		case 'SQLiteNumeric':
			return 'string numeric';
		case 'SQLiteBigInt':
			return 'bigint int64';
		case 'SQLiteCustomColumn':
			return 'custom';
		default:
			return 'string';
	}
};
