/**
 * Applying and introspecting, against whatever database the caller has.
 *
 * Everything here goes through one tiny `SqlRunner` interface, so the same
 * code path serves the local Miniflare file, the remote D1 HTTP API, and a
 * real database inside a workerd test. "One code path for local and remote" is
 * the fix for the drift that makes `drizzle-kit push` behave differently in
 * each — so the interface stays this small on purpose.
 */
import type { IntrospectionInput, MasterRow } from './introspect.js';
import type { ForeignKeyRow, IndexListRow, TableInfoRow } from './introspect.js';
import { isInternalTable, snapshotFromIntrospection } from './introspect.js';
import type { Snapshot } from './snapshot.js';
import { applicableStatements, createMigrationsTable, MIGRATIONS_TABLE, quoteIdentifier } from './sql.js';

export interface SqlRunner {
	/** Run a read query and return its rows. */
	all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	/** Run statements atomically. On D1 this is one `batch()`. */
	batch(statements: readonly string[]): Promise<void>;
}

/** D1 caps a batch; beyond it atomicity is lost and the caller must be told. */
export const MAX_STATEMENTS_PER_BATCH = 100;

export interface ApplyResult {
	readonly applied: readonly string[];
	/** Set when a migration had to be split, which loses atomicity across it. */
	readonly warnings: readonly string[];
}

export async function introspect(runner: SqlRunner): Promise<Snapshot> {
	// Triggers are read too: the append-only guard is a trigger, and leaving it
	// out of `master` made every guarded table look unguarded, so `check`
	// reported drift and `push` re-emitted the trigger on every run.
	const master = await runner.all<MasterRow>(
		"select type, name, tbl_name, sql from sqlite_master where type in ('table', 'index', 'trigger')",
	);

	const tableInfo: IntrospectionInput['tableInfo'] = {};
	const indexList: IntrospectionInput['indexList'] = {};
	const indexInfo: IntrospectionInput['indexInfo'] = {};
	const foreignKeys: IntrospectionInput['foreignKeys'] = {};

	// One pragma round trip per table (and, within a table, per index) used to
	// be sequential — O(tables + indexes) awaits in a row, each one a network
	// hop on remote D1. Every table's three pragmas run concurrently, and once
	// a table's indexes are known, every one of *its* `index_info` pragmas
	// runs concurrently too — two dependent waves total, not one per table.
	// Assignment stays keyed by name, and tables are seeded into the result
	// objects in `master`'s order below before any `await`, so the *iteration*
	// order downstream code sees is what it always was, whichever pragma
	// happens to resolve first.
	const tableRows = master.filter((row) => row.type === 'table' && !isInternalTable(row.name));
	for (const row of tableRows) {
		tableInfo[row.name] = [];
		foreignKeys[row.name] = [];
		indexList[row.name] = [];
	}

	await Promise.all(tableRows.map(async (row) => {
		const quoted = `"${row.name.replaceAll('"', '""')}"`;

		// `table_xinfo`, not `table_info`: the latter omits generated columns
		// completely, so a schema with one drifted against itself forever.
		const [xinfo, fks, indexes] = await Promise.all([
			runner.all<TableInfoRow>(`pragma table_xinfo(${quoted})`),
			runner.all<ForeignKeyRow>(`pragma foreign_key_list(${quoted})`),
			runner.all<IndexListRow>(`pragma index_list(${quoted})`),
		]);
		tableInfo[row.name] = xinfo;
		foreignKeys[row.name] = fks;
		indexList[row.name] = indexes as never;

		for (const index of indexes) indexInfo[index.name] = [];
		await Promise.all(indexes.map(async (index) => {
			indexInfo[index.name] = await runner.all(`pragma index_info("${index.name.replaceAll('"', '""')}")`);
		}));
	}));

	return snapshotFromIntrospection({ master, tableInfo, indexList, indexInfo, foreignKeys });
}

export const ensureMigrationsTable = async (runner: SqlRunner, table = MIGRATIONS_TABLE): Promise<void> => {
	await runner.batch([createMigrationsTable(table)]);
};

/**
 * @param create whether a missing bookkeeping table may be created. `check` is
 * the read-only CI command and passes `false`: creating a table is a write, and
 * a command whose job is to report on a database should not change it — least
 * of all against `--remote`, where it may be running with a read token or
 * against production. An absent table simply means nothing has been applied.
 */
export async function appliedMigrations(
	runner: SqlRunner,
	table = MIGRATIONS_TABLE,
	create = true,
): Promise<string[]> {
	if (create) await ensureMigrationsTable(runner, table);

	try {
		const rows = await runner.all<{ name: string }>(`select name from ${quoteIdentifier(table)} order by id`);
		return rows.map((row) => row.name);
	} catch (cause) {
		// The only expected failure is "no such table", which is not an error
		// here — it is the empty answer.
		if (!create && /no such table/i.test(String(cause))) return [];
		throw cause;
	}
}

/**
 * Apply one migration as a single `batch()` — which D1 executes atomically.
 * This is a real correctness improvement over emitting BEGIN/COMMIT, which D1
 * will not honour.
 */
export async function applyMigration(
	runner: SqlRunner,
	tag: string,
	sql: string,
	table = MIGRATIONS_TABLE,
): Promise<string[]> {
	const warnings: string[] = [];
	const statements = applicableStatements(sql);
	const record = `insert into ${quoteIdentifier(table)} (name) values ('${tag.replaceAll("'", "''")}')`;

	if (statements.length + 1 <= MAX_STATEMENTS_PER_BATCH) {
		await runner.batch([...statements, record]);
		return warnings;
	}

	warnings.push(
		`Migration "${tag}" has ${statements.length} statements and must be split into batches of `
			+ `${MAX_STATEMENTS_PER_BATCH}. Atomicity is lost at each split; if it fails part-way, the `
			+ 'database is left between states.',
	);

	for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
		await runner.batch(statements.slice(i, i + MAX_STATEMENTS_PER_BATCH));
	}
	await runner.batch([record]);
	return warnings;
}

/** Apply a whole set of pending migrations, in order. */
export async function applyMigrations(
	runner: SqlRunner,
	migrations: readonly { tag: string; sql: string }[],
	table = MIGRATIONS_TABLE,
): Promise<ApplyResult> {
	await ensureMigrationsTable(runner, table);
	const applied: string[] = [];
	const warnings: string[] = [];

	for (const migration of migrations) {
		warnings.push(...await applyMigration(runner, migration.tag, migration.sql, table));
		applied.push(migration.tag);
	}

	return { applied, warnings };
}
