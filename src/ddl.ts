/**
 * Schema → DDL. A separate entry point: the core query builder never reaches
 * this module, so it costs the Worker bundle nothing (rule R5).
 *
 * `d1zzle-migrate` generates migrations from exactly these strings, which is what
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
const PARAM_TOKEN = '\u0000d1zzle:param\u0000';

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
 * and doc 08 makes "every symbol a schema file uses also exists in Drizzle" a
 * standing constraint — it is what keeps a d1zzle schema reverse-aliasable and
 * therefore what lets `d1zzle-migrate studio` delegate to `drizzle-kit studio`.
 * Putting them on `table()` would break that for every user.
 *
 * So they are declared in a **sidecar module** the schema file never imports:
 *
 * ```ts
 * // src/db/table-options.ts
 * import { tableOptions } from 'd1zzle/ddl';
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
	 */
	readonly appendOnly?: boolean;
}

/** Marks the value a sidecar module default-exports, so the kit can find it. */
export const TableOptionsBrand = Symbol.for('d1zzle:TableOptions');

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

export const appendOnlyTrigger = (tableName: string): string =>
	`create trigger ${quoteIdentifier(appendOnlyTriggerName(tableName))}\n`
	+ `before update on ${quoteIdentifier(tableName)}\n`
	+ 'begin\n'
	+ `\tselect raise(abort, ${literal(`${tableName} is append-only: UPDATE is prohibited`)});\n`
	+ 'end';

export const dropAppendOnlyTrigger = (tableName: string): string =>
	`drop trigger if exists ${quoteIdentifier(appendOnlyTriggerName(tableName))}`;

/**
 * SQLite's `STRICT` allow-list, verified against D1 rather than taken from the
 * docs: a `NUMERIC` column in a strict table is rejected outright with
 * `unknown datatype`. `numeric()` is the only d1zzle column type that produces
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

export const literal = (value: unknown): string => {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'bigint') return value.toString();
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
		if (perTable?.byTable[getTableName(t)]?.appendOnly) statements.push(appendOnlyTrigger(getTableName(t)));
	}
	return statements;
}
