/**
 * Splitting a migration file back into statements.
 *
 * Each migration is applied as a single `batch()`, and `batch()` takes
 * statements, not a script — so the split has to be right. Semicolons inside
 * string literals, comments and quoted identifiers are the whole problem.
 *
 * And inside a trigger body, which is the fourth. `CREATE TRIGGER … BEGIN …
 * END` contains statement-terminating semicolons that belong to the trigger,
 * not to the migration: SQLite requires each body statement to end with one.
 * Splitting on them produced a fragment ending at `BEGIN`, which the applier
 * rejected with `incomplete input` — so a migration that created any trigger
 * could not be applied at all.
 */
/**
 * Blank the *contents* of every quoted run — `'…'`, `"…"`, `` `…` `` — keeping
 * the quotes so what is left still parses as SQL for keyword counting. A
 * doubled quote is SQL's escape and closes-then-reopens, which this scan
 * handles by treating the pair as two adjacent runs.
 */
const blankQuoted = (text: string): string =>
	text.replaceAll(
		/'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`(?:[^`]|``)*`?/g,
		(run) => {
			const quote = run[0]!;
			const closed = run.length > 1 && run.endsWith(quote);
			return quote + ' '.repeat(run.length - (closed ? 2 : 1)) + (closed ? quote : '');
		},
	);

export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let quote: '"' | "'" | '`' | undefined;
	let comment: 'line' | 'block' | undefined;
	/**
	 * Inside a trigger body, semicolons are part of the statement.
	 *
	 * Tracked by looking at what has accumulated rather than by counting
	 * BEGIN/END keywords generally: `BEGIN` also starts a transaction, and
	 * `END` appears in `CASE … END`, so a general counter mis-nests on ordinary
	 * SQL. Only a statement that actually started with CREATE TRIGGER opts in.
	 */
	const inTriggerBody = (): boolean => {
		if (!/^\s*create\s+(or\s+replace\s+)?(temp\s+|temporary\s+)?trigger\b/i.test(current)) return false;
		// The body is open until its matching END; `CASE … END` inside it is
		// balanced by its own CASE, so counting both keeps the nesting right.
		//
		// Counted over a copy with quoted text blanked out: the guard trigger's
		// own abort message ends in "…is prohibited", and any message or quoted
		// identifier containing the word `end` (or `begin`, or `case`) would
		// otherwise close the body early and produce the same `incomplete
		// input` this function exists to prevent.
		const scan = blankQuoted(current);
		const opens = (scan.match(/\b(begin|case)\b/gi) ?? []).length;
		const closes = (scan.match(/\bend\b/gi) ?? []).length;
		return opens > closes;
	};

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i]!;
		const next = sql[i + 1];

		if (comment === 'line') {
			if (char === '\n') comment = undefined;
			continue;
		}
		if (comment === 'block') {
			if (char === '*' && next === '/') {
				comment = undefined;
				i++;
			}
			continue;
		}
		if (!quote && char === '-' && next === '-') {
			comment = 'line';
			continue;
		}
		if (!quote && char === '/' && next === '*') {
			comment = 'block';
			i++;
			continue;
		}

		if (quote) {
			current += char;
			if (char === quote) {
				// A doubled quote is an escape, not a terminator.
				if (next === quote) {
					current += next;
					i++;
				} else {
					quote = undefined;
				}
			}
			continue;
		}

		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			current += char;
			continue;
		}

		if (char === ';') {
			if (inTriggerBody()) {
				current += char;
				continue;
			}
			const trimmed = current.trim();
			if (trimmed) statements.push(trimmed);
			current = '';
			continue;
		}

		current += char;
	}

	const trimmed = current.trim();
	if (trimmed) statements.push(trimmed);
	return statements;
}

/**
 * PRAGMA statements are emitted for parity with plain sqlite3 clients. Inside
 * a D1 `batch()` most are unnecessary — the batch is already atomic — and D1
 * rejects some of them, so they are filtered before applying.
 *
 * `defer_foreign_keys` is the exception, and it has to run: D1 will not let a
 * migration turn `foreign_keys` off, so deferring the checks until the batch
 * commits is the only way a table rebuild can drop and rename a referenced
 * table without tripping every constraint pointing at it mid-sequence. It is
 * scoped to the transaction, so it cannot leak into a later one.
 */
const RUNNABLE_PRAGMA = /^\s*pragma\s+defer_foreign_keys\b/i;

export const isPragma = (statement: string): boolean =>
	/^\s*pragma\b/i.test(statement) && !RUNNABLE_PRAGMA.test(statement);

export const applicableStatements = (sql: string): string[] => splitStatements(sql).filter((s) => !isPragma(s));

const escapeRegExpChars = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which statements must land in the same `batch()` or not run at all.
 *
 * By the time a migration is applied, it has already been flattened to plain
 * SQL text (`applicableStatements` on a saved file, or `diff.statements` for
 * `push`) — the `Statement[]` structure `recreateTable` built is gone. So the
 * one rebuild group that cannot be split (`create table "__new_X"` … `alter
 * table "__new_X" rename to "X"`, see `recreateTable` in `diff.ts`) has to be
 * re-recognised from the statement text itself, by the `__new_` marker that
 * survives into the rendered SQL. A directly preceding
 * `PRAGMA defer_foreign_keys` — emitted only to make this specific rebuild
 * safe — is folded into the same group.
 *
 * Returns one group id per statement; equal ids must stay in one batch.
 * Everything outside a recognised rebuild is its own singleton group, so it
 * is always safe to split between any two of them.
 */
export function statementGroups(statements: readonly string[]): number[] {
	const groups: number[] = new Array(statements.length);
	let nextGroup = 0;
	let i = 0;

	while (i < statements.length) {
		// Looked ahead, not behind: a preceding PRAGMA would otherwise already
		// have been consumed into its own singleton group by the time this loop
		// reaches the `create table "__new_X"` that follows it.
		const isPragmaLead = /^\s*pragma\s+defer_foreign_keys\b/i.test(statements[i]!);
		const createIndex = isPragmaLead ? i + 1 : i;
		const createMatch = createIndex < statements.length
			? /^\s*create\s+table\s+"(__new_(?:[^"]|"")+)"/i.exec(statements[createIndex]!)
			: null;

		if (!createMatch) {
			groups[i] = nextGroup++;
			i++;
			continue;
		}

		const tempName = createMatch[1]!;
		const renamePattern = new RegExp(
			`^\\s*alter\\s+table\\s+"${escapeRegExpChars(tempName)}"\\s+rename\\s+to\\s+"`,
			'i',
		);

		let end = createIndex;
		for (let j = createIndex + 1; j < statements.length; j++) {
			if (renamePattern.test(statements[j]!)) {
				end = j;
				break;
			}
		}

		const start = i;
		const group = nextGroup++;
		for (let k = start; k <= end; k++) groups[k] = group;
		i = end + 1;
	}

	return groups;
}

/**
 * Which live table(s) a flattened statement sequence rebuilds, named by the
 * same `__new_<table>` marker `statementGroups` recognises. `migrate` applies
 * pre-generated SQL text with no `Statement[]`/diff structure to consult, so
 * this is how it can still ask "does this migration rebuild a table that
 * carries a foreign trigger?" before running anything.
 */
export function tablesRebuiltIn(statements: readonly string[]): string[] {
	const names: string[] = [];
	for (const statement of statements) {
		const match = /^\s*create\s+table\s+"(__new_(?:[^"]|"")+)"/i.exec(statement);
		if (match) names.push(match[1]!.slice('__new_'.length).replaceAll('""', '"'));
	}
	return names;
}

/**
 * Split `statements` into batches of at most `maxPerBatch`, without ever
 * splitting a group `statementGroups` says must stay together — a group
 * larger than the limit cannot be packed safely at all, so it is refused
 * outright rather than split.
 */
export function packIntoBatches(statements: readonly string[], maxPerBatch: number): string[][] {
	const groupIds = statementGroups(statements);

	const runs: string[][] = [];
	let i = 0;
	while (i < statements.length) {
		const id = groupIds[i];
		let j = i + 1;
		while (j < statements.length && groupIds[j] === id) j++;
		runs.push(statements.slice(i, j));
		i = j;
	}

	for (const run of runs) {
		if (run.length > maxPerBatch) {
			throw new Error(
				`A group of ${run.length} statements that must be applied together (a table rebuild) exceeds the `
					+ `per-batch limit of ${maxPerBatch}. Splitting it across batches risks leaving the database `
					+ 'mid-rebuild — the old table dropped and the new one never renamed into place — if a later '
					+ 'batch fails. Refusing rather than emitting that migration.',
			);
		}
	}

	const batches: string[][] = [];
	let current: string[] = [];
	for (const run of runs) {
		if (current.length > 0 && current.length + run.length > maxPerBatch) {
			batches.push(current);
			current = [];
		}
		current.push(...run);
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Wrangler's own migration bookkeeping table, reused so both appliers agree. */
export const MIGRATIONS_TABLE = 'd1_migrations';

/** Identifiers are config-controlled, not user input — but a name containing
 * a quote would still break the statement silently, so it is escaped. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const createMigrationsTable = (table = MIGRATIONS_TABLE): string =>
	`create table if not exists ${quoteIdentifier(table)} (\n`
	+ '\tid integer primary key autoincrement not null,\n'
	+ '\tname text not null unique,\n'
	+ '\tapplied_at numeric not null default (current_timestamp)\n'
	+ ')';
