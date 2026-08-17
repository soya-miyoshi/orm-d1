/**
 * Schema → DDL. A separate entry point: the core query builder never reaches
 * this module, so it costs the Worker bundle nothing (rule R5).
 *
 * `orm-d1-kit` generates migrations from exactly these strings, which is what
 * keeps "what the schema says" and "what the migration does" in one place.
 */
import type { Column } from './schema/columns.js';
import { isColumn } from './schema/columns.js';
import type { CheckMeta, ForeignKeyMeta, IndexMeta, PrimaryKeyConstraint, PrimaryKeyMeta, UniqueMeta } from './schema/constraints.js';
import { foreignKeyName, indexName, primaryKeyName, uniqueConstraintName } from './schema/constraints.js';

/** Re-exported: the derivation moved to `schema/constraints.ts`, which
 * `getTableConfig` also reads, so the two cannot report different names. */
export { foreignKeyName, indexName, primaryKeyName, uniqueConstraintName } from './schema/constraints.js';
import type { Table } from './schema/table.js';
import { getTableColumns, getTableExtras, getTableName } from './schema/table.js';
import type { RenderContext, SQLChunk } from './sql/sql.js';
import { defaultRenderContext, quoteIdentifier, render } from './sql/sql.js';

/**
 * Rendered in place of a bound value while building DDL. A literal `?` is
 * perfectly legal inside a check constraint or a partial-index predicate built
 * from `sql.raw(…)`, so parameter slots are marked with something that cannot
 * appear in SQL text instead of being recovered by counting `?`s afterwards.
 */
const PARAM_TOKEN = '\u0000orm-d1:param\u0000';

/** DDL cannot qualify column names with a table, and cannot bind parameters. */
const ddlContext: RenderContext = { ...defaultRenderContext, bareColumns: true, paramToken: PARAM_TOKEN };

export interface DDLOptions {
	/** `create table if not exists` — and, for `dropTable`, `if exists`. */
	readonly ifNotExists?: boolean;
	/** `drop table if exists`. Clearer than `ifNotExists` on a drop, which
	 * reads as the opposite of what it does; both are accepted. */
	readonly ifExists?: boolean;
	/** Emit `STRICT`; D1 supports it and it catches type mistakes early. */
	readonly strict?: boolean | undefined;
	/**
	 * Emit `WITHOUT ROWID`. Verified on D1. Requires a primary key, and pays off
	 * on tables whose primary key *is* the row identity — a junction table stores
	 * its key once instead of once in the table and again in an index.
	 */
	readonly withoutRowid?: boolean | undefined;
}

/**
 * Per-table physical-storage options, and the append-only guard.
 *
 * These live here rather than in the schema DSL on purpose. `STRICT`,
 * `WITHOUT ROWID` and triggers have no spelling in `drizzle-orm/sqlite-core`,
 * and docs/04 makes "every symbol a schema file uses also exists in Drizzle" a
 * standing constraint — it is what keeps an orm-d1 schema reverse-aliasable and
 * therefore what lets `orm-d1-kit studio` delegate to `drizzle-kit studio`.
 * Putting them on `table()` would break that for every user.
 *
 * So they are declared in a **sidecar module** the schema file never imports:
 *
 * ```ts
 * // src/db/table-options.ts
 * import { tableOptions } from 'orm-d1/ddl';
 * import { users, announcementReads } from './schema';
 *
 * export default tableOptions([
 *   [users,             { strict: true }],
 *   [announcementReads, { strict: true, withoutRowid: true, appendOnly: true }],
 * ]);
 * ```
 *
 * Keyed by the table *object*, not its name, so a rename is a compile error
 * rather than a silently dropped flag.
 */
export interface TableOptions {
	readonly strict?: boolean;
	readonly withoutRowid?: boolean;
	/**
	 * Reject `UPDATE` with a `BEFORE UPDATE … RAISE(ABORT)` trigger.
	 *
	 * `DELETE` stays allowed: what an append-only table protects is that a
	 * recorded fact is never rewritten, and dropping a tenant, expiring a
	 * retention window or tearing down a test database are all legitimate.
	 *
	 * `true` guards every column. A column list guards only those, leaving the
	 * rest writable — for the columns an outside system confirms after the row
	 * is written, and for free text a deletion request has to be able to clear.
	 * See `appendOnlyTrigger` for how `UPDATE OF` behaves.
	 *
	 * An empty array is rejected rather than read as "guard nothing": a flag
	 * that silently protects nothing is the one outcome worth failing over.
	 */
	readonly appendOnly?: boolean | readonly string[];
}

/** Marks the value a sidecar module default-exports, so the kit can find it. */
export const TableOptionsBrand = Symbol.for('ormD1:TableOptions');

export interface TableOptionsMap {
	readonly [TableOptionsBrand]: true;
	/** Keyed by SQL table name — what the snapshot and introspection both use. */
	readonly byTable: Readonly<Record<string, TableOptions>>;
}

export function tableOptions(entries: readonly (readonly [Table, TableOptions])[]): TableOptionsMap {
	const byTable: Record<string, TableOptions> = {};
	for (const [table, options] of entries) {
		const name = getTableName(table);
		if (byTable[name]) throw new Error(`tableOptions: "${name}" is declared twice.`);
		byTable[name] = options;
	}
	return { [TableOptionsBrand]: true, byTable };
}

export const isTableOptionsMap = (value: unknown): value is TableOptionsMap =>
	typeof value === 'object' && value !== null && TableOptionsBrand in (value as Record<symbol, unknown>);

/** The append-only guard's trigger name, derived so every emitter agrees. */
export const appendOnlyTriggerName = (tableName: string): string => `${tableName}_no_update`;

/**
 * The guarded column list, normalised: sorted and de-duplicated.
 *
 * `BEFORE UPDATE OF` treats its column list as a set — SQLite fires the trigger
 * when a listed column appears in the statement's `SET` clause, in any order.
 * Normalising here means reordering the array in a schema does not re-render
 * the trigger, so `diff` stays quiet and `introspect` can compare list to list
 * without caring how either side was spelled.
 */
export const normalizeAppendOnlyColumns = (columns: readonly string[]): string[] =>
	[...new Set(columns)].sort();

/**
 * The append-only setting as one comparable string, so a snapshot diff can ask
 * "did this change?" without deep-equalling an array.
 *
 * `''` off · `'*'` every column · otherwise the sorted column list.
 * `*` cannot collide with a column list because it is not a legal identifier
 * here — an unquoted `*` never reaches this from a schema.
 */
export const appendOnlyKey = (value: boolean | readonly string[] | undefined): string =>
	!value ? '' : value === true ? '*' : normalizeAppendOnlyColumns(value).join(',');

/** The list to hand `appendOnlyTrigger`, or `undefined` for a whole-table guard. */
export const appendOnlyColumns = (
	value: boolean | readonly string[] | undefined,
): string[] | undefined => (!value || value === true ? undefined : normalizeAppendOnlyColumns(value));

/**
 * `BEFORE UPDATE … RAISE(ABORT)`, optionally narrowed to a set of columns.
 *
 * With no column list the guard is unconditional: no `UPDATE` touches the table
 * at all. With one, SQLite fires only when a listed column appears in the
 * statement's `SET` clause — which lets a table keep its derived values frozen
 * while still accepting writes to the columns nothing derives from (a fee that
 * the payment processor confirms later, free text that a deletion request has
 * to be able to clear).
 *
 * Two properties of `UPDATE OF` are worth knowing before choosing a list:
 *
 *   - It fires on **mention, not on change**. `set amount = amount` aborts.
 *     Code that rewrites every column on every save cannot be used against a
 *     column-scoped table.
 *   - A statement that touches both a guarded and an unguarded column aborts
 *     whole. Nothing is partially applied.
 */
export const appendOnlyTrigger = (tableName: string, columns?: readonly string[]): string => {
	const of = columns && columns.length > 0
		? ` of ${normalizeAppendOnlyColumns(columns).map(quoteIdentifier).join(', ')}`
		: '';
	const what = of ? `these columns of ${tableName} are` : `${tableName} is`;
	return `create trigger ${quoteIdentifier(appendOnlyTriggerName(tableName))}\n`
		+ `before update${of} on ${quoteIdentifier(tableName)}\n`
		+ 'begin\n'
		+ `\tselect raise(abort, ${literal(`${what} append-only: UPDATE is prohibited`)});\n`
		+ 'end';
};

export const dropAppendOnlyTrigger = (tableName: string): string =>
	`drop trigger if exists ${quoteIdentifier(appendOnlyTriggerName(tableName))}`;

/**
 * SQLite's `STRICT` allow-list, verified against D1 rather than taken from the
 * docs: a `NUMERIC` column in a strict table is rejected outright with
 * `unknown datatype`. `numeric()` is the only orm-d1 column type that produces
 * one, so it is the only type this can catch.
 */
const STRICT_TYPES = new Set(['int', 'integer', 'real', 'text', 'blob', 'any']);

/**
 * Why a table cannot take the options it was given, or `undefined` if it can.
 *
 * Both rules were confirmed against a real D1 binding: `WITHOUT ROWID` without
 * a primary key fails with `PRIMARY KEY missing`, and `STRICT` with a `NUMERIC`
 * column fails with `unknown datatype`. Catching them when the migration is
 * *written* is the whole point — the alternative is a migration that passes
 * review and then fails halfway through applying to production.
 */
export function validateTableOptions(t: Table, options: TableOptions): string | undefined {
	const name = getTableName(t);
	const columns = Object.values(getTableColumns(t)) as Column<any>[];

	if (options.withoutRowid) {
		const hasComposite = getTableExtras(t).some((e) => e.kind === 'primaryKey');
		const hasColumnPk = columns.some((c) => c.config.primaryKey);
		if (!hasComposite && !hasColumnPk) {
			return `"${name}" is declared WITHOUT ROWID but has no primary key; SQLite rejects that outright.`;
		}

		// AUTOINCREMENT is defined in terms of the rowid, so a table without one
		// cannot have it: `AUTOINCREMENT not allowed on WITHOUT ROWID tables`.
		const auto = columns.find((c) => c.config.primaryKey && c.config.autoIncrement);
		if (auto) {
			return `"${name}" is declared WITHOUT ROWID but "${auto.name}" is AUTOINCREMENT; `
				+ 'AUTOINCREMENT numbers rowids, which a WITHOUT ROWID table does not have.';
		}
	}

	if (options.strict) {
		// Checked against the string that will actually be emitted — `typeName()`,
		// which for a `customType` column is its `declaredType`, not the reduced
		// affinity in `config.type`. A `customType(() => 'varchar(10)')` has
		// affinity `text`, which passes the affinity check, but the DDL says
		// `varchar(10)` and D1 rejects that under STRICT with `unknown datatype`.
		const bad = columns.filter((c) => !STRICT_TYPES.has(typeName(c).toLowerCase()));
		if (bad.length > 0) {
			return `"${name}" is declared STRICT but ${
				bad.map((c) => `"${c.name}" is ${typeName(c).toUpperCase()}`).join(', ')
			}; a STRICT table allows only INT, INTEGER, REAL, TEXT, BLOB and ANY.`;
		}
	}

	return undefined;
}

/**
 * Render a fragment with its parameters inlined — DDL cannot bind values.
 *
 * The literal replaces the token exactly, with no padding of its own. It used
 * to be surrounded by spaces, which meant `${c.active} = ${1}` rendered as
 * `"active" =  1 ` — the template's own space, then the added one, then a
 * trailing one. Introspection reads that predicate back from SQLite trimmed
 * and single-spaced, so a partial index or check built with an interpolated
 * value never compared equal to itself and `check` and `push` re-emitted it on
 * every run.
 */
export const renderInline = (chunk: SQLChunk | string): string => {
	if (typeof chunk === 'string') return chunk;
	const { sql, params } = render(chunk, ddlContext);
	let index = 0;
	return sql.replaceAll(PARAM_TOKEN, () => {
		const slot = params[index++];
		if (!slot || slot.k !== 'const') return 'null';
		return literal(slot.v);
	});
};

/** SQLite's blob literal, `x'deadbeef'` — the only spelling for raw bytes. */
const blobLiteral = (bytes: Uint8Array): string => {
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return `x'${hex}'`;
};

export const literal = (value: unknown): string => {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'bigint') return value.toString();
	// A blob has no string spelling to fall through to:
	// `String(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))` is `"222,173,190,239"`,
	// so `blob().default(bytes)` rendered a *text* literal into `create table`.
	// `snapshotFromSchema` calls this same function, so the snapshot recorded
	// the same wrong text, the database was built from the same wrong DDL, and
	// introspection read it back equal — self-consistent, permanently wrong,
	// and invisible to `check` and `verify`. That is bug class #1, and it is
	// why this branch exists rather than a cast at the call site.
	if (value instanceof ArrayBuffer) return blobLiteral(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) {
		// By byte range, not by element: a view may be a slice of a larger
		// buffer, and anything wider than `Uint8Array` would otherwise hex each
		// *element* rather than each byte.
		return blobLiteral(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	return `'${String(value).replaceAll("'", "''")}'`;
};

const typeName = (column: Column<any>): string => column.config.declaredType ?? column.config.type;

const referenceClause = (column: Column<any>): string => {
	const reference = column.config.references;
	if (!reference) return '';
	const target = reference.ref();
	let clause = ` references ${quoteIdentifier(target.tableName)}(${quoteIdentifier(target.name)})`;
	if (reference.onDelete) clause += ` on delete ${reference.onDelete}`;
	if (reference.onUpdate) clause += ` on update ${reference.onUpdate}`;
	return clause;
};

/**
 * The one spelling of a default that SQLite accepts everywhere.
 *
 * `CREATE TABLE` requires an expression default to be parenthesised —
 * `default (unixepoch())` — while `pragma table_info` reports it with the
 * parens stripped. Both spellings therefore circulate, and the bare one is
 * poison: it is a syntax error in `create table` and in `add column`, and
 * because "does it start with `(`" is also how the kit decides whether a
 * default is a constant, the bare form talks its way onto the `ADD COLUMN`
 * path that the check exists to keep it off. Normalising here — at the single
 * point where a `sql` default becomes text — makes every emission site and
 * that check right at once. Only a bare literal (and `CURRENT_*`, legal
 * unparenthesised) is left alone.
 */
export const defaultExpression = (value: string): string => {
	const text = value.trim();
	if (text.startsWith('(')) return text;
	if (/^current_(timestamp|date|time)$/i.test(text)) return text;
	if (/^(null|true|false)$/i.test(text)) return text;
	// A number, with the optional sign and exponent SQLite allows.
	if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return text;
	if (/^0x[0-9a-f]+$/i.test(text)) return text;
	// One whole string or blob literal — not `'a' || 'b'`, which is an expression.
	if (/^x?'(?:[^']|'')*'$/i.test(text)) return text;
	return `(${text})`;
};

const defaultClause = (column: Column<any>): string => {
	const value = column.config.default;
	if (!value) return '';
	if (value.kind === 'sql') return ` default ${defaultExpression(renderInline(value.value as SQLChunk))}`;
	return ` default ${literal(column.config.encode(value.value))}`;
};

/** One `column-def`, in SQLite's constraint order. */
export const columnDDL = (column: Column<any>, inlinePrimaryKey: boolean): string => {
	let ddl = `${quoteIdentifier(column.name)} ${typeName(column)}`;

	if (inlinePrimaryKey && column.config.primaryKey) {
		ddl += ' primary key';
		if (column.config.autoIncrement) ddl += ' autoincrement';
	}
	if (column.config.notNull) ddl += ' not null';
	if (column.config.unique) ddl += ' unique';
	if (column.config.generated) {
		ddl += ` generated always as (${renderInline(column.config.generated.as)}) ${column.config.generated.mode}`;
	}
	ddl += defaultClause(column);
	ddl += referenceClause(column);

	return ddl;
};

const constraintName = (name: string): string => `constraint ${quoteIdentifier(name)} `;

export const primaryKeyDDL = (meta: PrimaryKeyMeta, tableName: string): string =>
	`${constraintName(primaryKeyName(meta, tableName))}primary key (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;

export const uniqueDDL = (meta: UniqueMeta, tableName: string): string =>
	`${constraintName(uniqueConstraintName(meta, tableName))}unique (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;

export const foreignKeyDDL = (meta: ForeignKeyMeta, tableName: string): string => {
	const target = meta.foreignColumns[0];
	if (!target) throw new Error(`Foreign key on "${tableName}" has no target columns.`);
	let ddl = `${constraintName(foreignKeyName(meta, tableName))}foreign key (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	}) references ${quoteIdentifier(target.tableName)}(${
		meta.foreignColumns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;
	if (meta.onDelete) ddl += ` on delete ${meta.onDelete}`;
	if (meta.onUpdate) ddl += ` on update ${meta.onUpdate}`;
	return ddl;
};

export const checkDDL = (meta: CheckMeta): string =>
	`${constraintName(meta.name)}check (${renderInline(meta.value)})`;

export const createIndex = (meta: IndexMeta, tableName: string, options: DDLOptions = {}): string => {
	const columns = meta.columns.map((c) => (isColumn(c) ? quoteIdentifier(c.name) : renderInline(c))).join(', ');
	let ddl = `create ${meta.unique ? 'unique ' : ''}index ${options.ifNotExists ? 'if not exists ' : ''}${
		quoteIdentifier(indexName(meta, tableName))
	} on ${quoteIdentifier(tableName)} (${columns})`;
	if (meta.where) ddl += ` where ${renderInline(meta.where)}`;
	return ddl;
};

/** `CREATE TABLE` for one table, excluding its indexes. */
export function createTable(t: Table, options: DDLOptions = {}): string {
	const name = getTableName(t);
	const columns = Object.values(getTableColumns(t)) as Column<any>[];
	const extras = getTableExtras(t);
	const compositePk = extras.find((e): e is PrimaryKeyConstraint => e.kind === 'primaryKey');

	const parts: string[] = columns.map((column) => columnDDL(column, compositePk === undefined));

	if (compositePk) parts.push(primaryKeyDDL(compositePk.meta, name));
	for (const extra of extras) {
		if (extra.kind === 'unique') parts.push(uniqueDDL(extra.meta, name));
		if (extra.kind === 'foreignKey') parts.push(foreignKeyDDL(extra.meta, name));
		if (extra.kind === 'check') parts.push(checkDDL(extra.meta));
	}

	const body = parts.map((p) => `\t${p}`).join(',\n');
	// SQLite wants the two table-options comma-separated, and `STRICT` first is
	// the spelling `sqlite_master` reports back, so emitting them in this order
	// is what makes introspection compare equal to what we wrote.
	const suffix = [options.strict ? 'strict' : undefined, options.withoutRowid ? 'without rowid' : undefined]
		.filter((s) => s !== undefined);
	return `create table ${options.ifNotExists ? 'if not exists ' : ''}${quoteIdentifier(name)} (\n${body}\n)${
		suffix.length > 0 ? ` ${suffix.join(', ')}` : ''
	}`;
}

export const createIndexes = (t: Table, options: DDLOptions = {}): string[] =>
	getTableExtras(t)
		.filter((e) => e.kind === 'index')
		.map((builder) => createIndex(builder.meta, getTableName(t), options));

export const dropTable = (t: Table, options: DDLOptions = {}): string =>
	`drop table ${options.ifExists ?? options.ifNotExists ? 'if exists ' : ''}${
		quoteIdentifier(getTableName(t))
	}`;

/** Every statement needed to create a whole schema, tables before indexes. */
export function createSchema(
	tables: readonly Table[],
	options: DDLOptions = {},
	perTable?: TableOptionsMap,
): string[] {
	const optionsFor = (t: Table): DDLOptions => {
		const extra = perTable?.byTable[getTableName(t)];
		if (!extra) return options;
		return {
			...options,
			strict: extra.strict ?? options.strict,
			withoutRowid: extra.withoutRowid ?? options.withoutRowid,
		};
	};

	const statements = tables.map((t) => createTable(t, optionsFor(t)));
	for (const t of tables) statements.push(...createIndexes(t, options));
	// Triggers last: they reference the table, so it has to exist first.
	for (const t of tables) {
		const appendOnly = perTable?.byTable[getTableName(t)]?.appendOnly;
		if (!appendOnly) continue;
		const columns = appendOnly === true ? undefined : assertAppendOnlyColumns(t, appendOnly);
		statements.push(appendOnlyTrigger(getTableName(t), columns));
	}
	return statements;
}

/**
 * Reject a column list that names something the table does not have.
 *
 * **SQLite will not do this for us.** `create trigger … before update of
 * nosuchcol on t` is accepted without a word, and the resulting trigger simply
 * never fires — the table reads as guarded and is not. Verified against
 * sqlite3 directly; it is the same failure shape as docs/35 (a constraint that
 * is silently absent), so it is caught where the schema is declared instead.
 */
export function assertAppendOnlyColumns(t: Table, columns: readonly string[]): string[] {
	const name = getTableName(t);
	if (columns.length === 0) {
		throw new Error(
			`tableOptions: "${name}" declares appendOnly: [] — an empty column list guards nothing. `
			+ 'Use `true` to guard every column, or name the columns to guard.',
		);
	}
	const known = new Set(Object.values(getTableColumns(t)).map((c) => (c as Column).name));
	const unknown = normalizeAppendOnlyColumns(columns).filter((c) => !known.has(c));
	if (unknown.length > 0) {
		throw new Error(
			`tableOptions: "${name}" declares appendOnly columns that do not exist: ${unknown.join(', ')}. `
			+ `SQLite accepts \`before update of\` on unknown columns without error, and the trigger then `
			+ `never fires — the table would read as guarded while every UPDATE went through. `
			+ `Known columns: ${[...known].sort().join(', ')}.`,
		);
	}
	return normalizeAppendOnlyColumns(columns);
}
