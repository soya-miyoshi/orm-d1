/**
 * Live database → snapshot.
 *
 * Pure: it takes the rows `sqlite_master` and the pragmas return, so the same
 * code introspects local Miniflare state, a remote D1 over HTTP, and a real
 * database inside a workerd test. What each pragma actually returns on D1 is
 * verified by those tests rather than assumed from documentation.
 */
import { defaultExpression } from 'orm-d1/ddl';
import type { ColumnSnapshot, ForeignKeySnapshot, IndexSnapshot, Snapshot, TableSnapshot, UniqueColumnSnapshot } from './snapshot.js';
import { SNAPSHOT_VERSION } from './snapshot.js';
import { foldAsciiCase } from './sql.js';

/** A table-level `UNIQUE (…)` member, as recovered from `CREATE TABLE` text. */
interface RawUniqueMember {
	readonly name: string;
	readonly collate?: string;
	/**
	 * Only ever set by {@link parseTablePrimaryKeyClause} — a unique
	 * constraint member cannot carry `AUTOINCREMENT` (SQLite rejects it
	 * outside a primary key clause), so `parseTableUniqueConstraints` never
	 * populates this.
	 */
	readonly autoincrement?: boolean;
}
/** A whole table-level `[constraint <name>] UNIQUE (…)` clause. */
interface RawUniqueClause {
	readonly name: string | undefined;
	readonly members: readonly RawUniqueMember[];
}

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

// Widened to all four identifier spellings for the same reason
// `columnDefinitionStart` was (`[F-112]`): a name captured by a caller whose
// own pattern now matches backtick/bracket forms (e.g. the constraint-name
// regex in `parseTableUniqueConstraints`, `[F-115]`'s class) must still be
// unquoted correctly, not merely left verbatim because only `"…"` was known.
const unquote = (name: string): string =>
	name.startsWith('"') && name.endsWith('"')
		? name.slice(1, -1).replaceAll('""', '"')
		: name.startsWith('`') && name.endsWith('`')
		? name.slice(1, -1)
		: name.startsWith('[') && name.endsWith(']')
		? name.slice(1, -1)
		: name;

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
 * Blank the *contents* of single-quoted literals and both comment forms
 * (`-- …` to end of line, `/* … *\/`), keeping delimiters where literals have
 * them and the exact length everywhere, so offsets into the result still
 * index the original SQL. `''` is SQL's escape for a quote inside a literal,
 * which a plain scan handles: the closing quote of the pair immediately
 * reopens.
 *
 * Comments have to be blanked here, not just literals: D1 stores a
 * `CREATE TABLE` verbatim, comment text included, and every scan in this file
 * that walks the DDL looking for `collate`/`check`/`generated always`/a
 * balanced paren treats comment text as structure otherwise. A `-- TODO:
 * collate nocase` in a comment used to be read as the column's own collation
 * (misattributing a constraint the live column does not have — the rebuild
 * then emits `COLLATE NOCASE` over a BINARY column, and applying it against a
 * unique index fails with `SQLITE_CONSTRAINT`, unappliable). An unbalanced
 * `(` or a stray `"` inside a comment used to desynchronise the paren/quote
 * depth counters that come after this blanking, silently dropping a genuine
 * collation that appears later in the same column span.
 *
 * Quoted identifiers — `"…"`, `` `…` ``, `[…]` — are matched as self-mapping
 * alternatives for the same reason the `'…'` string-literal alternative is:
 * in the alternation, whichever branch matches at a given start position wins
 * and its span is consumed whole, never rescanned by the comment branches
 * that come after it. A dash-dash or slash-star cannot occur anywhere in
 * valid SQLite outside a literal, so a column named `"a--b"` or `` `a` `` with
 * a slash-star in it had its own quoted name read as the start of a comment,
 * blanking everything from there to end-of-line (or to the next unrelated
 * comment close) — constraints and even later column definitions vanished
 * from the scan a line or more away from the identifier that triggered it.
 *
 * Unlike `'…'`, an identifier's own text is passed through unblanked: callers
 * such as `columnDefinitionStart` search the *blanked* text for the literal
 * `"columnName"` span to anchor on, so erasing an identifier's contents here
 * would make every quoted column unfindable. An identifier cannot smuggle a
 * dash-dash, slash-star, or `'` that changes how the *rest* of the scan is
 * read — its doubled-quote escape is the only special sequence it carries,
 * and the regex already accounts for it — so passing it through verbatim is
 * safe.
 */
const blankLiterals = (text: string): string =>
	text.replaceAll(
		/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
		(span) => {
			const open = span[0];
			if (open === "'") return `'${' '.repeat(span.length - 2)}'`;
			if (open === '"' || open === '`' || open === '[') return span;
			return ' '.repeat(span.length);
		},
	);

/**
 * Blank a quoted identifier's *contents* to spaces, keeping its delimiters —
 * `"…"`, `` `…` ``, `[…]` — for a scan (`hasAutoincrement`'s) that must not
 * mistake a keyword merely spelled inside a quoted name for the keyword
 * itself. `blankLiterals` deliberately leaves an identifier's own text
 * verbatim (other callers anchor on it), so this is a separate pass applied
 * only where that verbatim text would otherwise create a false positive: a
 * column named `[autoincrement_hint]`, a `references "autoincrement_counters"
 * (...)` clause, or a `check (...)` clause mentioning a same-named column, all
 * of which contain the literal word `autoincrement` without it ever being the
 * `AUTOINCREMENT` keyword.
 */
const blankIdentifierContents = (text: string): string =>
	text.replaceAll(
		/"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g,
		(span) => `${span[0]}${' '.repeat(span.length - 2)}${span[span.length - 1]}`,
	);

/**
 * Blank *only* comments from a value already sliced out of the DDL for
 * storage in a snapshot (a `check` expression, a generated column's `as`, an
 * index member) — string literals and quoted identifiers pass through
 * verbatim, unlike {@link blankLiterals}, because this text is re-emitted on
 * the next rebuild and a literal's real contents must survive.
 *
 * A trailing `-- …` comment left in used to re-render as invalid SQL: `check
 * ("a" > 0 -- positive\n)` is captured with the comment attached, and the
 * `.trim()` every caller applies afterward strips the newline that made it
 * harmless as a *comment*, leaving `check ("a" > 0 -- positive)` — everything
 * after `--`, including the closing paren, is now commented out, and D1
 * refuses it with `incomplete input` (`[F-113]`). Blanking the comment's own
 * text to spaces (not deleting it) keeps the trailing newline that follows
 * `-- …` — the match itself excludes `\n` — so this still ends the comment,
 * and the caller's `.trim()` then removes the now-all-whitespace tail
 * cleanly. Spaces rather than deletion also can't accidentally fuse two
 * identifiers that a comment used to separate.
 */
const blankComments = (text: string): string =>
	text.replaceAll(
		/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
		(span) => (span[0] === '-' || span[0] === '/' ? ' '.repeat(span.length) : span),
	);

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
			const ch = scan[i];
			// Quote-aware, like every other balanced-paren scan in this file: a
			// column named `"a("` inside the check's expression (e.g. `check
			// ("a(" <> '')`) must not desynchronise depth, or the scan runs past
			// the constraint's real close paren and swallows the rest of the
			// table body — including later columns — into `value` ([F-108]'s
			// class, unfixed here even after `skipQuotedIdentifier` was written).
			if (ch === '"' || ch === '`' || ch === '[') {
				i = skipQuotedIdentifier(scan, i);
				continue;
			}
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			i++;
		}
		checks[name] = { name, value: blankComments(sql.slice(start, i - 1)).trim() };
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
 *
 * All four identifier spellings SQLite accepts — `"…"`, `` `…` ``, `[…]`, and
 * bare — are matched, not just `"…"` and bare: a backtick- or bracket-quoted
 * column used to be invisible to every caller of this anchor (`hasAutoincrement`,
 * `parseGenerated`, `parseColumnCollation`), silently dropping whatever they
 * were looking for (`[F-112]`).
 */
const columnDefinitionStart = (columnName: string): string => {
	const escaped = escapeRegExp(columnName);
	return `[(,]\\s*(?:"${escaped.replaceAll('"', '""')}"|\`${escaped.replaceAll('`', '``')}\`|\\[${escaped}\\]|\\b${escaped}\\b)`;
};

/**
 * Paren depth (quote-aware, via {@link skipQuotedIdentifier}) at every offset
 * of `scan`, so a caller can tell a "definition start" match that is actually
 * nested inside an earlier column's own parenthesised sub-expression — a
 * foreign-key reference's column list, a `check (…)`, a `generated always as
 * (…)` — from one that is a genuine top-level column/constraint boundary.
 */
const computeDepths = (scan: string): number[] => {
	const depths: number[] = [];
	let depth = 0;
	let i = 0;
	while (i < scan.length) {
		const ch = scan[i];
		if (ch === '"' || ch === '`' || ch === '[') {
			const end = skipQuotedIdentifier(scan, i);
			for (let k = i; k < end && k < scan.length; k++) depths[k] = depth;
			i = end;
			continue;
		}
		depths[i] = depth;
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		i++;
	}
	return depths;
};

/**
 * The shared anchor every column-definition scan in this file uses. Finds
 * `columnDefinitionStart`'s match — not the *first* one in the text, but the
 * first that sits at paren depth 1 (directly inside the table's own column
 * list, not nested inside another column's foreign-key reference or
 * expression). Taking the first match unconditionally used to anchor on, say,
 * a `references "users"("id")` clause that happens to contain `("id")` before
 * the real `"id"` column definition ever appears (`[F-112]`).
 */
const findColumnDefinitionAnchor = (
	scan: string,
	columnName: string,
	// `computeDepths` and `blankLiterals` are pure functions of the *table's*
	// whole `CREATE TABLE` text, not of any one column — every per-column
	// caller in this file (`hasAutoincrement`, `parseColumnCollation`,
	// `parseGenerated`) used to recompute both, from scratch, on every single
	// column, tripling the work for a 3-column table and worse beyond that.
	// Accepting the already-computed depths here (and `blankLiterals`'s
	// result via `scan` itself, already a parameter) lets a per-table caller
	// hoist both out of the per-column loop instead; a caller with no table
	// context (a direct unit-test call, say) still gets the same answer by
	// leaving this unset.
	depths: readonly number[] = computeDepths(scan),
): RegExpExecArray | undefined => {
	for (const match of scan.matchAll(new RegExp(columnDefinitionStart(columnName), 'gi'))) {
		// `depths[match.index]` is the depth *at* the separator (`(` or `,`)
		// itself — for the table's very own opening `(`, that is still 0 (the
		// increment to 1 happens only once the character is consumed), even
		// though the column right after it is exactly as "top-level" as one
		// after a top-level `,` (already at depth 1, since a comma does not
		// change depth). Checking one position later — the first character of
		// what the separator introduces — reports 1 uniformly for both.
		if (depths[match.index + 1] === 1) return match;
	}
	return undefined;
};

export const hasAutoincrement = (
	sql: string,
	columnName: string,
	// See `findColumnDefinitionAnchor`'s matching parameter: hoisted per-table
	// by `snapshotFromIntrospection`'s column loop, computed fresh otherwise.
	precomputed?: { scan: string; depths: readonly number[]; pkClause?: readonly RawUniqueMember[] | undefined },
): boolean => {
	const scan = precomputed?.scan ?? blankLiterals(sql);
	const depths = precomputed?.depths ?? computeDepths(scan);
	const anchor = findColumnDefinitionAnchor(scan, columnName, depths);
	if (anchor) {
		const spanStart = anchor.index + anchor[0].length;
		const rest = scan.slice(spanStart);
		const commaIdx = rest.indexOf(',');
		const span = commaIdx === -1 ? rest : rest.slice(0, commaIdx);
		// The bare `/autoincrement/i.test(span)` this replaced matched the word
		// appearing *anywhere* in the span — including inside a quoted
		// identifier verbatim (a column literally named `autoincrement`, a
		// `references "autoincrement_counters"(...)` clause, a `check (...)`
		// mentioning a column called `autoincrement`) or nested inside that
		// same `check`/`references` clause's own parens. Any of those made this
		// fabricate `AUTOINCREMENT` on a column that never declared it —
		// silently wrong PK semantics on an INTEGER PK, or an outright D1
		// rejection (`AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`)
		// on anything else. `blankIdentifierContents` erases what is inside a
		// quoted name so the word can no longer hide there, and requiring the
		// remaining match's paren depth (from the whole-scan `depths`, at the
		// anchor's own depth of 1) to still be top-level excludes one buried
		// inside a nested `references (...)`/`check (...)` even when spelled
		// unquoted.
		for (const match of blankIdentifierContents(span).matchAll(/\bautoincrement\b/gi)) {
			if (depths[spanStart + match.index] === 1) return true;
		}
	}
	// SQLite also accepts AUTOINCREMENT stated inside a *table-level*
	// `primary key (col autoincrement)` clause rather than on the column's own
	// definition — legal only for a single, INTEGER-affinity column, but
	// nothing here assumes that; `parseTablePrimaryKeyClause` already knows
	// how to find the clause regardless of how many members it has. The
	// column-definition anchor above can never see this: the clause is a
	// separate, later, top-level constraint, not part of the column's own
	// span. Falling through to it here (rather than requiring the caller to
	// know which shape the DDL used) makes both spellings equivalent.
	const pkMembers = precomputed?.pkClause ?? parseTablePrimaryKeyClause(sql);
	return pkMembers?.some((m) => m.autoincrement && foldAsciiCase(m.name) === foldAsciiCase(columnName)) ?? false;
};

/**
 * A column's own `COLLATE` clause, from the `CREATE TABLE` text — no pragma
 * reports it (`pragma table_info`'s `notnull`/`pk`/`dflt_value` say nothing
 * about collation). Anchored on the column *definition* the same way
 * `hasAutoincrement`/`parseGenerated` are, over `blankLiterals` so a string
 * default containing the word `collate` cannot be mistaken for the clause.
 *
 * Kept in the raw case the DDL text used (mirroring `parseIndexCollations`,
 * which does the same for an index member) — normalising away case
 * differences is `canonicalTable`'s job at comparison time, not this
 * function's, so a schema-side spelling and a live one still round-trip
 * byte-for-byte through `createTableFromSnapshot`.
 */
/**
 * If `scan[i]` opens a quoted identifier — `"…"`, `` `…` ``, or `[…]`, the
 * three spellings SQLite accepts and `parseIndexColumns`'s anchor already
 * treats as first-class — advance past its matching close (verbatim, `""`/
 * ` `` ` escape included for the quote forms) and return the new index.
 * Otherwise return `i` unchanged.
 *
 * Shared by every balanced-paren scan below so an identifier's embedded `(`,
 * `)`, or `"` can never desynchronise paren depth: `"a("` used to push depth
 * to 2 and swallow the rest of the table body ([F-108]), and the same was
 * true, unfixed, of the backtick/bracket spellings and of `parseGenerated`'s
 * own copy of this scan.
 */
const skipQuotedIdentifier = (scan: string, i: number): number => {
	const ch = scan[i];
	if (ch === '"' || ch === '`') {
		let j = i + 1;
		while (j < scan.length) {
			if (scan[j] === ch) {
				if (ch === '"' && scan[j + 1] === '"') {
					j += 2;
					continue;
				}
				j++;
				break;
			}
			j++;
		}
		return j;
	}
	if (ch === '[') {
		const close = scan.indexOf(']', i + 1);
		return close === -1 ? scan.length : close + 1;
	}
	return i;
};

export const parseColumnCollation = (
	sql: string,
	columnName: string,
	precomputed?: { scan: string; depths: readonly number[] },
): string | undefined => {
	const scan = precomputed?.scan ?? blankLiterals(sql);
	const depths = precomputed?.depths ?? computeDepths(scan);
	const anchor = findColumnDefinitionAnchor(scan, columnName, depths);
	if (!anchor) return undefined;

	// The column definition's own span: from right after its name to the next
	// top-level comma (the next column, or a table-level constraint) or the
	// closing paren of the column list — crossing nested parens rather than
	// stopping at their first `)`, the same balanced scan `parseGenerated` uses
	// for its expression.
	//
	// A `COLLATE` is only ever the column's own when it sits at the *top
	// level* of this span (paren depth 0): a `constraint … check (…)` or
	// `generated always as (…)` opens a paren immediately after the keyword,
	// so anything inside it — including a `collate` the sub-expression itself
	// uses, e.g. `check ("status" collate nocase in (...))` — sits at depth
	// >= 1 and is skipped ([F-106]; a version of this function that matched
	// `collate` anywhere in the whole span misattributed that one to the
	// column, and a rebuild that believed it invented `COLLATE NOCASE` over a
	// live BINARY column, which then fails to apply against a unique index).
	// `unique ("email" collate nocase)` at the *table* level is unreachable
	// here regardless, since it comes after the span's closing top-level
	// comma/paren.
	//
	// Depth is only counted outside a quoted identifier: `"a("`, `` `a(` ``, and
	// `[a(]` are all legal column names whose embedded `(` must not
	// desynchronise the counter, or the span never returns to depth 0 and
	// swallows everything after it, including a table-level `unique(...)`
	// clause ([F-108]).
	let depth = 0;
	let i = anchor.index + anchor[0].length;
	let collate: string | undefined;
	while (i < scan.length) {
		const ch = scan[i];
		if (ch === '"' || ch === '`' || ch === '[') {
			i = skipQuotedIdentifier(scan, i);
			continue;
		}
		if (ch === '(') {
			depth++;
			i++;
			continue;
		}
		if (ch === ')') {
			if (depth === 0) break;
			depth--;
			i++;
			continue;
		}
		if (ch === ',' && depth === 0) break;
		if (
			depth === 0 && collate === undefined
			// `collate` must start a new word here, not appear mid-identifier: a
			// constraint named `b_collate` — `constraint b_collate check (...)` —
			// otherwise matched at its own `collate` suffix and the *next* token
			// (`check`) was read as the collation name, later rendered as
			// `COLLATE check`, which D1 refuses (`near "check": syntax error`).
			&& (i === 0 || !/\w/.test(scan[i - 1]!))
		) {
			// A bare name or a quoted one — `collate "NOCASE"`, `` collate `NOCASE` ``,
			// and `collate [NOCASE]` are all legal SQLite and all verified forms D1
			// stores verbatim; only matching the `"…"` spelling left the other two
			// invisible, so a rebuild silently dropped the collation (and the
			// meaning of any unique index built over the column).
			//
			// The separator before the name is optional whitespace when the name is
			// quoted (`collate"NOCASE"`, no space, is legal SQLite and D1 stores it
			// verbatim) but *required* before a bare word — otherwise `collatenocase`,
			// one identifier with no `collate` keyword in it at all, would match as
			// `collate` + `nocase` (`[F-112]`).
			const rest = scan.slice(i);
			const match = /^collate(?:\s+(\w+)|\s*("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]))/i.exec(rest);
			if (match) {
				const name = (match[1] ?? match[2])!;
				collate = name.startsWith('"')
					? name.slice(1, -1).replaceAll('""', '"')
					: name.startsWith('`')
					? name.slice(1, -1)
					: name.startsWith('[')
					? name.slice(1, -1)
					: name;
				i += match[0].length;
				continue;
			}
		}
		i++;
	}

	return collate;
};

export const parseGenerated = (
	sql: string,
	columnName: string,
	precomputed?: { scan: string; depths: readonly number[] },
): { as: string; mode: 'stored' | 'virtual' } | undefined => {
	const scan = precomputed?.scan ?? blankLiterals(sql);
	const depths = precomputed?.depths ?? computeDepths(scan);
	const anchor = findColumnDefinitionAnchor(scan, columnName, depths);
	if (!anchor) return undefined;
	const tailStart = anchor.index + anchor[0].length;
	const genMatch = /^[^,]*?generated\s+always\s+as\s*\(/i.exec(scan.slice(tailStart));
	if (!genMatch) return undefined;

	// Balanced scan, not `[^)]*`: an expression is far more likely to contain
	// parentheses than not — `upper("name")` used to come back as `upper("name`
	// with the trailing `stored` unmatched, silently downgrading the mode.
	//
	// Quote-aware over `scan`, the same as `parseColumnCollation`'s span scan:
	// a column named `"a("` (legal SQLite) used to push depth to 2 and swallow
	// the rest of the table body into `as`, producing a migration D1 refuses
	// with `unknown table option: virtual` ([F-108], the sub-issue this
	// function shared with `parseColumnCollation` before both used
	// `skipQuotedIdentifier`).
	const start = tailStart + genMatch[0].length;
	let depth = 1;
	let i = start;
	while (i < scan.length && depth > 0) {
		const ch = scan[i];
		if (ch === '"' || ch === '`' || ch === '[') {
			i = skipQuotedIdentifier(scan, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		i++;
	}
	if (depth > 0) return undefined;

	const mode = /^\s*(stored|virtual)/i.exec(sql.slice(i))?.[1]?.toLowerCase();
	return { as: blankComments(sql.slice(start, i - 1)).trim(), mode: (mode as 'stored' | 'virtual') ?? 'virtual' };
};

const parseIndexWhere = (sql: string | null): string | undefined => {
	const match = sql?.match(/\)\s*where\s+(.+)$/is);
	// Routed through `blankComments`, the same as `parseChecks`/`parseGenerated`/
	// `parseIndexColumns`/`parseTableUniqueConstraints`: a trailing `-- comment`
	// inside the predicate would otherwise be stored verbatim and, on re-render,
	// corrupt statement splitting for whatever follows it in the same batch.
	return match ? blankComments(match[1]!).trim() : undefined;
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

	// Both scans below are quote-aware for the same reason `parseChecks` and
	// `parseColumnCollation` are: a member such as `"a("` (legal SQLite) has an
	// embedded `(` that must not desynchronise depth, or the scan runs past the
	// index's real close paren, and a two-member unique index re-renders as a
	// stricter one-member one on rebuild ([F-108]'s class).
	let depth = 1;
	let i = start;
	while (i < scan.length && depth > 0) {
		const ch = scan[i];
		if (ch === '"' || ch === '`' || ch === '[') {
			i = skipQuotedIdentifier(scan, i);
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		i++;
	}
	if (depth > 0) return undefined;
	const bodyEnd = i - 1;

	const members: string[] = [];
	let memberStart = start;
	let nesting = 0;
	for (let j = start; j < bodyEnd;) {
		const ch = scan[j];
		if (ch === '"' || ch === '`' || ch === '[') {
			j = skipQuotedIdentifier(scan, j);
			continue;
		}
		if (ch === '(') nesting++;
		else if (ch === ')') nesting--;
		if (ch === ',' && nesting === 0) {
			members.push(blankComments(sql.slice(memberStart, j)).trim());
			memberStart = j + 1;
		}
		j++;
	}
	const last = blankComments(sql.slice(memberStart, bodyEnd)).trim();
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
		// `member` is sliced from the *original* `sql` (`parseIndexColumns`
		// deliberately keeps string-literal contents intact), so a literal
		// containing the word `collate` — `replace("a", ' collate x ', '')` — would
		// otherwise be read as the member's own collation clause and re-emitted
		// as an unescaped, uninterpolated `COLLATE x` (`[F-069]`, the same hazard
		// `blankLiterals` exists to close everywhere else in this file). Blanking
		// here, not in `parseIndexColumns`, keeps the *stored* member text
		// literal-faithful for re-rendering while still scanning it safely.
		// Anchored the same way `parseTableUniqueConstraints` anchors a member:
		// scan only *after* the leading identifier/name, not the whole member
		// text. `blankLiterals` blanks string literals but deliberately leaves
		// quoted *identifiers* alone, so a column named `"collate nocase"` used
		// as a plain index member — `create index i on t("collate nocase")` —
		// still carries the literal word "collate" in `blanked`, and scanning
		// the whole member misread that identifier as an actual `COLLATE`
		// clause the index member never stated.
		const blanked = blankLiterals(member);
		const nameMatch = /^\s*("(?:[^"]|"")+"|`[^`]*`|\[[^\]]*\]|\w+)/.exec(blanked);
		const match = collateRe.exec(blanked.slice(nameMatch ? nameMatch[0].length : 0));
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
	// Slice the tail out of the *blanked* text, not the raw SQL: blanking removes
	// comments, so a `)` inside one no longer bounds the column list, and a comment
	// mentioning `strict` / `without rowid` after that point would otherwise be read
	// as the option itself — inventing a constraint the table never had.
	const blanked = blankLiterals(sql);
	const close = blanked.lastIndexOf(')');
	if (close < 0) return { strict: false, withoutRowid: false };
	const tail = blanked.slice(close + 1).toLowerCase();
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
	// `foldAsciiCase`, not `.toLowerCase()`: this text is sliced by offset
	// below (`listStart`/`head[1].length`) to recover the case-preserving
	// column list, which only lines up when the fold is length-preserving.
	// `.toLowerCase()` is not — Turkish İ (U+0130) folds to two UTF-16 code
	// units ('i' + combining dot above, U+0307), corrupting every offset past
	// it and slicing the wrong span out of `source`. `foldAsciiCase` only
	// touches ASCII `A`-`Z`, so it can never change the string's length.
	const source = blankLiterals(sql).replaceAll(/\s+/g, ' ');
	const text = foldAsciiCase(source);
	const quoted = foldAsciiCase(tableName);

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

/**
 * The table-level `[constraint <name>] primary key (…)` clause's members, in
 * declaration order, with each member's own `COLLATE` if it states one —
 * the primary-key analogue of `parseTableUniqueConstraints` below (`[F-115]`,
 * the next number after `[F-114]`; grep `\[F-1` for the running tally).
 *
 * `pragma table_info`/`table_xinfo` report which columns make up a composite
 * primary key and their order (its `pk` sequence), but never a member's
 * `collate` — the same gap `[F-111]` closed for a table-level `unique (…)`
 * member, and for the same reason: the automatic index SQLite builds for a
 * composite primary key has no `sqlite_master.sql` row of its own, only the
 * owning table's does. Unlike a unique constraint a table has at most one
 * primary key, so there is no `matchUniqueClause`-style "used" bookkeeping
 * to do here — the sole clause's members are matched to `pragma table_info`'s
 * `pk`-ordered columns purely by position.
 */
const parseTablePrimaryKeyClause = (sql: string): readonly RawUniqueMember[] | undefined => {
	const scan = blankLiterals(sql);
	const depths = computeDepths(scan);
	// Same anchor and quoting-form coverage as `parseTableUniqueConstraints`'s
	// `pattern` (`[F-112]`'s class): all four constraint-name spellings, only
	// at depth 1 (a top-level table clause, not nested inside a column's own
	// `references (…)`/`check (…)`).
	const pattern = /[(,]\s*(?:constraint\s+("(?:[^"]|"")+"|`[^`]*`|\[[^\]]*\]|\w+)\s+)?primary\s+key\s*\(/gi;

	for (const match of scan.matchAll(pattern)) {
		if (depths[match.index + 1] !== 1) continue;
		const start = match.index + match[0].length;
		let depth = 1;
		let i = start;
		while (i < scan.length && depth > 0) {
			const ch = scan[i];
			if (ch === '"' || ch === '`' || ch === '[') {
				i = skipQuotedIdentifier(scan, i);
				continue;
			}
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			i++;
		}
		if (depth > 0) continue;
		const bodyEnd = i - 1;

		const rawMembers: string[] = [];
		let memberStart = start;
		let nesting = 0;
		for (let j = start; j < bodyEnd;) {
			const ch = scan[j];
			if (ch === '"' || ch === '`' || ch === '[') {
				j = skipQuotedIdentifier(scan, j);
				continue;
			}
			if (ch === '(') nesting++;
			else if (ch === ')') nesting--;
			if (ch === ',' && nesting === 0) {
				rawMembers.push(blankComments(sql.slice(memberStart, j)).trim());
				memberStart = j + 1;
			}
			j++;
		}
		const last = blankComments(sql.slice(memberStart, bodyEnd)).trim();
		if (last.length > 0) rawMembers.push(last);

		return rawMembers.map((raw) => {
			// Same span/blank-literal technique `parseTableUniqueConstraints` uses
			// for a unique member, for the same false-positive reasons ([F-069]'s
			// class for a string literal, the quoted-identifier note for a name
			// that literally contains the word "collate").
			const blanked = blankLiterals(raw);
			const nameMatch = /^\s*("(?:[^"]|"")+"|`[^`]*`|\[[^\]]*\]|\w+)/.exec(blanked);
			const rawName = nameMatch ? nameMatch[1]! : blanked.trim();
			const collateMatch = /\bcollate(?:\s+(\w+)|\s*("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]))/i.exec(
				blanked.slice(nameMatch ? nameMatch[0].length : 0),
			);
			const collateToken = collateMatch ? (collateMatch[1] ?? collateMatch[2]) : undefined;
			// `[F-1xx]`: a table-level `primary key (col autoincrement)` states
			// AUTOINCREMENT on the *member*, not on the column definition — see
			// `hasAutoincrement`'s fallback, which is the only reader of this flag.
			const autoincrement = /\bautoincrement\b/i.test(blanked.slice(nameMatch ? nameMatch[0].length : 0));
			return {
				name: unquote(rawName),
				...(collateToken ? { collate: unquote(collateToken) } : {}),
				...(autoincrement ? { autoincrement: true } : {}),
			};
		});
	}
	return undefined;
};

/**
 * Every table-level `[constraint <name>] unique (…)` clause in a
 * `CREATE TABLE`'s text, in declaration order, with each member's own
 * `COLLATE` if it states one.
 *
 * `pragma index_list`/`index_info` report a table-level unique constraint as
 * an automatic index (`origin: 'u'`), but an automatic index has no
 * `sqlite_master.sql` row of its own — only the owning table's does — so a
 * member's collation, like an index member's, can only be recovered from
 * this text (`[F-111]`). A single-column `unique` written on the column
 * itself (`"email" text collate nocase unique`, or plain `... unique`) never
 * matches this pattern at all — there is no parenthesised member list to
 * find — and is left to `parseColumnCollation` on the column, which already
 * covers it.
 */
const parseTableUniqueConstraints = (sql: string): RawUniqueClause[] => {
	const scan = blankLiterals(sql);
	const clauses: RawUniqueClause[] = [];
	// Anchored the same way `columnDefinitionStart` anchors a column: only after
	// a top-level `(` or `,`, so a check constraint's text merely mentioning the
	// word `unique` cannot be mistaken for the clause.
	//
	// All four identifier spellings SQLite accepts for a constraint name —
	// `"…"`, `` `…` ``, `[…]`, and bare — are matched here, the same way
	// `columnDefinitionStart` widened to all four for a column name (`[F-112]`):
	// a pull from a MySQL-origin database can produce `` constraint `u1` unique
	// (…) `` or `constraint [u1] unique (…)`, and matching only the first two
	// forms used to make this whole clause invisible, silently downgrading its
	// members' collations the same way a missed clause always does.
	const pattern = /[(,]\s*(?:constraint\s+("(?:[^"]|"")+"|`[^`]*`|\[[^\]]*\]|\w+)\s+)?unique\s*\(/gi;
	const depths = computeDepths(scan);

	for (const match of scan.matchAll(pattern)) {
		// Depth 1 is directly inside the table's own column-list parens — the
		// same level `findColumnDefinitionAnchor` requires for a column boundary,
		// checked one position past the separator for the same reason (see its
		// comment): the table's own opening `(` is itself still at depth 0.
		if (depths[match.index + 1] !== 1) continue; // not a table-level clause
		const start = match.index + match[0].length;
		let depth = 1;
		let i = start;
		while (i < scan.length && depth > 0) {
			const ch = scan[i];
			if (ch === '"' || ch === '`' || ch === '[') {
				i = skipQuotedIdentifier(scan, i);
				continue;
			}
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			i++;
		}
		if (depth > 0) continue;
		const bodyEnd = i - 1;

		const rawMembers: string[] = [];
		let memberStart = start;
		let nesting = 0;
		for (let j = start; j < bodyEnd;) {
			const ch = scan[j];
			if (ch === '"' || ch === '`' || ch === '[') {
				j = skipQuotedIdentifier(scan, j);
				continue;
			}
			if (ch === '(') nesting++;
			else if (ch === ')') nesting--;
			if (ch === ',' && nesting === 0) {
				rawMembers.push(blankComments(sql.slice(memberStart, j)).trim());
				memberStart = j + 1;
			}
			j++;
		}
		const last = blankComments(sql.slice(memberStart, bodyEnd)).trim();
		if (last.length > 0) rawMembers.push(last);

		const members: RawUniqueMember[] = rawMembers.map((raw) => {
			// Scan `blankLiterals(raw)`, not `raw` itself, for the same reason
			// `parseIndexCollations` does ([F-069]'s class): a string literal in the
			// member text could otherwise contain the word `collate` and be misread
			// as the member's own clause. Quoted *identifiers* are unaffected —
			// `blankLiterals` passes them through verbatim — so the name/collation
			// captured below is still the real text.
			const blanked = blankLiterals(raw);
			const nameMatch = /^\s*("(?:[^"]|"")+"|`[^`]*`|\[[^\]]*\]|\w+)/.exec(blanked);
			const rawName = nameMatch ? nameMatch[1]! : blanked.trim();
			const name = rawName.startsWith('"')
				? rawName.slice(1, -1).replaceAll('""', '"')
				: rawName.startsWith('`')
				? rawName.slice(1, -1)
				: rawName.startsWith('[')
				? rawName.slice(1, -1)
				: rawName;
			// Scanned from *after* the matched name, not the whole member: a quoted
			// identifier that literally contains the word "collate" (e.g. a column
			// named `"collate nocase"`) is still present, verbatim, in `blanked`
			// (`blankLiterals` only blanks string literals, not identifiers), and
			// scanning the whole member misread it as the member's own `COLLATE`
			// clause — the same false-positive class as `[F-069]`.
			const collateMatch = /\bcollate(?:\s+(\w+)|\s*("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]))/i.exec(
				blanked.slice(nameMatch ? nameMatch[0].length : 0),
			);
			const collateToken = collateMatch ? (collateMatch[1] ?? collateMatch[2]) : undefined;
			const collate = collateToken === undefined ? undefined : collateToken.startsWith('"')
				? collateToken.slice(1, -1).replaceAll('""', '"')
				: collateToken.startsWith('`')
				? collateToken.slice(1, -1)
				: collateToken.startsWith('[')
				? collateToken.slice(1, -1)
				: collateToken;
			return { name, ...(collate ? { collate } : {}) };
		});

		clauses.push({ name: match[1] ? unquote(match[1]) : undefined, members });
	}

	return clauses;
};

/**
 * Associates a `pragma index_list` `origin: 'u'` entry (already resolved to
 * its plain column names via `pragma index_info`) with the parsed table-level
 * `unique (…)` clause it came from, by comparing column lists rather than
 * position — a named constraint's automatic index is reliably named after it,
 * but an *unnamed* one is `sqlite_autoindex_<table>_<n>`, numbered across
 * every automatic index the table has (primary key included), not just the
 * unique clauses, so declaration order alone cannot be trusted to line the
 * two lists up.
 */
const matchUniqueClause = (
	clauses: readonly RawUniqueClause[],
	used: Set<number>,
	columnNames: readonly string[],
): RawUniqueClause | undefined => {
	for (let i = 0; i < clauses.length; i++) {
		if (used.has(i)) continue;
		const clause = clauses[i]!;
		if (
			clause.members.length === columnNames.length
			// `foldAsciiCase`, not `===`: SQLite resolves an unquoted identifier
			// against the column list case-insensitively (ASCII only), so
			// `unique ("EMAIL" collate nocase)` still refers to a column declared
			// `"email"`. Comparing the raw text left a case-differing member
			// unmatched, silently dropping its `COLLATE`.
			&& clause.members.every((m, mi) => foldAsciiCase(m.name) === foldAsciiCase(columnNames[mi] ?? ''))
		) {
			used.add(i);
			return clause;
		}
	}
	return undefined;
};

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
		// Parsed once per table, regardless of whether the primary key is
		// composite: needed for a composite member's own `collate` (`[F-115]`,
		// below) *and* for the single-column case — a table-level
		// `constraint "pk" primary key ("a" collate nocase)` states its
		// collation on the PK clause's member, not on the column's own
		// definition, so `parseColumnCollation` (which only reads a column's
		// *own* inline `COLLATE`) never sees it. Consulting this unconditionally
		// (not only when `compositePk`) is what recovers that case.
		const pkClause = pkColumns.length > 0 ? parseTablePrimaryKeyClause(createSql) : undefined;
		// Hoisted out of the per-column loop below: `blankLiterals`/
		// `computeDepths` are pure functions of the whole table's `CREATE TABLE`
		// text, not of any one column, so recomputing them for every column
		// (as `hasAutoincrement`/`parseColumnCollation`/`parseGenerated` used to,
		// independently, three times each) redid the same work once per column.
		const tableScan = blankLiterals(createSql);
		const tableDepths = computeDepths(tableScan);
		const tableScanContext = { scan: tableScan, depths: tableDepths };

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
		const uniqueConstraints: Record<string, { name: string; columns: readonly (string | UniqueColumnSnapshot)[] }> =
			{};
		// Parsed once per table: every table-level `[constraint <name>] unique (…)`
		// clause in declaration order, for `[F-111]`'s per-member collation.
		const uniqueClauses = parseTableUniqueConstraints(createSql);
		const usedUniqueClauses = new Set<number>();

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
					.map((m, i) => {
						const isExpression = m.name === null;
						return {
							...(isExpression
								? { expression: rawColumns?.[i] ?? '', isExpression: true as const }
								: { expression: m.name!, isExpression: false as const }),
							// An expression member's text (recovered above via
							// `parseIndexColumns`) already carries its own `desc`/`collate`
							// verbatim — `sql\`lower("a") desc\`` is stored, and re-parsed,
							// as `"lower(\"a\") desc"`. Attaching `index_xinfo`'s `desc`/`coll`
							// on top of that duplicated the modifier: `createIndexFromSnapshot`
							// rendered `lower("a") desc desc` (a syntax error), and even before
							// that the schema side (`decorateIndexColumn`, which only
							// recognises a bare quoted identifier) never attaches either for a
							// genuine expression, so the two sides could never converge —
							// `check`/`push`/`generate` all looped on a no-op-turned-rebuild
							// forever (`[F-068]`, a regression: `main` skipped this correctly
							// because it only decorated the `cid !== -2` branch).
							...(!isExpression && m.desc === 1 ? { desc: true } : {}),
							...(!isExpression && collations?.[i] ? { collate: collations[i] } : {}),
						};
					})
					.filter((c) => c.expression !== '');

			if (index.origin === 'pk') continue;
			if (index.origin === 'u') {
				// `sqlite_autoindex_*`/a named constraint's automatic index has no
				// `sqlite_master.sql` row of its own, so a member's `COLLATE` — legal
				// only in the *table-level* `unique (col collate x)` idiom, since a
				// column-level `unique` combined with `collate` is captured on the
				// column itself via `parseColumnCollation` — has to come from the
				// owning `CREATE TABLE` text, matched up by its column list
				// (`[F-111]`).
				const plainNames = memberColumns.map((c) => c.expression);
				const clause = matchUniqueClause(uniqueClauses, usedUniqueClauses, plainNames);
				uniqueConstraints[index.name] = {
					name: index.name,
					columns: plainNames.map((n, i) => {
						const collate = clause?.members[i]?.collate;
						return collate ? { name: n, collate } : n;
					}),
				};
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
			// SQLite makes a lone primary key `NOT NULL` structurally only when it
			// is the rowid alias — a column declared with the *exact* type
			// `INTEGER` (case-insensitive; `INT`, `BIGINT` etc. do not qualify,
			// same rule `ColumnBuilder.primaryKey()`'s `hasDefault` uses on the
			// schema side, `src/schema/columns.ts:423`). Any other single-column
			// primary key (`TEXT PRIMARY KEY`, say) can legally hold `NULL`, and
			// `pragma table_info`'s own `notnull` already says so correctly — it
			// was being overridden by `|| single` regardless of type. Forcing
			// `not null` onto it here made `createTableFromSnapshot` emit a
			// constraint the live table never had, and the rebuild it drove failed
			// with `NOT NULL constraint failed` the moment a `NULL` row existed
			// (`[F-114]`).
			const isRowidAlias = single && column.type.trim().toLowerCase() === 'integer';
			const generated = column.hidden === 2 || column.hidden === 3
				// The pragma says *that* it is generated and with which storage;
				// only the expression has to come out of the CREATE TABLE text.
				? {
					as: parseGenerated(createSql, column.name, tableScanContext)?.as ?? '',
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
				notNull: column.notnull === 1 || isRowidAlias,
				autoincrement: single
					&& hasAutoincrement(createSql, column.name, { ...tableScanContext, pkClause }),
				// A single-column UNIQUE constraint is reported as an index; it is
				// recorded there rather than duplicated onto the column.
				unique: false,
				// `pragma table_info` strips the parens off an expression default;
				// the snapshot keeps the spelling that `CREATE TABLE` accepts, so
				// every consumer of a snapshot gets a usable one.
				default: column.dflt_value === null ? undefined : defaultExpression(column.dflt_value),
				generated,
				references: undefined,
				collate: parseColumnCollation(createSql, column.name, tableScanContext),
			};
		}

		const compositePrimaryKeys: Record<string, { name: string; columns: readonly (string | UniqueColumnSnapshot)[] }> =
			{};
		// A table-level `primary key (…)` clause whose members carry an explicit
		// `collate` needs the arity-1 (single-column) case too, not only the
		// `compositePk` (arity>=2) one below: SQLite scopes a member's own
		// `COLLATE` to the primary key's own automatic index, never to the
		// column's declared collation (unlike a column-level `col type primary
		// key collate x`, which *does* declare it on the column). Folding it
		// into `column.collate` used to make `createTableFromSnapshot` emit
		// `"a" TEXT collate nocase primary key` — a column-level COLLATE, which
		// governs every comparison and index over the column, not the
		// table-level `constraint … primary key ("a" collate nocase)` the live
		// table actually has, and the two can return different query results.
		// Recording it here instead, the same way the arity>=2 branch already
		// does, makes `createTableFromSnapshot` render it on the PK clause
		// (`hasCompositePk` there turns off the column's own inline `primary
		// key`, so this table-level clause is the only place it is emitted).
		if (compositePk || pkClause) {
			const name = `${row.name}_pk`;
			// `[F-115]`: a composite primary key member can carry its own
			// `collate`, exactly like a unique constraint member (`[F-111]`) — see
			// `parseTablePrimaryKeyClause` (`pkClause`, parsed once per table
			// above). Matched to `pkColumns` by position: a table has at most one
			// primary-key clause, so there is nothing to disambiguate by
			// column-list matching the way `matchUniqueClause` does.
			const members = pkColumns.map((c, i) => {
				const collate = pkClause?.[i]?.collate;
				return collate ? { name: c.name, collate } : c.name;
			});
			// For the single-column case, `pkClause` is only defined when the DDL
			// actually used the table-level `primary key (…)` clause shape
			// (`parseTablePrimaryKeyClause` never matches a column-level inline
			// `primary key`) — so only add this entry when that member states a
			// `collate`; otherwise leave the column-level rendering (`single &&
			// column.primaryKey`, `createTableFromSnapshot`) as the faithful,
			// simpler round-trip it already was.
			// `collate binary` is SQLite's default and semantically inert — folding
			// it into an arity-1 entry here would suppress the column-level
			// `primary key`/`autoincrement` rendering below for no behavioural gain
			// (and previously dropped `autoincrement` outright, since the PK-clause
			// render never re-emitted it). Only a genuinely non-default collation
			// justifies the table-level clause for a single-column PK.
			if (compositePk || members.some((m) => typeof m !== 'string' && m.collate !== 'binary')) {
				compositePrimaryKeys[name] = { name, columns: members };
			}
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
