import type { D1Param, Query, RenderContext, SQLChunk } from '../sql/sql.js';
import { Identifier, quoteIdentifier } from '../sql/sql.js';
import type { DrizzleColumnType, DrizzleDataType, ToDrizzleDataType } from './drizzle-entity.js';
import { dataTypeOf, entityKind, SQLiteColumnEntity } from './drizzle-entity.js';
// Self-import, not a cycle: this is how `Column.name` below calls `applyCasing`
// through the module's own live export binding rather than the local const
// directly. That indirection is what lets a test spy on `applyCasing`
// (`vi.spyOn(columnsModule, 'applyCasing')`) and actually observe calls made
// from inside this file — spying on an export cannot intercept a same-module
// caller that references the local binding, only one that goes through the
// exports object the same way an outside caller would.
import * as self from './columns.js';

/** SQLite's storage classes — the only column types D1 actually has. */
export type SQLiteType = 'integer' | 'text' | 'real' | 'blob' | 'numeric';

export type ReferentialAction =
	| 'cascade'
	| 'restrict'
	| 'no action'
	| 'set null'
	| 'set default';

export interface ColumnDefault {
	/** `sql` defaults are inlined into DDL; `value` defaults are literalised. */
	readonly kind: 'value' | 'sql';
	readonly value: unknown;
}

export interface ColumnReference {
	readonly ref: () => Column;
	readonly onDelete?: ReferentialAction | undefined;
	readonly onUpdate?: ReferentialAction | undefined;
}

export interface ColumnConfig {
	/** Explicit database name, when the user supplied one. */
	explicitName?: string | undefined;
	/** Property key on the table object; assigned by `table()`. */
	fieldName: string;
	type: SQLiteType;
	/** Drizzle's class name for this column; adapters branch on it. */
	columnType: DrizzleColumnType;
	/** Drizzle-compatible `mode`; selects the encoder/decoder pair. */
	mode?: string | undefined;
	notNull: boolean;
	primaryKey: boolean;
	autoIncrement: boolean;
	hasDefault: boolean;
	default?: ColumnDefault | undefined;
	defaultFn?: (() => unknown) | undefined;
	onUpdateFn?: (() => unknown) | undefined;
	unique: boolean;
	uniqueName?: string | undefined;
	length?: number | undefined;
	isLengthExact?: boolean | undefined;
	enumValues?: readonly string[] | undefined;
	/**
	 * The exact string a `customType`'s `dataType(config)` returned, preserved
	 * verbatim. `config.type` only ever holds one of the five SQLite storage
	 * classes — `getSQLType()`/`typeName()` fall back to that for every other
	 * column, but a custom column must emit what its author declared
	 * (`'varchar(10)'`, `'int'`, …), not a guess reduced from it.
	 */
	declaredType?: string | undefined;
	references?: ColumnReference | undefined;
	generated?: { readonly as: SQLChunk | string; readonly mode: 'stored' | 'virtual' } | undefined;
	/** Encoder used when binding this column's values. */
	encode: (value: unknown) => D1Param;
	/**
	 * Decoder for values coming back from D1. `undefined` means "already
	 * correct" — the mapper skips the call entirely, which is the common case.
	 */
	decode?: ((value: unknown) => unknown) | undefined;
}

/**
 * Identifier casing applied to columns that did not specify a database name.
 *
 * Set once by `orm-d1()` (or by the kit) and read lazily, so a schema module
 * can be imported before the option is known.
 */
let casingMode: 'preserve' | 'snake_case' = 'preserve';
/** Whether anyone has set it explicitly, as opposed to defaulting. */
let casingConfigured = false;
/** Set the first time a column name is resolved under the current setting. */
let casingObserved = false;
/**
 * Bumped by `resetCasing` (and never by ordinary `configureCasing` calls,
 * which only ever take effect before any name is read). `Column.name` below
 * caches its resolved name alongside the generation it was resolved under, so
 * a stale memo — one instance's cached name from before a test called
 * `resetCasing` — is recomputed instead of silently surviving the reset.
 * Without this, a memo hit never re-enters `applyCasing`, which is also the
 * only place that latches `casingObserved`, so `resetCasing` between tests
 * both left stale names in place and silently disarmed the "casing changed
 * after a name was read" guard.
 */
let casingGeneration = 0;

/**
 * Reconfiguring is refused rather than honoured, and so is configuring late.
 *
 * `Column.name` reads this lazily, and a Workers isolate outlives the request,
 * so a second `orm-d1(…, { casing })` with a different value would silently
 * rewrite the SQL of every table already built — including for the first
 * database.
 *
 * Setting it *after* a name has been read is the more dangerous case, because
 * it is what the documented module-scope compilation does by construction: a
 * query compiled at import time bakes `"firstName"` into its SQL, and the
 * `orm-d1(env.DB, { casing: 'snake_case' })` that runs on the first request
 * then makes every *later* reader say `first_name`. The compiled query keeps
 * the old text and D1 answers "no such column" — at runtime, in production,
 * for the one query that was optimised. Both cases throw here instead.
 */
export const configureCasing = (mode: 'preserve' | 'snake_case'): void => {
	if (casingConfigured && casingMode !== mode) {
		throw new Error(
			`Casing is already configured as "${casingMode}" and cannot be changed to "${mode}": `
				+ 'column names are resolved lazily and are shared across every database in this isolate.',
		);
	}
	if (!casingConfigured && casingObserved && mode !== casingMode) {
		throw new Error(
			`Casing was set to "${mode}" after column names had already been read. Names resolve lazily, `
				+ 'so anything compiled before this call — a query built at module scope, a createSchema() '
				+ 'call — kept the old spelling and would now query columns that do not exist. Pass `casing` '
				+ 'on the first ormD1() call in the module graph, before any query is compiled.',
		);
	}
	casingMode = mode;
	casingConfigured = true;
};

/** @internal Test-only escape hatch; never call this from application code. */
export const resetCasing = (): void => {
	casingMode = 'preserve';
	casingConfigured = false;
	casingObserved = false;
	casingGeneration++;
};

export const getCasing = (): 'preserve' | 'snake_case' => casingMode;

/**
 * Matches Drizzle's `toSnakeCase` (`drizzle-orm/casing.js`) exactly, rather
 * than a from-scratch regex pair: this is the one place where "the same
 * output as Drizzle" is the entire spec, since a schema ported from Drizzle
 * with `casing: 'snake_case'` has to resolve to identical column names or
 * every query against the existing database fails with "no such column".
 */
const toSnakeCase = (name: string): string =>
	(name.replace(/['’]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [])
		.map((w) => w.toLowerCase())
		.join('_');

export const applyCasing = (name: string): string => {
	// Latched here rather than in `Column.name`, so every path that resolves a
	// name — DDL, snapshots, compilation — counts as having observed it.
	casingObserved = true;
	return casingMode === 'snake_case' ? toSnakeCase(name) : name;
};

/**
 * The phantom metadata a column carries. One record, not five type parameters:
 * cheaper for the checker and extensible without touching every signature.
 */
export interface ColumnMeta {
	data: unknown;
	notNull: boolean;
	hasDefault: boolean;
	/** Drizzle-facing metadata, carried so adapters can infer from our tables. */
	dataType?: DrizzleDataType | undefined;
	columnType?: DrizzleColumnType | undefined;
	driverParam?: unknown;
	enumValues?: readonly string[] | undefined;
	/**
	 * `true` for `generatedAlwaysAs()`. Read only by `InferInsert`, which drops
	 * such columns: SQLite rejects any attempt to write one. Deliberately *not*
	 * forwarded to `DrizzleColumnShape.generated` — see the note there.
	 */
	generated?: boolean | undefined;
}

export class Column<M extends ColumnMeta = ColumnMeta> extends SQLiteColumnEntity implements SQLChunk<M['data']> {
	static override readonly [entityKind]: string = 'SQLiteColumn';

	/** Phantom — declared, never assigned. Costs zero runtime bytes. */
	declare readonly $: M;
	declare readonly $type?: M['data'];
	/** Phantom, shaped like Drizzle's `Column['_']` so adapters can infer. */
	declare readonly _: DrizzleColumnShape<M>;

	/** Set by `table()` once the column is attached to its table. */
	tableName = '';
	/** The table object itself — Drizzle adapters read `column.table`. */
	table: unknown = undefined;

	constructor(readonly config: ColumnConfig) {
		super();
	}

	// ---- the surface Drizzle adapters read -------------------------------

	get dataType(): DrizzleDataType {
		return dataTypeOf(this.config);
	}

	get columnType(): DrizzleColumnType {
		return this.config.columnType;
	}

	get hasDefault(): boolean {
		return this.config.hasDefault;
	}

	get isUnique(): boolean {
		return this.config.unique;
	}

	get uniqueName(): string | undefined {
		return this.config.uniqueName;
	}

	get enumValues(): readonly string[] | undefined {
		return this.config.enumValues;
	}

	get default(): unknown {
		return this.config.default?.value;
	}

	get defaultFn(): (() => unknown) | undefined {
		return this.config.defaultFn;
	}

	get onUpdateFn(): (() => unknown) | undefined {
		return this.config.onUpdateFn;
	}

	get generated(): { as: SQLChunk | string; mode: 'stored' | 'virtual' } | undefined {
		return this.config.generated;
	}

	get keyAsName(): boolean {
		return this.config.explicitName === undefined;
	}

	getSQLType(): string {
		// Drizzle-faithful, including the length: `drizzle-orm/sqlite-core`'s
		// `SQLiteText.getSQLType()` returns `text${length ? `(${length})` : ''}`
		// (truthy check — `length: 0` is treated as "no length"), and its
		// `SQLiteTextJson.getSQLType()` (`mode: 'json'`) always returns bare
		// `text`, dropping length entirely. `[F-012]` once tried making DDL
		// rendering itself emit this decorated string and reverted it — real
		// SQLite's STRICT mode rejects any decorated type name (`TEXT(5)`
		// fails with `unknown datatype`), so `src/ddl.ts`'s `typeName()` and
		// `kit/src/core/snapshot.ts`'s DDL rendering read
		// `declaredType ?? type` directly and never call this method — this
		// method itself is free to be Drizzle-faithful. See `[F-012]` in
		// `AUDIT.md`.
		const base = this.config.declaredType ?? this.config.type;
		if (base === 'text' && this.config.mode !== 'json' && this.config.length) {
			return `text(${this.config.length})`;
		}
		return base;
	}

	/** Drizzle's `Column['length']` — set for `text(name, { length })`. */
	get length(): number | undefined {
		return this.config.length;
	}

	/** Drizzle's `Column['isLengthExact']`. */
	get isLengthExact(): boolean | undefined {
		return this.config.isLengthExact;
	}

	mapFromDriverValue(value: unknown): unknown {
		return value === null || value === undefined ? value : this.config.decode?.(value) ?? value;
	}

	mapToDriverValue(value: unknown): unknown {
		return value === null || value === undefined ? value : this.config.encode(value);
	}

	/** Drizzle's `SQLWrapper`. */
	getSQL(): SQLChunk {
		return this;
	}

	/**
	 * Memoized: `applyCasing` runs Drizzle's tokenising regex, and `.name` is
	 * read repeatedly per column over the lifetime of a query (DDL rendering,
	 * snapshotting, compilation each read it at least once) — recomputing it
	 * every time multiplied the regex cost by however many callers touch a
	 * column. `#resolvedName` is per-instance, and `withTable` (below) builds a
	 * fresh `Column` from the same `config` for an alias, so an alias still
	 * resolves its own name once, independently, with nothing stale carried
	 * over from the table it was aliased from.
	 *
	 * Versioned by `casingGeneration` rather than a plain nullable cache: the
	 * memo would otherwise outlive `resetCasing`, the test-only escape hatch
	 * that flips `casingMode` back for the next test without constructing new
	 * `Column` instances — `test/schema.ts` builds its tables once at module
	 * scope, so the first test to read one of its columns across a
	 * `resetCasing` boundary would get the *previous* test's cached name. A
	 * stale generation recomputes, which also re-enters `applyCasing` and so
	 * re-latches `casingObserved`.
	 */
	#resolvedName: string | undefined;
	#resolvedNameGeneration = -1;

	/** The database column name, resolved against the configured casing. */
	get name(): string {
		if (this.#resolvedName === undefined || this.#resolvedNameGeneration !== casingGeneration) {
			this.#resolvedNameGeneration = casingGeneration;
			return this.#resolvedName = this.config.explicitName ?? self.applyCasing(this.config.fieldName);
		}
		return this.#resolvedName;
	}

	get notNull(): boolean {
		return this.config.notNull;
	}

	get primary(): boolean {
		return this.config.primaryKey;
	}

	toQuery(ctx?: RenderContext): Query {
		const column = quoteIdentifier(this.name);
		if (!this.tableName || ctx?.bareColumns) return { sql: column, params: [] };
		return { sql: `${quoteIdentifier(this.tableName)}.${column}`, params: [] };
	}

	/** @internal Clone for table aliasing. */
	withTable(tableName: string): Column<M> {
		const next = new (this.constructor as new (config: ColumnConfig) => Column<M>)(this.config);
		next.tableName = tableName;
		return next;
	}
}

export const isColumn = (value: unknown): value is Column => value instanceof Column;

/** Mirrors Drizzle's `Column['_']`, so its inference helpers accept ours. */
export interface DrizzleColumnShape<M extends ColumnMeta> {
	readonly brand: 'Column';
	readonly tableName: string;
	readonly name: string;
	readonly dataType: ToDrizzleDataType<M['dataType']>;
	readonly columnType: M['columnType'] extends DrizzleColumnType ? M['columnType'] : DrizzleColumnType;
	readonly data: M['data'];
	readonly driverParam: M['driverParam'];
	readonly notNull: M['notNull'];
	readonly hasDefault: M['hasDefault'];
	readonly isPrimaryKey: boolean;
	readonly isAutoincrement: boolean;
	readonly hasRuntimeDefault: boolean;
	readonly enumValues: M['enumValues'];
	readonly baseColumn: never;
	/**
	 * Always `undefined`, never `M['generated']`. Drizzle's `OptionalKeyOnly`
	 * treats a column with `generated` set as non-optional, which would drop
	 * every defaultable column from the insert models its adapters infer.
	 */
	readonly generated: undefined;
	readonly identity: undefined;
	readonly dialect: 'sqlite';
}

/**
 * One subclass per Drizzle column type, created lazily and cached. Adapters
 * that ask `is(column, SQLiteInteger)` walk this constructor's `entityKind`.
 */
const columnClasses = new Map<DrizzleColumnType, new (config: ColumnConfig) => Column<any>>();

export const columnClassFor = (columnType: DrizzleColumnType): new (config: ColumnConfig) => Column<any> => {
	let cls = columnClasses.get(columnType);
	if (!cls) {
		cls = class extends Column<any> {
			static override readonly [entityKind]: string = columnType;
		};
		columnClasses.set(columnType, cls);
	}
	return cls;
};

/** Builder returned by the column constructors; narrows the phantom record. */
export class ColumnBuilder<M extends ColumnMeta = ColumnMeta> {
	constructor(readonly config: ColumnConfig) {}

	private with(patch: Partial<ColumnConfig>): any {
		return new ColumnBuilder({ ...this.config, ...patch });
	}

	notNull(): ColumnBuilder<M & { notNull: true }> {
		return this.with({ notNull: true });
	}

	// Only integer builders are SQLite's rowid alias and thus defaultable —
	// matches Drizzle's `ColumnBuilder.primaryKey()`, which gates `HasDefault`
	// on `TExtraConfig['primaryKeyHasDefault']` (set only by its integer
	// builder). The runtime `hasDefault` value below already accounts for
	// customType columns whose declared type isn't the literal `integer`
	// spelling — this only narrows the *type*.
	primaryKey(
		options?: { autoIncrement?: boolean },
	): ColumnBuilder<M & { notNull: true } & (M['columnType'] extends 'SQLiteInteger' | 'SQLiteTimestamp' | 'SQLiteBoolean' ? { hasDefault: true } : unknown)> {
		return this.with({
			primaryKey: true,
			notNull: true,
			autoIncrement: options?.autoIncrement ?? false,
			// An INTEGER PRIMARY KEY is SQLite's rowid alias: always defaultable.
			// Checked against the type that will actually be *emitted* — a
			// `customType` column's `declaredType` (`'int'`, `'bigint'`, …) — not
			// `config.type`, which is only a reduced affinity. `config.type` is
			// `'integer'` for those too, but the DDL says `int` or `bigint`, not
			// the literal `INTEGER PRIMARY KEY` spelling SQLite requires for the
			// rowid alias, so they are not actually optional on insert.
			hasDefault: (this.config.declaredType ?? this.config.type) === 'integer',
		});
	}

	unique(name?: string): ColumnBuilder<M> {
		return this.with({ unique: true, uniqueName: name });
	}

	default(value: M['data'] | SQLChunk): ColumnBuilder<M & { hasDefault: true }> {
		const isSql = typeof value === 'object' && value !== null
			&& typeof (value as SQLChunk).toQuery === 'function';
		return this.with({
			hasDefault: true,
			default: { kind: isSql ? 'sql' : 'value', value },
		});
	}

	/** Runtime default, evaluated per insert rather than baked into the DDL. */
	$defaultFn(fn: () => M['data']): ColumnBuilder<M & { hasDefault: true }> {
		return this.with({ hasDefault: true, defaultFn: fn });
	}

	$default(fn: () => M['data']): ColumnBuilder<M & { hasDefault: true }> {
		return this.$defaultFn(fn);
	}

	/** Value written on every `update()` that touches this table. */
	$onUpdate(fn: () => M['data']): ColumnBuilder<M & { hasDefault: true }> {
		return this.with({ hasDefault: true, onUpdateFn: fn });
	}

	$onUpdateFn(fn: () => M['data']): ColumnBuilder<M & { hasDefault: true }> {
		return this.$onUpdate(fn);
	}

	/** Escape hatch for branded ids and JSON payloads. */
	$type<T>(): ColumnBuilder<Omit<M, 'data'> & { data: T }> {
		return this as any;
	}

	references(
		ref: () => Column,
		actions?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
	): ColumnBuilder<M> {
		return this.with({
			references: { ref, onDelete: actions?.onDelete, onUpdate: actions?.onUpdate },
		});
	}

	generatedAlwaysAs(
		expression: SQLChunk | string,
		options?: { mode?: 'stored' | 'virtual' },
	): ColumnBuilder<M & { hasDefault: true; generated: true }> {
		return this.with({
			hasDefault: true,
			generated: { as: expression, mode: options?.mode ?? 'virtual' },
		});
	}

	/** @internal */
	build(fieldName: string): Column<M> {
		const Cls = columnClassFor(this.config.columnType);
		return new Cls({ ...this.config, fieldName }) as Column<M>;
	}
}

const base = (
	type: SQLiteType,
	columnType: DrizzleColumnType,
	name: string | undefined,
	patch: Partial<ColumnConfig> = {},
): ColumnConfig => ({
	explicitName: name,
	fieldName: '',
	type,
	columnType,
	notNull: false,
	primaryKey: false,
	autoIncrement: false,
	hasDefault: false,
	unique: false,
	encode: (value) => value as D1Param,
	...patch,
});

/** Strips `readonly` off every property — Drizzle's own `Writable<T>`. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Exact type equality, not mutual assignability — needed because `X extends Y`
 * is true for supertypes too. Copied from `drizzle-orm`'s internal `Equal`.
 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 0) extends (<T>() => T extends Y ? 1 : 0) ? true : false;

/**
 * Drizzle's `dataType`, derived from its column class name — the v1
 * `"<type> <constraint>"` pair spelling, matching `dataTypeOf` at runtime
 * exactly (see `drizzle-entity.ts`). `TEnum` distinguishes `SQLiteText`'s two
 * shapes: `columnType` alone can't tell plain text from an enum.
 */
type DataTypeOf<CT extends DrizzleColumnType, TEnum extends readonly string[] | undefined = undefined> = CT extends
	'SQLiteInteger' ? 'number int53'
	: CT extends 'SQLiteReal' ? 'number double'
	: CT extends 'SQLiteBoolean' ? 'boolean'
	: CT extends 'SQLiteTimestamp' ? 'object date'
	// `Equal`, not `extends`: `text()` below constrains its enum generic to a
	// tuple (`Readonly<[U, ...U[]]>`), so when no `enum` option is given at all
	// the parameter is left uninferred and TypeScript falls back to that
	// constraint itself — i.e. `TEnum` is *already* the tuple
	// `readonly [string, ...string[]]`, which would satisfy a plain `extends`
	// check and misreport "no enum" as an enum. Exact equality against that
	// specific fallback tuple is the only thing that tells the two apart,
	// matching `drizzle-orm/sqlite-core`'s own `Equal<TEnum, [string, ...string[]]>`.
	: CT extends 'SQLiteText' ? (Equal<TEnum, [string, ...string[]]> extends true ? 'string' : 'string enum')
	: CT extends 'SQLiteTextJson' | 'SQLiteBlobJson' ? 'object json'
	: CT extends 'SQLiteBlobBuffer' ? 'object buffer'
	: CT extends 'SQLiteNumeric' ? 'string numeric'
	: CT extends 'SQLiteBigInt' ? 'bigint int64'
	: CT extends 'SQLiteCustomColumn' ? 'custom'
	: 'string';

/**
 * The starting metadata for a fresh column.
 *
 * `notNull` and `hasDefault` start as `boolean`, not `false`, because the
 * builder narrows by intersection: `boolean & true` is `true`, whereas
 * `false & true` would be `never` and silently break every downstream check.
 */
type Meta<T, CT extends DrizzleColumnType, TDriver = unknown, TEnum extends readonly string[] | undefined = undefined> = {
	data: T;
	notNull: boolean;
	hasDefault: boolean;
	dataType: DataTypeOf<CT, TEnum>;
	columnType: CT;
	driverParam: TDriver;
	enumValues: TEnum;
};

/** `name?` may be omitted entirely, Drizzle-style: `integer({ mode: 'boolean' })`. */
const splitArgs = <C>(a: string | C | undefined, b: C | undefined): [string | undefined, C | undefined] =>
	typeof a === 'string' ? [a, b] : a === undefined ? [undefined, b] : [undefined, a];

// ---------------------------------------------------------------- integer

export interface IntegerConfig<TMode extends string> {
	mode?: TMode;
}

type IntegerData<TMode> = TMode extends 'boolean' ? boolean
	: TMode extends 'timestamp' | 'timestamp_ms' ? Date
	: number;

type IntegerColumnType<TMode> = TMode extends 'boolean' ? 'SQLiteBoolean'
	: TMode extends 'timestamp' | 'timestamp_ms' ? 'SQLiteTimestamp'
	: 'SQLiteInteger';

const toDate = (value: unknown, scale: number): Date => new Date(Number(value) * scale);

export function integer<TMode extends 'number' | 'boolean' | 'timestamp' | 'timestamp_ms' = 'number'>(
	name?: string | IntegerConfig<TMode>,
	config?: IntegerConfig<TMode>,
): ColumnBuilder<Meta<IntegerData<TMode>, IntegerColumnType<TMode>, number>> {
	const [columnName, options] = splitArgs(name, config);
	const mode = options?.mode ?? 'number';

	let patch: Partial<ColumnConfig>;
	switch (mode) {
		case 'boolean':
			patch = { encode: (v) => (v ? 1 : 0), decode: (v) => Boolean(v) };
			break;
		case 'timestamp':
			patch = {
				encode: (v) => Math.floor((v as Date).getTime() / 1000),
				decode: (v) => toDate(v, 1000),
			};
			break;
		case 'timestamp_ms':
			patch = { encode: (v) => (v as Date).getTime(), decode: (v) => toDate(v, 1) };
			break;
		default:
			patch = {};
	}

	const columnType: DrizzleColumnType = mode === 'boolean'
		? 'SQLiteBoolean'
		: mode === 'timestamp' || mode === 'timestamp_ms'
		? 'SQLiteTimestamp'
		: 'SQLiteInteger';

	return new ColumnBuilder(base('integer', columnType, columnName, { mode, ...patch }));
}

// ------------------------------------------------------------------- text

export interface TextConfig<TEnum extends readonly string[], TMode extends 'text' | 'json' = 'text' | 'json'> {
	length?: number;
	enum?: TEnum | Writable<TEnum>;
	mode?: TMode;
}

/**
 * The return type branches on `mode`, as Drizzle's does.
 *
 * It used to be fixed at `SQLiteText` with `string` data whatever the mode,
 * while the *runtime* built a `SQLiteTextJson` with a JSON encoder/decoder
 * pair. So `text(name, { mode: 'json' })` returned parsed objects and claimed
 * to return strings, and `.$type<T>()` had nothing to narrow — which is what
 * the `json<T>()` helper was invented to work around. That helper does not
 * exist in `drizzle-orm/sqlite-core`, so reaching for it took a schema file
 * out of the Drizzle subset (docs/04) and broke reverse-aliasing.
 *
 * `[TMode] extends ['json']` rather than the naked `TMode extends 'json'`: a
 * naked type parameter distributes over unions, and the default is the union
 * `'text' | 'json'`, so the bare form returned *both* branches for a column
 * declared with no mode at all.
 *
 * `<U extends string, T extends Readonly<[U, ...U[]]>>` — a tuple-constrained
 * generic on `enum`, not a plain `TEnum extends readonly string[]` — is
 * `drizzle-orm/sqlite-core`'s exact signature, copied verbatim. The point of
 * the tuple constraint is contextual typing: because the *declared* type of
 * `enum` is a tuple pattern, `enum: ['admin', 'member']` infers as the tuple
 * `['admin', 'member']` on its own, without needing `as const`. A looser
 * `TEnum extends readonly string[]` widens the same literal to `string[]`
 * and loses the enum at the type level (though not at runtime), which is
 * what made `text('role', { enum: [...] })` need `as const` to type-check as
 * an enum while already behaving like one when read back.
 */
export function text<
	U extends string,
	T extends Readonly<[U, ...U[]]>,
	TMode extends 'text' | 'json' = 'text' | 'json',
>(
	name?: string | TextConfig<T, TMode>,
	config?: TextConfig<T, TMode>,
): [TMode] extends ['json'] ? ColumnBuilder<Meta<unknown, 'SQLiteTextJson', string>>
	: ColumnBuilder<Meta<Writable<T>[number], 'SQLiteText', string, Writable<T>>>
{
	const [columnName, options] = splitArgs(name, config);
	const json = options?.mode === 'json';

	// The cast is the usual cost of a conditional return type: the body cannot
	// prove which branch it is in, only the caller can.
	return new ColumnBuilder(base('text', json ? 'SQLiteTextJson' : 'SQLiteText', columnName, {
		mode: options?.mode ?? 'text',
		length: options?.length,
		enumValues: options?.enum,
		...(json
			? { encode: (v) => JSON.stringify(v), decode: (v) => JSON.parse(String(v)) as unknown }
			: {}),
	})) as never;
}

// ------------------------------------------------------------------- real

export function real(name?: string): ColumnBuilder<Meta<number, 'SQLiteReal', number>> {
	return new ColumnBuilder(base('real', 'SQLiteReal', name));
}

// ---------------------------------------------------------------- numeric

export function numeric(name?: string): ColumnBuilder<Meta<string, 'SQLiteNumeric', string>> {
	return new ColumnBuilder(base('numeric', 'SQLiteNumeric', name, { decode: (v) => String(v) }));
}

// ------------------------------------------------------------------- blob

/**
 * D1 hands a blob back as a plain array of byte values, not a typed array —
 * so every conversion here has to accept `number[]` before its fallback. It is
 * the read shape, and missing it is silent: `String([0, 170, 187])` is
 * `"0,170,187"`, which re-encodes to eleven bytes of ASCII rather than three
 * bytes of data, and the value stops equalling the one that was written.
 */
const asBytes = (value: unknown): Uint8Array | undefined => {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	return undefined;
};

const bytesToString = (value: unknown): string => {
	if (typeof value === 'string') return value;
	const bytes = asBytes(value);
	return bytes ? new TextDecoder().decode(bytes) : String(value);
};

const toBytes = (value: unknown): Uint8Array => asBytes(value) ?? new TextEncoder().encode(String(value));

export interface BlobConfig<TMode extends string = 'buffer' | 'json' | 'bigint'> {
	mode?: TMode;
}

type BlobData<TMode> = TMode extends 'json' ? unknown : TMode extends 'bigint' ? bigint : Uint8Array;

type BlobColumnType<TMode> = TMode extends 'json' ? 'SQLiteBlobJson'
	: TMode extends 'bigint' ? 'SQLiteBigInt'
	: 'SQLiteBlobBuffer';

export function blob<TMode extends 'buffer' | 'json' | 'bigint' = 'json'>(
	name?: string | BlobConfig<TMode>,
	config?: BlobConfig<TMode>,
): ColumnBuilder<Meta<BlobData<TMode>, BlobColumnType<TMode>, Uint8Array>> {
	const [columnName, options] = splitArgs(name, config);
	const mode = options?.mode ?? 'json';

	let patch: Partial<ColumnConfig>;
	switch (mode) {
		case 'json':
			patch = {
				encode: (v) => JSON.stringify(v),
				decode: (v) => JSON.parse(bytesToString(v)) as unknown,
			};
			break;
		case 'bigint':
			patch = { encode: (v) => String(v), decode: (v) => BigInt(bytesToString(v)) };
			break;
		default:
			patch = { encode: (v) => v as D1Param, decode: (v) => toBytes(v) };
	}

	const columnType: DrizzleColumnType = mode === 'json'
		? 'SQLiteBlobJson'
		: mode === 'bigint'
		? 'SQLiteBigInt'
		: 'SQLiteBlobBuffer';

	return new ColumnBuilder(base('blob', columnType, columnName, { mode, ...patch }));
}

/**
 * An `integer` column carrying a boolean. Equivalent to
 * `integer({ mode: 'boolean' })`, which is the Drizzle-compatible spelling.
 */
export function boolean(name?: string): ColumnBuilder<Meta<boolean, 'SQLiteBoolean', number>> {
	return integer(name, { mode: 'boolean' }) as ColumnBuilder<Meta<boolean, 'SQLiteBoolean', number>>;
}

/**
 * A `text` column carrying JSON. Equivalent to `text({ mode: 'json' })`.
 *
 * @deprecated **Not in `drizzle-orm/sqlite-core`.** Using it in a schema file
 * takes that file out of the Drizzle subset docs/04 requires, which breaks
 * reverse-aliasing and with it the `studio` delegation path. It existed
 * because `text(name, { mode: 'json' })` used to type its data as `string`
 * whatever the mode; that is fixed, so the portable spelling now carries the
 * type just as well:
 *
 * ```ts
 * locationData: text('location_data', { mode: 'json' }).$type<Location>()
 * ```
 *
 * Kept for the query side and for existing callers; do not reach for it in a
 * schema module.
 */
export function json<T = unknown>(name?: string): ColumnBuilder<Meta<T, 'SQLiteTextJson', string>> {
	return text(name, { mode: 'json' }) as unknown as ColumnBuilder<Meta<T, 'SQLiteTextJson', string>>;
}

// ------------------------------------------------------------ customType

export interface CustomTypeParams<TData, TDriver, TConfig = unknown> {
	dataType: (config?: TConfig) => SQLiteType | string;
	toDriver?: (value: TData) => TDriver;
	fromDriver?: (value: TDriver) => TData;
}

/**
 * Drizzle's `customType`, mapped onto our encoder/decoder pair.
 *
 * `dataType(config)` is called per column, with the config from *that* column's
 * call site — `varchar('name', { length: 10 })` — and not once when the type is
 * declared. Calling it eagerly with no argument meant a `dataType` that read
 * `config.length` threw at module scope, on import, before any query existed.
 */
/**
 * SQLite's REAL affinity rules, applied to a *declared* type string to get one
 * of the five storage classes/affinities the runtime actually needs to bind
 * or decode a value by. Order matters — `INT` is checked before `CHAR`, so
 * `POINT` is `integer` — and is duplicated verbatim from
 * `kit/src/core/snapshot.ts`'s `typeAffinity()` rather than shared: `src/`
 * cannot import from `kit/`.
 */
const affinityOf = (declared: string): SQLiteType => {
	const type = declared.toUpperCase();
	if (type.includes('INT')) return 'integer';
	if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'text';
	if (type.includes('BLOB') || type.trim() === '') return 'blob';
	if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'real';
	return 'numeric';
};

export function customType<TData, TDriver = unknown, TConfig = unknown>(
	params: CustomTypeParams<TData, TDriver, TConfig>,
): (name?: string, config?: TConfig) => ColumnBuilder<Meta<TData, 'SQLiteCustomColumn', TDriver>> {
	return (name?: string, config?: TConfig) => {
		const declared = String(params.dataType(config));

		return new ColumnBuilder(base(affinityOf(declared), 'SQLiteCustomColumn', name, {
			declaredType: declared,
			encode: params.toDriver ? (v) => params.toDriver!(v as TData) as D1Param : (v) => v as D1Param,
			decode: params.fromDriver ? (v) => params.fromDriver!(v as TDriver) : undefined,
		}));
	};
}

export { Identifier };
