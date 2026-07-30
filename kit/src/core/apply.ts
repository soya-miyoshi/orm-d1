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
import { isAppendOnlyTrigger, isInternalTable, snapshotFromIntrospection } from './introspect.js';
import type { Snapshot } from './snapshot.js';
import {
	applicableStatements,
	createMigrationsTable,
	MIGRATIONS_TABLE,
	packIntoBatches,
	quoteIdentifier,
	tablesRebuiltIn,
} from './sql.js';

export interface SqlRunner {
	/** Run a read query and return its rows. */
	all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	/** Run statements atomically. On D1 this is one `batch()`. */
	batch(statements: readonly string[]): Promise<void>;
}

/** D1 caps a batch; beyond it atomicity is lost and the caller must be told. */
export const MAX_STATEMENTS_PER_BATCH = 100;

/**
 * On `--remote`, every `all()` is a real HTTP call to `api.cloudflare.com`.
 * `Promise.all` over every table (and then every index) fires them all at
 * once — hundreds of simultaneous requests on a large schema, well past what
 * a single-origin HTTP client keeps open, and a single 429 from Cloudflare
 * aborts the whole `introspect()` since the remote runner does not retry.
 * The local Miniflare path and the workerd D1 binding used in tests have no
 * such limit, so this only bites `--remote`, but the cap applies everywhere
 * for one code path. Kept inline (not a dependency): `kit/src/core/` stays
 * Node-free and filesystem-free.
 */
const MAX_CONCURRENT_INTROSPECT_CALLS = 12;

/**
 * A global gate on how many `fn` calls run at once, independent of how they
 * are dispatched (a flat map, or — as here — a per-table map that itself
 * dispatches a per-index map). Without a single shared gate, nesting two
 * pools with the same per-pool limit multiplies rather than bounds: 12
 * concurrent tables each opening 12 concurrent index calls is 144 in flight,
 * not 12. `run` queues the call instead of starting it once `limit` are
 * already in flight, and releases its slot to the next queued call when it
 * settles (success or failure).
 */
class ConcurrencyGate {
	private inFlight = 0;
	private readonly queue: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	async run<R>(fn: () => Promise<R>): Promise<R> {
		if (this.inFlight >= this.limit) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			this.queue.shift()?.();
		}
	}
}

export interface ApplyResult {
	readonly applied: readonly string[];
	/** Set when a migration had to be split, which loses atomicity across it. */
	readonly warnings: readonly string[];
}

/**
 * @param foreignTriggers Out-param, populated (keyed by `tbl_name`) with the
 * name of every trigger found that is not the append-only guard — kept
 * separate from `Snapshot`/`TableSnapshot` rather than added as a field,
 * since those shapes are exported and schema-facing. `recreateTable` refuses
 * a rebuild that would silently drop one of these; see `diff.ts`.
 */
export async function introspect(runner: SqlRunner, foreignTriggers?: Record<string, string[]>): Promise<Snapshot> {
	// Triggers are read too: the append-only guard is a trigger, and leaving it
	// out of `master` made every guarded table look unguarded, so `check`
	// reported drift and `push` re-emitted the trigger on every run.
	const master = await runner.all<MasterRow>(
		"select type, name, tbl_name, sql from sqlite_master where type in ('table', 'index', 'trigger')",
	);

	if (foreignTriggers) {
		for (const row of master) {
			if (row.type !== 'trigger' || !row.sql) continue;
			if (isAppendOnlyTrigger(row.sql, row.tbl_name)) continue;
			(foreignTriggers[row.tbl_name] ??= []).push(row.name);
		}
	}

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

	const gate = new ConcurrencyGate(MAX_CONCURRENT_INTROSPECT_CALLS);

	// Dispatching all tables' async work up front costs nothing by itself —
	// only the `gate.run` calls below actually start a pragma query, so this
	// `Promise.all` is what makes the *iteration* concurrent while the shared
	// gate is what bounds how many real network calls are in flight at once.
	await Promise.all(tableRows.map(async (row) => {
		const quoted = `"${row.name.replaceAll('"', '""')}"`;

		// `table_xinfo`, not `table_info`: the latter omits generated columns
		// completely, so a schema with one drifted against itself forever.
		const [xinfo, fks, indexes] = await Promise.all([
			gate.run(() => runner.all<TableInfoRow>(`pragma table_xinfo(${quoted})`)),
			gate.run(() => runner.all<ForeignKeyRow>(`pragma foreign_key_list(${quoted})`)),
			gate.run(() => runner.all<IndexListRow>(`pragma index_list(${quoted})`)),
		]);
		tableInfo[row.name] = xinfo;
		foreignKeys[row.name] = fks;
		indexList[row.name] = indexes as never;

		for (const index of indexes) indexInfo[index.name] = [];
		await Promise.all(indexes.map((index) =>
			gate.run(async () => {
				indexInfo[index.name] = await runner.all(`pragma index_info("${index.name.replaceAll('"', '""')}")`);
			})));
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

	// Batched by whole rebuild groups, never mid-group — a `create table
	// "__new_X"` … `alter table "__new_X" rename to "X"` split across two
	// batches used to be able to commit the drop of "X" in one batch and then
	// fail the rename in the next, leaving the table gone. `packIntoBatches`
	// throws outright if a single group cannot fit in one batch, rather than
	// splitting it.
	const batches = packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH);

	// The migrations-table insert is never its own trailing batch — it rides
	// along with the last batch of real statements so a split migration still
	// records itself in the same atomic unit as its final effect, wherever
	// that unit's boundary falls.
	if (batches.length === 0) {
		batches.push([record]);
	} else {
		const last = batches[batches.length - 1]!;
		if (last.length < MAX_STATEMENTS_PER_BATCH) {
			batches[batches.length - 1] = [...last, record];
		} else {
			batches.push([record]);
		}
	}

	if (batches.length > 1) {
		warnings.push(
			`Migration "${tag}" has ${statements.length} statements and must be split into ${batches.length} `
				+ `batches of up to ${MAX_STATEMENTS_PER_BATCH}. Atomicity is lost at each split; if it fails `
				+ 'part-way, the database is left between states.',
		);
	}

	for (const batch of batches) await runner.batch(batch);
	return warnings;
}

/**
 * Refuse to apply any pending migration that would rebuild a table carrying
 * a foreign (non-kit-authored) trigger — the same refusal `recreateTable`
 * (`diff.ts`) applies to `push`/`check`/`verify`, but those all diff a live
 * introspection against the schema, where `generate`'s output never does:
 * a migration file is generated offline, with no DB connection, so it
 * cannot know at generation time whether the table it will later rebuild has
 * since grown a foreign trigger. `migrate` is the only place this can be
 * caught — against a live introspection, right before applying, using the
 * same `__new_<table>` marker `packIntoBatches` already recognises to name
 * which table a flattened statement sequence rebuilds.
 */
export async function checkForeignTriggerConflicts(
	runner: SqlRunner,
	migrations: readonly { tag: string; sql: string }[],
): Promise<void> {
	const foreignTriggers: Record<string, string[]> = {};
	await introspect(runner, foreignTriggers);
	if (Object.keys(foreignTriggers).length === 0) return;

	for (const migration of migrations) {
		const statements = applicableStatements(migration.sql);
		for (const table of tablesRebuiltIn(statements)) {
			const triggers = foreignTriggers[table];
			if (!triggers || triggers.length === 0) continue;
			throw new Error(
				`Migration "${migration.tag}" would rebuild "${table}", but it carries trigger(s) `
					+ `${triggers.map((t) => `"${t}"`).join(', ')} that d1zzle did not create. Rebuilding drops `
					+ 'the table, which drops those triggers with it, and there is no way to reproduce a trigger '
					+ 'd1zzle does not know the definition of. Drop the trigger, recreate it by hand after this '
					+ 'migration runs, or bring it into the schema so d1zzle can carry it across rebuilds.',
			);
		}
	}
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
