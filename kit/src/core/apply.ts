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
import type { ForeignKeyRow, IndexInfoRow, IndexListRow, TableInfoRow } from './introspect.js';
import { isAppendOnlyTrigger, isInternalTable, snapshotFromIntrospection } from './introspect.js';
import type { Snapshot } from './snapshot.js';
import {
	applicableStatements,
	createMigrationsTable,
	foldAsciiCase,
	IDENTIFIER_SOURCE,
	lookupCaseInsensitive,
	MIGRATIONS_TABLE,
	normalizeIdentifierToken,
	packStatementsWithTrailer,
	quoteIdentifier,
	tablesRebuiltIn,
} from './sql.js';

export interface SqlRunner {
	/** Run a read query and return its rows. */
	all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	/** Run statements atomically. On D1 this is one `batch()`. */
	batch(statements: readonly string[]): Promise<void>;
	/**
	 * How many of *these* statements this runner can run in one atomic unit.
	 * `Infinity` means no split is needed; a finite number is a hard ceiling
	 * the caller must pack under, accepting that atomicity is lost between
	 * batches.
	 *
	 * It takes the statements because the answer depends on them: the remote
	 * runner sends a batch containing a trigger body through D1's file-import
	 * endpoint, which has no statement ceiling, and only falls back to
	 * `/query`'s ceiling when it can use `/query` at all. Absent — for a runner
	 * that does not care — means the conservative default below.
	 */
	atomicLimit?(statements: readonly string[]): number;
}

/**
 * The fallback ceiling for a runner that does not declare one.
 *
 * It is `/query`'s limit, not a property of D1 as such: the file-import
 * endpoint has no statement ceiling and the local `node:sqlite` path has real
 * transactions. Keeping the number here — rather than making it the rule —
 * is what lets a runner say "not for these statements, I don't".
 */
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
		// `foreignTriggers` is caller-supplied (an out-param); callers are
		// expected to pass a null-prototype object for the same `[F-078]`
		// reason documented on `checkForeignTriggerConflicts`'s own
		// `foreignTriggers` below — a live table named `constructor` must not
		// resolve to `Object.prototype`'s member instead of `undefined`.
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
				// `index_xinfo`, not `index_info`: the latter reports a DESC- or
				// COLLATE-qualified column exactly like an ordinary one, so the
				// modifier had nowhere to come from. `index_xinfo` additionally
				// appends the rowid tail SQLite adds to a non-unique index for
				// uniqueness — those rows carry `key: 0` and are not indexed
				// columns, so they are filtered out here rather than leaking into
				// the snapshot as extra members.
				const xinfo = await runner.all<IndexInfoRow>(
					`pragma index_xinfo("${index.name.replaceAll('"', '""')}")`,
				);
				indexInfo[index.name] = xinfo.filter((row) => row.key === 1);
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
	//
	// The migrations-table insert rides along with real statements whenever
	// there is any way to make that happen, rather than landing in a trailing
	// batch of its own — a lone `insert into "d1_migrations"` batch is exactly
	// as fragile as any other split (if it is the one that fails, the schema
	// change already applied comes back unrecorded, and the retry dies on
	// "table … already exists" with no way to mark the migration done).
	// `packStatementsWithTrailer` (`sql.ts`) is the packer that actually
	// guarantees this: `packIntoBatches([...statements, record], limit)` looks
	// like it should, since `record` is a singleton run that ought to spill
	// into the previous batch when there is room, but that packing loop only
	// ever starts a *new* batch when a run does not fit in the current one —
	// it never goes back to top up a batch a full-sized run already closed
	// before `record` is reached. So whenever the real statements exactly
	// fill a batch, `record` still lands alone in the next one, identical to
	// always appending it after batching. `packStatementsWithTrailer` shifts
	// the last batch's last run out to make room instead of accepting that.
	//
	// The ceiling comes from the runner, not from a constant here. A migration
	// that goes through file import — or that runs against local SQLite — has
	// no ceiling, and splitting it would give away atomicity for nothing.
	const limit = runner.atomicLimit?.([...statements, record]) ?? MAX_STATEMENTS_PER_BATCH;
	const batches = packStatementsWithTrailer(statements, record, limit);

	if (batches.length > 1) {
		warnings.push(
			`Migration "${tag}" has ${statements.length} statements and must be split into ${batches.length} `
				+ `batches of up to ${limit}. Atomicity is lost at each split; if it fails `
				+ 'part-way, the database is left between states.',
		);
	}

	for (const batch of batches) await runner.batch(batch);
	return warnings;
}

/**
 * A migration's own SQL text carries any `alter table "A" rename to "B"` it
 * performs on a live table — as opposed to the `alter table "__new_X" rename
 * to "X"` that closes out a rebuild, which renames the *temporary* copy into
 * place and says nothing about the table's live identity before this
 * migration ran. Returns post-rename name -> live (pre-rename) name, the same
 * shape `diffSnapshots`'s `liveTableNames` uses and for the same reason: a
 * lookup into `foreignTriggers` (keyed by the live `tbl_name`) has to be
 * resolved back through any rename the migration itself performs, or a
 * `generate --rename-table` plus a rebuild in the same migration makes the
 * rebuilt table invisible to the refusal below.
 */
function renamesInMigration(statements: readonly string[]): Record<string, string> {
	// Null-prototype for the same `[F-078]` reason as `foreignTriggers`/
	// `accumulated` below: `to`/`from` are parsed table names, not internal
	// literals, so `renames['constructor']` must not resolve to
	// `Object.prototype.constructor`.
	const renames: Record<string, string> = Object.create(null) as Record<string, string>;
	// Kit's own `recreateTable` always emits `create table "__new_X"` with the
	// double-quoted spelling, but `renames` below already has to recognise a
	// hand-written rename in any of the four spellings — and a hand-written
	// `create table` (or a rebuild produced by some other tool feeding this
	// same applier) is under no obligation to match kit's own spelling either.
	// Recognising only `"…"` here left `createdAt` unpopulated for any other
	// spelling, which made `isRebuildsOwnClose` below always false and caused
	// the rebuild's own closing rename to be misfiled as a genuine live-table
	// rename — corrupting `accumulated` in `checkForeignTriggerConflicts`
	// silently rather than merely missing a guard. [Finding 1]
	const createPattern = new RegExp(`^\\s*create\\s+table\\s+(${IDENTIFIER_SOURCE})`, 'i');
	// A hand-written or `--rename-table` rename is under no obligation to use
	// the kit's own double-quoted spelling — `alter table orders rename to
	// sales;` (bare, no quotes) is completely ordinary SQL, and used to be
	// invisible to this scan entirely.
	const pattern = new RegExp(
		`^\\s*alter\\s+table\\s+(${IDENTIFIER_SOURCE})\\s+rename\\s+to\\s+(${IDENTIFIER_SOURCE})\\s*$`,
		'i',
	);

	// A rebuild's own closing rename (`"__new_X"` -> `"X"`) is not a live
	// table's identity change; excluding it keeps this map limited to actual
	// `--rename-table` renames, which is all `tablesRebuiltIn`'s post-rename
	// names need resolving through. `from.startsWith('__new_')` used to be the
	// test for that, but a genuine `--rename-table __new_orders=orders_v2` —
	// a real table someone named `__new_orders`, the same case `diff.ts:412`
	// already acknowledges exists — starts with `__new_` too and was wrongly
	// excluded, silently hiding it from the trigger guard. Recording *where*
	// (not just *whether*) this migration created `"__new_X"` fixes the
	// follow-on hole that plain membership reopened: a migration can both
	// genuinely rename a live `__new_orders` *and* separately rebuild `orders`
	// (whose rebuild creates its own `"__new_orders"` scratch table) — after
	// which `createdHere.has('__new_orders')` is true again, for a completely
	// unrelated table, and the genuine rename is discarded a second time.
	// What actually distinguishes the rebuild's own closing rename is BOTH
	// that this migration created `"__new_X"` earlier in the statement list
	// AND that this specific rename's target is `X` (the name with the
	// `__new_` prefix stripped) — the exact shape `recreateTable` emits and
	// nothing else has reason to produce.
	const createdAt = new Map<string, number>();
	statements.forEach((statement, index) => {
		const created = createPattern.exec(statement);
		if (!created) return;
		// Normalized the same way `pattern`'s matches are below, not with the
		// double-quote-specific unescape this used to do — a bare or
		// backtick-/bracket-quoted `create table __new_x` produced a name that
		// never matched `from`'s normalized form, for the same reason.
		const name = normalizeIdentifierToken(created[1]!);
		if (!foldAsciiCase(name).startsWith('__new_')) return;
		const key = foldAsciiCase(name);
		if (!createdAt.has(key)) createdAt.set(key, index);
	});

	statements.forEach((statement, index) => {
		const match = pattern.exec(statement);
		if (!match) return;
		const from = normalizeIdentifierToken(match[1]!);
		const to = normalizeIdentifierToken(match[2]!);
		const strippedTarget = foldAsciiCase(from).startsWith('__new_') ? from.slice('__new_'.length) : undefined;
		const createdIndex = createdAt.get(foldAsciiCase(from));
		const isRebuildsOwnClose = strippedTarget !== undefined && foldAsciiCase(to) === foldAsciiCase(strippedTarget)
			&& createdIndex !== undefined && createdIndex < index;
		if (isRebuildsOwnClose) return;
		renames[to] = from;
	});
	return renames;
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
 *
 * Deliberately not exported from `index.ts` — `applyMigrations` below calls
 * it unconditionally so every caller of the public applier gets the guard
 * without a second public symbol to opt into it.
 *
 * Reads only `sqlite_master`, not the full `introspect()`: everything else
 * `introspect` does (three pragmas per table, one per index) exists to build
 * column/index/FK shape this check never looks at. On a pending migration
 * that cannot rebuild anything, no query at all is issued.
 */
export async function checkForeignTriggerConflicts(
	runner: SqlRunner,
	migrations: readonly { tag: string; sql: string }[],
): Promise<void> {
	const parsed = migrations.map((migration) => {
		const statements = applicableStatements(migration.sql);
		return { tag: migration.tag, renames: renamesInMigration(statements), tables: tablesRebuiltIn(statements) };
	});

	if (parsed.every((migration) => migration.tables.length === 0)) return;

	const master = await runner.all<MasterRow>(
		"select type, name, tbl_name, sql from sqlite_master where type = 'trigger'",
	);
	// Null-prototype: `row.tbl_name` is a live table name straight from
	// `sqlite_master`, so a table named `constructor`/`__proto__`/`toString`
	// (the `[F-078]` class) must not resolve to `Object.prototype`'s own
	// members — a plain `{}` literal made `(foreignTriggers['constructor'] ??=
	// []).push(...)` throw `TypeError: … .push is not a function` instead of
	// recording the trigger.
	const foreignTriggers: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
	for (const row of master) {
		if (!row.sql) continue;
		if (isAppendOnlyTrigger(row.sql, row.tbl_name)) continue;
		(foreignTriggers[row.tbl_name] ??= []).push(row.name);
	}
	if (Object.keys(foreignTriggers).length === 0) return;

	// `migration.renames` only resolves a rename performed *within that one
	// migration file*. A table renamed in an earlier pending migration and
	// then rebuilt in a later one — the ordinary `generate --rename-table`
	// workflow, split across two runs of `generate` the way any two-step
	// schema change is — needs its name resolved back through every rename
	// since the run started, not just the last one. `accumulated` carries
	// that: it maps a name as it exists going into the migration currently
	// being checked to the table's true live name in the database (before
	// this `migrate` run touched anything), and is folded forward after each
	// migration is considered so the next one inherits it.
	// Null-prototype for the same `[F-078]` reason as `foreignTriggers` above:
	// a live table literally named `constructor` would otherwise resolve
	// `accumulated['constructor']` to `Object.prototype.constructor` instead
	// of `undefined`, corrupting the rename chain rather than starting it.
	const accumulated: Record<string, string> = Object.create(null) as Record<string, string>;

	for (const migration of parsed) {
		for (const table of migration.tables) {
			// Both hops below used to be exact-match/case-sensitive lookups while
			// only the final `foreignTriggers` lookup was case-insensitive, and the
			// within-file hop only ever followed one rename, not a chain — two
			// independent ways a real trigger went unguarded. [Finding 4]
			//
			// (a) `alter table orders rename to Sales;` then a rebuild of `sales`
			// (lowercase) in the same file: `migration.renames` is keyed exactly as
			// written (`Sales`), so a case-sensitive `renames[table]` with
			// `table === 'sales'` misses it entirely.
			//
			// (b) A two-hop chain within one migration file — `orders` -> `tmp` ->
			// `sales` — followed by a rebuild of `sales` in that same file.
			// `migration.renames` maps each post-rename name to its immediately
			// preceding name (`renames['sales'] === 'tmp'`, `renames['tmp'] ===
			// 'orders'`); a single lookup stops at `tmp` and never reaches `orders`,
			// the table's actual live identity before this migration ran.
			// `accumulated`'s cross-file fold (below) already walks a chain, but
			// only across *previous* migrations — this walks the chain *within*
			// the current one before handing off to `accumulated`.
			// Both hops below used to be exact-match/case-sensitive lookups while
			// only the final `foreignTriggers` lookup was case-insensitive, and the
			// within-file hop only ever followed one rename, not a chain — two
			// independent ways a real trigger went unguarded. [Finding 4]
			//
			// (a) `alter table orders rename to Sales;` then a rebuild of `sales`
			// (lowercase) in the same file: `migration.renames` is keyed exactly as
			// written (`Sales`), so a case-sensitive `renames[table]` with
			// `table === 'sales'` misses it entirely.
			//
			// (b) A two-hop chain within one migration file — `orders` -> `tmp` ->
			// `sales` — followed by a rebuild of `sales` in that same file.
			// `migration.renames` maps each post-rename name to its immediately
			// preceding name (`renames['sales'] === 'tmp'`, `renames['tmp'] ===
			// 'orders'`); a single lookup stops at `tmp` and never reaches `orders`,
			// the table's actual live identity before this migration ran.
			// `accumulated`'s cross-file fold (below) already walks a chain, but
			// only across *previous* migrations — this walks the chain *within*
			// the current one before handing off to `accumulated`.
			let preMigrationName = table;
			const visited = new Set<string>([preMigrationName]);
			for (;;) {
				const next = lookupCaseInsensitive(migration.renames, preMigrationName);
				if (next === undefined || visited.has(next)) break;
				preMigrationName = next;
				visited.add(next);
			}
			const liveName = lookupCaseInsensitive(accumulated, preMigrationName) ?? preMigrationName;
			// Case-insensitive: `sqlite_master.tbl_name` is stored exactly as the
			// hand-written trigger spelled it, and identifiers are
			// case-insensitive, so a trigger on `Orders` still guards the schema's
			// `orders`. See `lookupCaseInsensitive`.
			const triggers = lookupCaseInsensitive(foreignTriggers, liveName);
			if (!triggers || triggers.length === 0) continue;
			throw new Error(
				`Migration "${migration.tag}" would rebuild "${table}", but it carries trigger(s) `
					+ `${triggers.map((t) => `"${t}"`).join(', ')} that orm-d1 did not create. Rebuilding drops `
					+ 'the table, which drops those triggers with it, and there is no way to reproduce a trigger '
					+ 'orm-d1 does not know the definition of. Drop the trigger, recreate it by hand after this '
					+ 'migration runs, or bring it into the schema so orm-d1 can carry it across rebuilds.',
			);
		}

		// Fold this migration's renames into the running map before moving to
		// the next migration, so a rename here is visible to a rebuild in any
		// later pending migration.
		//
		// Both sides of this fold used to be raw, case-sensitive
		// `Record<string, string>` lookups/writes. `accumulated[from]` missed a
		// seam where one migration's rename target and the next migration's
		// rename source differ only in case (`orders -> Sales` then
		// `sales -> sales_v2`): the chain back to the true live name silently
		// broke, and a rebuild several migrations later became invisible to
		// the guard. [Finding 9]
		//
		// The write side has to be case-insensitive too, and consistently so:
		// if an earlier iteration (of this same loop, or the within-file walk
		// above) already recorded the live table under some case spelling of
		// `to`, reuse that exact key rather than adding a second, differently
		// cased key for the same table — two keys for one table would let
		// later folds see one and miss the other, drifting apart across
		// further renames.
		for (const [to, from] of Object.entries(migration.renames)) {
			const resolved = lookupCaseInsensitive(accumulated, from) ?? from;
			const existingKey = Object.keys(accumulated).find(
				(key) => foldAsciiCase(key) === foldAsciiCase(to),
			);
			accumulated[existingKey ?? to] = resolved;
		}
	}
}

/**
 * Apply a whole set of pending migrations, in order.
 *
 * @param onWarning Called with each split-batch warning as `applyMigration`
 * produces it, in addition to it being collected into the returned
 * `ApplyResult.warnings`. `ApplyResult` is only seen once every migration has
 * resolved, so a caller that only reads the return value never learns about a
 * split on the one run where it matters most: a mid-run failure after the
 * split but before `applyMigrations` returns. Optional so existing callers
 * that only want the final summary are unaffected.
 */
export async function applyMigrations(
	runner: SqlRunner,
	migrations: readonly { tag: string; sql: string }[],
	table = MIGRATIONS_TABLE,
	onWarning?: (warning: string) => void,
): Promise<ApplyResult> {
	await ensureMigrationsTable(runner, table);

	// Unconditional, not opt-in: this is the applier every `applyMigrations`
	// caller goes through (the CLI's `migrate` and any Worker calling the
	// public `orm-d1-kit/core` entry directly), and the guard it replaces
	// used to be bolted onto the CLI command only, which left a direct caller
	// with no protection and no exported symbol to ask for it.
	await checkForeignTriggerConflicts(runner, migrations);

	const applied: string[] = [];
	const warnings: string[] = [];

	for (const migration of migrations) {
		const migrationWarnings = await applyMigration(runner, migration.tag, migration.sql, table);
		for (const warning of migrationWarnings) {
			warnings.push(warning);
			onWarning?.(warning);
		}
		applied.push(migration.tag);
	}

	return { applied, warnings };
}
