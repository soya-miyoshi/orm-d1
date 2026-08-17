/**
 * Live database → snapshot.
 *
 * Pure: it takes the rows `sqlite_master` and the pragmas return, so the same
 * code introspects local Miniflare state, a remote D1 over HTTP, and a real
 * database inside a workerd test. What each pragma actually returns on D1 is
 * verified by those tests rather than assumed from documentation.
 */
import { defaultExpression } from 'orm-d1/ddl';
import type { ColumnSnapshot, ForeignKeySnapshot, IndexSnapshot, Snapshot, TableSnapshot } from './snapshot.js';
import { SNAPSHOT_VERSION } from './snapshot.js';

export interface MasterRow {
	readonly type: string;
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string | null;
}

export interface TableInfoRow {
	readonly cid: number;
	readonly name: string;
	readonly type: string;
	readonly notnull: number;
	readonly dflt_value: string | null;
	readonly pk: number;
	/**
	 * `table_xinfo`'s extra column, absent from `table_info`. 0 = ordinary,
	 * 1 = hidden (virtual-table only), 2 = virtual generated, 3 = stored
	 * generated. `table_info` omits generated columns from its output
	 * entirely, which made every schema using `.generatedAlwaysAs()` look
	 * like it had a column the database did not — permanent drift, and a full
	 * table rebuild on every `push`.
	 */
	readonly hidden?: number;
}

export interface IndexListRow {
	readonly seq: number;
	readonly name: string;
	readonly unique: number;
	/** `c` = CREATE INDEX, `u` = UNIQUE constraint, `pk` = primary key. */
	readonly origin: string;
	readonly partial: number;
}

export interface IndexInfoRow {
	readonly seqno: number;
	readonly cid: number;
	readonly name: string | null;
	/**
	 * `index_xinfo`'s extra columns, absent from `index_info`: whether this
	 * member sorts descending (0/1), and its collation. `index_xinfo` also
	 * appends the rowid tail SQLite adds to make a non-unique index's rows
	 * unique — those carry `key: 0` and must be filtered out by the caller
	 * before this array is built, or they show up as phantom index members.
	 */
	readonly desc?: number;
	readonly coll?: string;
	readonly key?: number;
}

export interface ForeignKeyRow {
	readonly id: number;
	readonly seq: number;
	readonly table: string;
	readonly from: string;
	readonly to: string | null;
	readonly on_update: string;
	readonly on_delete: string;
}

export interface IntrospectionInput {
	readonly master: readonly MasterRow[];
	readonly tableInfo: Record<string, readonly TableInfoRow[]>;
	readonly indexList: Record<string, readonly IndexListRow[]>;
	readonly indexInfo: Record<string, readonly IndexInfoRow[]>;
	readonly foreignKeys: Record<string, readonly ForeignKeyRow[]>;
}

/** Tables SQLite and D1 own, which never belong in a snapshot. */
export const isInternalTable = (name: string): boolean =>
	name.startsWith('sqlite_') || name.startsWith('_cf_') || name === 'd1_migrations';

const unquote = (name: string): string =>
	name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;

/**
 * `check ( … )` clauses, which no pragma exposes.
 *
 * The `constraint <name>` prefix is optional in SQLite, and a hand-written
 * database very often omits it. Requiring it meant an unnamed check was
 * dropped from the snapshot silently, and the next rebuild left it out of the
 * new table — a constraint quietly lost. Unnamed ones get a positional name,
 * which is stable for a given CREATE TABLE and is what the rebuild re-emits.
 */
/**
 * Blank the *contents* of single-quoted literals, keeping the quotes and the
 * length so offsets into the result still index the original SQL. `''` is
 * SQL's escape for a quote inside a literal, which a plain scan handles: the
 * closing quote of the pair immediately reopens.
 */
const blankLiterals = (text: string): string =>
	text.replaceAll(/'(?:[^']|'')*'/g, (literal) => `'${' '.repeat(literal.length - 2)}'`);

export const parseChecks = (
	sql: string,
	tableName = 'table',
): Record<string, { name: string; value: string }> => {
	const checks: Record<string, { name: string; value: string }> = {};
	const pattern = /(?:constraint\s+("(?:[^"]|"")+"|\w+)\s+)?\bcheck\s*\(/gi;
	let unnamed = 0;

	// Scan with string literals blanked out — a column whose default is
	// `'check(1 = 2)'` is not a check constraint, and inventing one there put a
	// phantom into the snapshot that drifted, rebuilt the table, and then
	// carried the same default forward so it never converged. Offsets are
	// preserved so the slices below still index into the original SQL.
	const scan = blankLiterals(sql);

	for (const match of scan.matchAll(pattern)) {
		const name = match[1] ? unquote(match[1]) : `${tableName}_check_${++unnamed}`;
		const start = match.index + match[0].length;
		let depth = 1;
		let i = start;
		while (i < scan.length && depth > 0) {
			if (scan[i] === '(') depth++;
			else if (scan[i] === ')') depth--;
			i++;
		}
		checks[name] = { name, value: sql.slice(start, i - 1).trim() };
	}

	return checks;
};

/**
 * A column name goes into these patterns as data, not as pattern source. A
 * column called `a(` is legal SQLite and used to raise "Invalid regular
 * expression: Unterminated group" from introspection.
 */
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Anchored on a column *definition*, not on the name wherever it appears: the
 * name is matched only after a `(` or `,` (with optional whitespace), so a
 * literal inside another column's string default cannot stand in for it.
 */
const columnDefinitionStart = (columnName: string): string =>
	`[(,]\\s*(?:"${escapeRegExp(columnName).replaceAll('"', '""')}"|\\b${escapeRegExp(columnName)}\\b)`;

export const hasAutoincrement = (sql: string, columnName: string): boolean =>
	new RegExp(`${columnDefinitionStart(columnName)}[^,]*autoincrement`, 'i').test(sql);

export const parseGenerated = (
	sql: string,
	columnName: string,
): { as: string; mode: 'stored' | 'virtual' } | undefined => {
	const match = new RegExp(
		`${columnDefinitionStart(columnName)}[^,]*?generated\\s+always\\s+as\\s*\\(`,
		'i',
	).exec(sql);
	if (!match) return undefined;

	// Balanced scan, not `[^)]*`: an expression is far more likely to contain
	// parentheses than not — `upper("name")` used to come back as `upper("name`
	// with the trailing `stored` unmatched, silently downgrading the mode.
	const start = match.index + match[0].length;
	let depth = 1;
	let i = start;
	while (i < sql.length && depth > 0) {
		if (sql[i] === '(') depth++;
		else if (sql[i] === ')') depth--;
		i++;
	}
	if (depth > 0) return undefined;

	const mode = /^\s*(stored|virtual)/i.exec(sql.slice(i))?.[1]?.toLowerCase();
	return { as: sql.slice(start, i - 1).trim(), mode: (mode as 'stored' | 'virtual') ?? 'virtual' };
};

const parseIndexWhere = (sql: string | null): string | undefined => {
	const match = sql?.match(/\)\s*where\s+(.+)$/is);
	return match ? match[1]!.trim() : undefined;
};

/**
 * The raw column-list text of a `CREATE INDEX`, split into its members in
 * declaration order.
 *
 * `pragma index_info` reports an expression member as `{ cid: -2, name: null
 * }`, losing the expression entirely — there is no pragma that returns it.
 * The only place it survives is `sqlite_master.sql`'s verbatim text, so it is
 * recovered the same way `parseIndexWhere` recovers a partial index's
 * predicate: find the parenthesised list right after `on "<table>"` and
 * split it at its top-level commas (nested parens, e.g. `lower(...)`, do not
 * count as separators).
 */
const parseIndexColumns = (sql: string | null): string[] | undefined => {
	if (!sql) return undefined;
	// Scan `blankLiterals(sql)`, not `sql` itself — an expression member such as
	// `replace("name", '(', '')` or `"name" || ','` has a paren or comma inside
	// a string literal, which would otherwise desynchronise the depth counter
	// or split a member in half. Only the *offsets* come from the blanked
	// text; the actual slices are taken from the original `sql` so the
	// literal's real contents survive. Same technique as `parseChecks`.
	const scan = blankLiterals(sql);
	const openAfterOn = /\bon\s+(?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\(/i.exec(scan);
	if (!openAfterOn) return undefined;
	const start = openAfterOn.index + openAfterOn[0].length;

	let depth = 1;
	let i = start;
	while (i < scan.length && depth > 0) {
		if (scan[i] === '(') depth++;
		else if (scan[i] === ')') depth--;
		i++;
	}
	if (depth > 0) return undefined;
	const bodyEnd = i - 1;

	const members: string[] = [];
	let memberStart = start;
	let nesting = 0;
	for (let j = start; j < bodyEnd; j++) {
		const ch = scan[j];
		if (ch === '(') nesting++;
		else if (ch === ')') nesting--;
		if (ch === ',' && nesting === 0) {
			members.push(sql.slice(memberStart, j).trim());
			memberStart = j + 1;
		}
	}
	const last = sql.slice(memberStart, bodyEnd).trim();
	if (last.length > 0) members.push(last);
	return members;
};

/**
 * `index_xinfo`'s `coll` reports the *column's* declared collation — inherited
 * from the `CREATE TABLE` — not the index member's own, so a plain `create
 * index … ("name")` on a `COLLATE NOCASE` column reports `coll: 'NOCASE'`
 * even though the index text states no collation at all. Trusting it here
 * would make the recreated index (whose member also has no explicit
 * `COLLATE`, and so also inherits the column's) look different from the
 * introspected one forever — a diff that can never converge.
 *
 * So `collate` is read the same way an expression member's text is: from the
 * index's own `CREATE INDEX` text in `sqlite_master.sql`, one member at a
 * time via {@link parseIndexColumns}, and only recorded when that member's
 * own text explicitly carries a `COLLATE` clause.
 */
const parseIndexCollations = (sql: string | null): (string | undefined)[] | undefined => {
	const members = parseIndexColumns(sql);
	if (!members) return undefined;
	const collateRe = /\bcollate\s+("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|'(?:[^']|'')+'|\w+)/i;
	const unquote = (token: string): string => {
		if (
			(token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))
		) {
			return token.slice(1, -1).replaceAll(token[0]! + token[0]!, token[0]!);
		}
		if (token.startsWith('`') && token.endsWith('`')) return token.slice(1, -1).replaceAll('``', '`');
		if (token.startsWith('[') && token.endsWith(']')) return token.slice(1, -1);
		return token;
	};
	return members.map((member) => {
		const match = collateRe.exec(member);
		return match ? unquote(match[1]!) : undefined;
	});
};

/**
 * The `STRICT` / `WITHOUT ROWID` suffix, which no pragma reports.
 *
 * They are table options rather than constraints, so they appear *after* the
 * closing paren of the column list and nowhere else. Scanning only the tail
 * past the final `)` is what keeps a column called `strict` — or a check
 * constraint mentioning the word — from being read as the option.
 *
 * Verified against D1: `sqlite_master` stores the `CREATE TABLE` verbatim, so
 * the text is exactly what was written, in the order it was written.
 */
export const parseTableOptions = (sql: string): { strict: boolean; withoutRowid: boolean } => {
	const close = blankLiterals(sql).lastIndexOf(')');
	if (close < 0) return { strict: false, withoutRowid: false };
	const tail = sql.slice(close + 1).toLowerCase();
	return {
		strict: /\bstrict\b/.test(tail),
		withoutRowid: /\bwithout\s+rowid\b/.test(tail),
	};
};

/**
 * Whether a table carries the append-only guard.
 *
 * Matched on what the trigger *does*, not on its name: a `BEFORE UPDATE`
 * trigger on the table whose body does nothing but abort is the guard, however
 * it is spelled. Keying on the `<table>_no_update` name alone would miss a
 * hand-written equivalent and report drift against a database that is in fact
 * protected.
 *
 * But only an abort that is unconditional *per row* counts. A validation
 * trigger that aborts on some rows — a `WHEN` clause, or a body that does
 * anything else besides raise — leaves UPDATE working, and reading it as the
 * guard reports a table as protected when it is not. That is the direction
 * that costs something, so the looseness stops here: no `WHEN`, and every body
 * statement is a raise.
 *
 * `BEFORE UPDATE OF <columns>` *is* the guard, narrowed. It freezes those
 * columns for every row, which is the same promise over a smaller surface, so
 * it is reported as the list rather than as `true`. Returning `true` for it
 * would claim protection the table does not have; returning `false` would hide
 * orm-d1's own trigger from `apply`, which reads anything unrecognised as a
 * foreign trigger it must refuse to touch.
 *
 * @returns `false` when this is not the guard, `true` for a whole-table guard,
 * or the sorted column list for a scoped one.
 */
export const appendOnlyTriggerGuard = (sql: string, tableName: string): boolean | string[] => {
	// Two views of the same string: `scan` has literals blanked and whitespace
	// collapsed so keywords can be found, `source` is the same collapse without
	// the case folding, so a column name keeps the case it was declared with.
	// Offsets line up because both transforms are length-preserving per run.
	const source = blankLiterals(sql).replaceAll(/\s+/g, ' ');
	const text = source.toLowerCase();
	const quoted = tableName.toLowerCase();

	const begin = text.indexOf(' begin ');
	const end = text.lastIndexOf(' end');
	if (begin < 0 || end < begin) return false;
	const header = text.slice(0, begin);

	// A `WHEN` clause makes the guard conditional on the row, which `UPDATE OF`
	// does not: `OF` narrows *which columns* are frozen, and every one of them
	// stays frozen for every row.
	if (/\bwhen\b/.test(header)) return false;

	const head = /\bbefore\s+update\s+(?:of\s+(.+?)\s+)?on\s+/.exec(header);
	if (!head) return false;
	if (!new RegExp(`\\bon\\s+["'\`\\[]?${quoted.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`\\]]?\\b`).test(header)) {
		return false;
	}

	const body = text.slice(begin + ' begin '.length, end);
	const parts = body.split(';').map((s) => s.trim()).filter(Boolean);
	const aborts = parts.length > 0
		&& parts.every((s) => /^select\s+raise\s*\(\s*abort\s*(?:,[^()]*)?\)$/.test(s));
	if (!aborts) return false;

	if (head[1] === undefined) return true;
	// Slice the column list out of the case-preserving view, at the offsets the
	// lowercased match reported.
	const listStart = head.index + head[0].indexOf(head[1]);
	const columns = source.slice(listStart, listStart + head[1].length)
		.split(',')
		.map((c) => unquote(c.trim()))
		.filter(Boolean);
	// A guard that names no column would freeze nothing; treat the trigger as
	// something else rather than reporting protection that is not there.
	return columns.length > 0 ? columns.sort() : false;
};

/**
 * Whether the table carries *some* append-only guard, whole-table or scoped.
 *
 * `apply` uses this to tell orm-d1's own trigger apart from ones the schema
 * does not know about; for that question the column list does not matter.
 */
export const isAppendOnlyTrigger = (sql: string, tableName: string): boolean =>
	appendOnlyTriggerGuard(sql, tableName) !== false;

export function snapshotFromIntrospection(input: IntrospectionInput, id = ''): Snapshot {
	const tables: Record<string, TableSnapshot> = {};
	const indexSql = new Map<string, string | null>();
	const appendOnly = new Map<string, boolean | string[]>();
	for (const row of input.master) {
		if (row.type === 'index') indexSql.set(row.name, row.sql);
		if (row.type === 'trigger' && row.sql) {
			const guard = appendOnlyTriggerGuard(row.sql, row.tbl_name);
			if (guard !== false) appendOnly.set(row.tbl_name, guard);
		}
	}

	for (const row of input.master) {
		if (row.type !== 'table' || isInternalTable(row.name)) continue;
		const createSql = row.sql ?? '';

		const columns: Record<string, ColumnSnapshot> = {};
		const info = input.tableInfo[row.name] ?? [];
		const pkColumns = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
		const compositePk = pkColumns.length > 1;

		const fks = input.foreignKeys[row.name] ?? [];
		const groupedFks = new Map<number, ForeignKeyRow[]>();
		for (const fk of fks) {
			const bucket = groupedFks.get(fk.id);
			if (bucket) bucket.push(fk);
			else groupedFks.set(fk.id, [fk]);
		}

		const foreignKeys: Record<string, ForeignKeySnapshot> = {};
		for (const [, group] of groupedFks) {
			const ordered = [...group].sort((a, b) => a.seq - b.seq);
			const name = `${row.name}_${ordered.map((f) => f.from).join('_')}_fk`;
			foreignKeys[name] = {
				name,
				columns: ordered.map((f) => f.from),
				tableTo: ordered[0]!.table,
				columnsTo: ordered.map((f) => f.to ?? ''),
				onDelete: normaliseAction(ordered[0]!.on_delete),
				onUpdate: normaliseAction(ordered[0]!.on_update),
			};
		}

		const indexes: Record<string, IndexSnapshot> = {};
		const uniqueConstraints: Record<string, { name: string; columns: readonly string[] }> = {};

		for (const index of input.indexList[row.name] ?? []) {
			const sortedMembers = (input.indexInfo[index.name] ?? []).slice().sort((a, b) => a.seqno - b.seqno);
			// `cid === -2` is an expression member — `pragma index_info` has no
			// text for it, so the raw `CREATE INDEX` column list is parsed and
			// matched up by position (both are in declaration order).
			const rawColumns = sortedMembers.some((m) => m.name === null)
				? parseIndexColumns(indexSql.get(index.name) ?? null)
				: undefined;
			// `desc` from `index_xinfo` is per-member and reliable; `coll` is not
			// (see {@link parseIndexCollations}), so collation is read from the
			// index's own DDL text instead, one member at a time.
			const collations = parseIndexCollations(indexSql.get(index.name) ?? null);
			const memberColumns: { expression: string; isExpression: boolean; desc?: boolean; collate?: string }[] =
				sortedMembers
					.map((m, i) => ({
						...(m.name !== null
							? { expression: m.name, isExpression: false }
							: { expression: rawColumns?.[i] ?? '', isExpression: true }),
						...(m.desc === 1 ? { desc: true } : {}),
						...(collations?.[i] ? { collate: collations[i] } : {}),
					}))
					.filter((c) => c.expression !== '');

			if (index.origin === 'pk') continue;
			if (index.origin === 'u') {
				uniqueConstraints[index.name] = { name: index.name, columns: memberColumns.map((c) => c.expression) };
				continue;
			}
			indexes[index.name] = {
				name: index.name,
				columns: memberColumns,
				isUnique: index.unique === 1,
				where: index.partial ? parseIndexWhere(indexSql.get(index.name) ?? null) : undefined,
			};
		}

		for (const column of info) {
			// `hidden` comes from `table_xinfo`: 1 is a virtual-table hidden
			// column, which is not part of the schema; 2 and 3 are generated.
			if (column.hidden === 1) continue;

			const single = !compositePk && column.pk === 1;
			const generated = column.hidden === 2 || column.hidden === 3
				// The pragma says *that* it is generated and with which storage;
				// only the expression has to come out of the CREATE TABLE text.
				? {
					as: parseGenerated(createSql, column.name)?.as ?? '',
					mode: (column.hidden === 3 ? 'stored' : 'virtual') as 'stored' | 'virtual',
				}
				: undefined;

			columns[column.name] = {
				name: column.name,
				type: column.type.toLowerCase(),
				// The raw spelling `sqlite_master`/`table_xinfo` reports, verbatim —
				// the same slot a schema-side `customType` fills with its exact
				// `dataType(config)` string. Setting it here (rather than leaving it
				// `undefined`) turns off `typeMatchesAcrossUpgrade`'s legacy-affinity
				// hatch for every live-vs-schema and live-vs-live comparison: both
				// sides now carry a `declaredType`, so `columnDifference` compares
				// `typeAffinity` of the real spellings on both sides instead of
				// reinterpreting one side under the old substring rule. The hatch
				// only still fires for a *stored* snapshot written before this field
				// existed, which genuinely has no `declaredType` on disk.
				declaredType: column.type,
				primaryKey: single,
				notNull: column.notnull === 1 || single,
				autoincrement: single && hasAutoincrement(createSql, column.name),
				// A single-column UNIQUE constraint is reported as an index; it is
				// recorded there rather than duplicated onto the column.
				unique: false,
				// `pragma table_info` strips the parens off an expression default;
				// the snapshot keeps the spelling that `CREATE TABLE` accepts, so
				// every consumer of a snapshot gets a usable one.
				default: column.dflt_value === null ? undefined : defaultExpression(column.dflt_value),
				generated,
				references: undefined,
			};
		}

		const compositePrimaryKeys: Record<string, { name: string; columns: readonly string[] }> = {};
		if (compositePk) {
			const name = `${row.name}_pk`;
			compositePrimaryKeys[name] = { name, columns: pkColumns.map((c) => c.name) };
		}

		tables[row.name] = {
			name: row.name,
			columns,
			indexes,
			foreignKeys,
			compositePrimaryKeys,
			uniqueConstraints,
			checkConstraints: parseChecks(createSql, row.name),
			...parseTableOptions(createSql),
			appendOnly: appendOnly.get(row.name) ?? false,
		};
	}

	return { version: SNAPSHOT_VERSION, dialect: 'sqlite', id, prevId: '', tables, origin: 'introspection' };
}

const normaliseAction = (action: string): string | undefined => {
	const value = action.toLowerCase();
	return value === 'no action' || value === '' ? undefined : value;
};
