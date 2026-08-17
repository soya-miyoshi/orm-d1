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
 * Any of SQLite's four identifier spellings, as a regex alternation source —
 * for splicing into a larger pattern, not for standalone use. A hand-written
 * migration is not obliged to use the kit's own double-quoted spelling, and
 * `alter table orders rename to sales;` (bare, no quotes at all) is completely
 * ordinary SQL. Two call sites used to recognise only `"…"`, which is why a
 * bare-identifier rename could sail past the foreign-trigger guard with no
 * refusal (see the callers below).
 */
export const IDENTIFIER_SOURCE =
	'"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*';

/**
 * Strip one of the four spellings down to the bare name, undoing whichever
 * escape that spelling uses. A bare identifier has nothing to strip.
 */
export function normalizeIdentifierToken(token: string): string {
	if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
		return token.slice(1, -1).replaceAll('""', '"');
	}
	if (token.length >= 2 && token.startsWith('`') && token.endsWith('`')) {
		return token.slice(1, -1).replaceAll('``', '`');
	}
	if (token.length >= 2 && token.startsWith('[') && token.endsWith(']')) {
		return token.slice(1, -1);
	}
	return token;
}

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
			`^\\s*alter\\s+table\\s+"${escapeRegExpChars(tempName)}"\\s+rename\\s+to\\s+"((?:[^"]|"")+)"`,
			'i',
		);

		let end = createIndex;
		let finalName: string | undefined;
		for (let j = createIndex + 1; j < statements.length; j++) {
			const renameMatch = renamePattern.exec(statements[j]!);
			if (renameMatch) {
				end = j;
				finalName = renameMatch[1]!;
				break;
			}
		}

		// `recreateTable` (`diff.ts`) does not stop at the rename: it restores
		// the rebuilt table's indexes and, if the table is append-only, its
		// guard trigger *after* the rename — that is how the rebuild puts the
		// constraints back. Those statements are what actually re-create a
		// `unique()` index dropped along with the old table, so a batch
		// boundary landing between the rename and them is exactly as unsafe as
		// one landing before the rename: a `[100, 2]` split can commit the
		// rename in batch 1 and lose the trailing `create unique index` to a
		// batch-2 failure, with the table looking rebuilt and the constraint
		// simply gone. Extend the group through every statement immediately
		// following the rename that creates an index or trigger "on" the
		// rebuilt table's final name — the exact shape `recreateTable` emits —
		// and stop at the first statement that is not one of those.
		if (finalName !== undefined) {
			const tailPattern = new RegExp(
				`^\\s*create\\s+(?:unique\\s+index|index|trigger)\\b[\\s\\S]*\\son\\s"${
					escapeRegExpChars(finalName)
				}"`,
				'i',
			);
			let k = end + 1;
			while (k < statements.length && tailPattern.test(statements[k]!)) {
				end = k;
				k++;
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
const createTableNamePattern = new RegExp(`^\\s*create\\s+table\\s+(${IDENTIFIER_SOURCE})`, 'i');

export function tablesRebuiltIn(statements: readonly string[]): string[] {
	const names: string[] = [];
	for (const statement of statements) {
		const match = createTableNamePattern.exec(statement);
		if (!match) continue;
		const name = normalizeIdentifierToken(match[1]!);
		if (name.startsWith('__new_')) names.push(name.slice('__new_'.length));
	}
	return names;
}

/** The atomic runs (rebuild groups, or singleton statements) `statements` breaks into. */
function statementRuns(statements: readonly string[]): string[][] {
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
	return runs;
}

function assertRunsFit(runs: readonly (readonly string[])[], maxPerBatch: number): void {
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
}

/**
 * Split `statements` into batches of at most `maxPerBatch`, without ever
 * splitting a group `statementGroups` says must stay together — a group
 * larger than the limit cannot be packed safely at all, so it is refused
 * outright rather than split.
 */
export function packIntoBatches(statements: readonly string[], maxPerBatch: number): string[][] {
	const runs = statementRuns(statements);
	assertRunsFit(runs, maxPerBatch);

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

/**
 * Same packing as {@link packIntoBatches}, plus one more statement —
 * `applyMigration`'s `insert into "d1_migrations"` record — that must ride
 * along with real statements rather than ever becoming a batch of its own
 * when there is any way to avoid it.
 *
 * A record batched separately by appending it *after* `packIntoBatches` has
 * already closed the last batch only avoids its own trailing batch when that
 * last batch happens to have a free slot — whenever the real statements
 * exactly fill it (a batch boundary indistinguishable from any other, and
 * common at any multiple of `maxPerBatch`), the record still lands alone.
 * If that lone batch is the one that fails, the schema change it followed
 * already applied but was never recorded, and the retry dies on `table …
 * already exists` with no way to mark the migration done.
 *
 * So when the last batch is exactly full, its last run is shifted out into a
 * new batch together with `trailer` instead — moving a run never splits it,
 * and a run that already fit in one batch plus one more statement fits in
 * `maxPerBatch` unless that run alone *is* `maxPerBatch`, the one case
 * nothing can be done about (the trailer is left alone rather than growing
 * the batch past the ceiling).
 */
export function packStatementsWithTrailer(
	statements: readonly string[],
	trailer: string,
	maxPerBatch: number,
): string[][] {
	const runs = statementRuns(statements);
	assertRunsFit(runs, maxPerBatch);

	const batchRuns: string[][][] = [];
	let current: string[][] = [];
	let currentLen = 0;
	for (const run of runs) {
		if (currentLen > 0 && currentLen + run.length > maxPerBatch) {
			batchRuns.push(current);
			current = [];
			currentLen = 0;
		}
		current.push(run);
		currentLen += run.length;
	}
	if (current.length > 0) batchRuns.push(current);

	if (batchRuns.length === 0) {
		return [[trailer]];
	}

	const last = batchRuns[batchRuns.length - 1]!;
	const lastLen = last.reduce((sum, run) => sum + run.length, 0);
	if (lastLen + 1 <= maxPerBatch) {
		last.push([trailer]);
	} else {
		const shifted = last.pop()!;
		if (shifted.length + 1 <= maxPerBatch) {
			batchRuns.push([shifted, [trailer]]);
		} else {
			// The shifted run alone already fills a batch — nothing to gain by
			// moving it, so restore it and give the trailer its own batch.
			last.push(shifted);
			batchRuns.push([[trailer]]);
		}
	}

	return batchRuns.map((runsInBatch) => runsInBatch.flat());
}

/**
 * Look a key up in a map the way SQLite compares identifiers: case-sensitively
 * first (the common, cheap case), falling back to a case-insensitive scan.
 * `sqlite_master.tbl_name` is stored exactly as `CREATE TRIGGER` spelled it,
 * and identifiers are case-insensitive — so a hand-written trigger can be
 * attached to a table under a different spelling than the schema uses
 * (`Orders` in the trigger, `orders` in the schema). A plain `map[key]` lookup
 * makes that trigger invisible to the foreign-trigger guard.
 */
export function lookupCaseInsensitive<T>(map: Record<string, T> | undefined, key: string): T | undefined {
	if (!map) return undefined;
	if (Object.hasOwn(map, key)) return map[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(map)) {
		if (k.toLowerCase() === lower) return map[k];
	}
	return undefined;
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
