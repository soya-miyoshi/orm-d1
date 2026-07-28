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
		const opens = (current.match(/\b(begin|case)\b/gi) ?? []).length;
		const closes = (current.match(/\bend\b/gi) ?? []).length;
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
