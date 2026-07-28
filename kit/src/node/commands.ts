/**
 * The commands. Each one is a plain async function over a `Config` plus flags,
 * so they are callable from a script as well as from the CLI.
 */
import { configureCasing, getTableName, isTable } from 'd1zzle';
import { validateTableOptions } from 'd1zzle/ddl';
import { appliedMigrations, applyMigrations, introspect, MAX_STATEMENTS_PER_BATCH } from '../core/apply.js';
import type { SqlRunner } from '../core/apply.js';
import { applicableStatements, isPragma } from '../core/sql.js';
import { diffSnapshots, renderMigration } from '../core/diff.js';
import type { DiffOptions } from '../core/diff.js';
import { appendEntry, migrationName, migrationTag, nextIndex, pendingMigrations } from '../core/journal.js';
import { snapshotFromSchema, SNAPSHOT_VERSION, typeAffinity } from '../core/snapshot.js';
import type { Snapshot } from '../core/snapshot.js';
import type { Config } from './config.js';
import { localRunner, remoteRunner, scratchRunner } from './runners.js';
import {
	journalPath,
	loadSchema,
	loadTableOptions,
	readJournal,
	readLatestSnapshot,
	readMigration,
	readSnapshot,
	unreadableMigrations,
	writeJournal,
	writeMigration,
	writeSnapshot,
} from './store.js';

export interface CommandContext {
	readonly cwd: string;
	readonly config: Config;
	readonly log: (message: string) => void;
	readonly now: () => number;
}

export interface TargetFlags {
	readonly local?: boolean;
	readonly remote?: boolean;
	readonly acceptDataLoss?: boolean;
	readonly name?: string;
	readonly renames?: DiffOptions;
}

/** Pick the database to act on. Ambiguity here is how the wrong one gets hit. */
export async function resolveRunner(ctx: CommandContext, flags: TargetFlags): Promise<SqlRunner> {
	if (flags.local && flags.remote) throw new Error('Pass either --local or --remote, not both.');

	if (flags.remote) {
		const { accountId, databaseId, token } = ctx.config.d1;
		if (!accountId || !databaseId || !token) {
			throw new Error(
				'--remote needs accountId, databaseId and an API token. Set CLOUDFLARE_ACCOUNT_ID and '
					+ 'CLOUDFLARE_API_TOKEN, or put them in d1zzle.config.ts.',
			);
		}
		return remoteRunner({ accountId, databaseId, token });
	}

	return localRunner(ctx.cwd, ctx.config.d1.databaseName, ctx.config.d1.localFile);
}

export async function snapshotOfSchema(ctx: CommandContext): Promise<Snapshot> {
	if (ctx.config.casing) configureCasing(ctx.config.casing);
	const schema = await loadSchema(ctx.cwd, ctx.config.schema);

	if (!ctx.config.tableOptions) return snapshotFromSchema(schema);

	const options = await loadTableOptions(ctx.cwd, ctx.config.tableOptions);
	const tables = Object.values(schema).filter(isTable);
	const byName = new Map(tables.map((t) => [getTableName(t), t]));

	// Both checks run before anything is generated. `STRICT` with a NUMERIC
	// column and `WITHOUT ROWID` without a primary key are each rejected by D1
	// at CREATE time, and a migration is one atomic batch — so an unvalidated
	// option does not produce a partly-migrated database, it produces a
	// migration file that is reviewed, committed, and then fails on apply.
	const problems: string[] = [];
	for (const [name, perTable] of Object.entries(options.byTable)) {
		const table = byName.get(name);
		if (!table) {
			problems.push(`tableOptions names "${name}", which is not a table in the schema.`);
			continue;
		}
		const problem = validateTableOptions(table, perTable);
		if (problem) problems.push(problem);
	}
	if (problems.length > 0) {
		throw new Error(`Invalid table options:\n  - ${problems.join('\n  - ')}`);
	}

	return snapshotFromSchema(schema, '', options);
}

// ------------------------------------------------------------------ generate

export interface GenerateResult {
	readonly tag: string | undefined;
	readonly sql: string;
	readonly path: string | undefined;
	readonly destructive: readonly string[];
}

export async function generate(ctx: CommandContext, flags: TargetFlags = {}): Promise<GenerateResult> {
	const previous = await readLatestSnapshot(ctx.config.out);
	const next = await snapshotOfSchema(ctx);
	const diff = diffSnapshots(previous, next, flags.renames ?? {});

	if (diff.errors.length > 0) {
		throw new Error(`Cannot generate a safe migration:\n  - ${diff.errors.join('\n  - ')}`);
	}

	const destructive = diff.statements
		.filter((s) => s.destructive)
		.map((s) => s.reason ?? s.sql);

	if (destructive.length > 0 && !flags.acceptDataLoss) {
		throw new Error(
			`This migration would lose data:\n  - ${destructive.join('\n  - ')}\n\n`
				+ 'Re-run with --accept-data-loss if that is intended.',
		);
	}

	// Printed before the "nothing to generate" line, which is exactly the case
	// a constraint rename produces and the one that most needs explaining.
	for (const warning of diff.warnings) ctx.log(`  ! ${warning}`);

	if (diff.statements.length === 0) {
		ctx.log('No schema changes; nothing to generate.');
		return { tag: undefined, sql: '', path: undefined, destructive };
	}

	const journal = await readJournal(ctx.config.out);
	const index = nextIndex(journal);
	const tag = migrationTag(index, flags.name ?? migrationName(index));
	const sql = renderMigration(diff);

	const path = await writeMigration(ctx.config.out, tag, sql);
	await writeSnapshot(ctx.config.out, index, { ...next, id: tag, prevId: previous.id });
	await writeJournal(ctx.config.out, appendEntry(journal, tag, ctx.now()));

	ctx.log(`Wrote ${path} (${diff.statements.length} statements).`);
	for (const warning of destructive) ctx.log(`  ! ${warning}`);
	return { tag, sql, path, destructive };
}

// ------------------------------------------------------------------- migrate

export async function migrate(ctx: CommandContext, flags: TargetFlags = {}): Promise<string[]> {
	const runner = await resolveRunner(ctx, flags);
	const journal = await readJournal(ctx.config.out);
	const applied = await appliedMigrations(runner, ctx.config.migrationsTable);
	const pending = pendingMigrations(journal, applied);

	if (pending.length === 0) {
		// An empty journal is indistinguishable from a fully-applied one, so
		// "nothing pending" is only trustworthy when the folder is also empty of
		// migrations the journal does not know about. A project adopting the kit
		// with migrations in another tool's layout — drizzle-kit writes
		// `<tag>/migration.sql` directories rather than wrangler's flat
		// `<tag>.sql` — would otherwise be told it was up to date while nothing
		// had been applied at all.
		if (journal.entries.length === 0) {
			const unknown = await unreadableMigrations(ctx.config.out);
			if (unknown.length > 0) {
				throw new Error(
					`No migrations are recorded in ${journalPath(ctx.config.out)}, but ${ctx.config.out} contains `
						+ (unknown.length === 1
							? '1 entry that looks like a migration:\n'
							: `${unknown.length} entries that look like migrations:\n`)
						+ unknown.map((f) => `  - ${f}`).join('\n')
						+ '\n\nThe kit reads wrangler\'s flat layout (`<tag>.sql` plus `meta/_journal.json`). '
						+ 'Run `d1zzle-migrate pull` to start from a baseline snapshot of the live database, '
						+ 'or convert the folder to that layout. Refusing to report "up to date" for a database '
						+ 'that may have had nothing applied.',
				);
			}
		}
		ctx.log('Already up to date.');
		return [];
	}

	const migrations = await Promise.all(
		pending.map(async (entry) => ({ tag: entry.tag, sql: await readMigration(ctx.config.out, entry.tag) })),
	);

	const result = await applyMigrations(runner, migrations, ctx.config.migrationsTable);
	for (const warning of result.warnings) ctx.log(`  ! ${warning}`);
	for (const tag of result.applied) ctx.log(`Applied ${tag}.`);
	return [...result.applied];
}

// ---------------------------------------------------------------------- push

export async function push(ctx: CommandContext, flags: TargetFlags = {}): Promise<string[]> {
	const runner = await resolveRunner(ctx, flags);
	const live = await introspect(runner);
	const next = await snapshotOfSchema(ctx);
	const diff = diffSnapshots(live, next, flags.renames ?? {});

	if (diff.errors.length > 0) {
		throw new Error(`Cannot push safely:\n  - ${diff.errors.join('\n  - ')}`);
	}

	const destructive = diff.statements.filter((s) => s.destructive);
	if (destructive.length > 0 && !flags.acceptDataLoss) {
		throw new Error(
			`This push would lose data:\n  - ${destructive.map((s) => s.reason ?? s.sql).join('\n  - ')}\n\n`
				+ 'Re-run with --accept-data-loss if that is intended.',
		);
	}

	for (const warning of diff.warnings) ctx.log(`  ! ${warning}`);

	if (diff.statements.length === 0) {
		ctx.log('Database already matches the schema.');
		return [];
	}

	// Same pragma rule and same batch cap as `applyMigration` — a push that
	// exceeded D1's per-batch limit used to be sent as one oversized batch.
	const statements = diff.statements.map((s) => s.sql).filter((s) => !isPragma(s));

	if (statements.length <= MAX_STATEMENTS_PER_BATCH) {
		await runner.batch(statements);
	} else {
		ctx.log(
			`  ! ${statements.length} statements must be split into batches of ${MAX_STATEMENTS_PER_BATCH}. `
				+ 'Atomicity is lost at each split; if it fails part-way, the database is left between states.',
		);
		for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
			await runner.batch(statements.slice(i, i + MAX_STATEMENTS_PER_BATCH));
		}
	}

	ctx.log(`Pushed ${statements.length} statements.`);
	return statements;
}

// ---------------------------------------------------------------------- pull

export interface PullResult {
	readonly snapshot: Snapshot;
	readonly schema: string;
}

export async function pull(ctx: CommandContext, flags: TargetFlags = {}): Promise<PullResult> {
	const runner = await resolveRunner(ctx, flags);
	const snapshot = await introspect(runner);
	const journal = await readJournal(ctx.config.out);
	const index = nextIndex(journal);
	const tag = migrationTag(index, flags.name ?? migrationName(index));

	// The snapshot has to be journalled, or `nextIndex` hands the same index to
	// the next `generate`, which writes over the pulled baseline and diffs
	// against whatever came before it. The migration file is empty on purpose:
	// the live database is already in this state, so applying it is a no-op
	// that only records the baseline in the migrations table.
	await writeMigration(ctx.config.out, tag, `-- Baseline introspected by d1zzle-migrate pull; nothing to apply.`);
	await writeSnapshot(ctx.config.out, index, { ...snapshot, id: tag });
	await writeJournal(ctx.config.out, appendEntry(journal, tag, ctx.now()));

	const schema = renderSchemaModule(snapshot);
	ctx.log(`Introspected ${Object.keys(snapshot.tables).length} tables.`);
	return { snapshot, schema };
}

/** Turn an introspected snapshot back into a schema module. */
export function renderSchemaModule(snapshot: Snapshot): string {
	// The import list is accumulated rather than fixed: a `blob` column or an
	// index used to be rendered against a name that was never imported, which
	// is a schema module that does not compile.
	const imports = new Set<string>(['sqliteTable']);
	const lines: string[] = ['', ''];

	// A table-level `foreignKey({ foreignColumns: [other.id] })` reads the other
	// table eagerly, so a table has to be declared after the ones it points at.
	// Names are assigned up front, because a foreign key has to refer to the
	// *binding* another table was given, not to a second lossy conversion of
	// its name.
	const ordered = orderByReference(snapshot);
	const usedNames = new Set<string>();
	const tableIds = new Map<string, string>();
	for (const table of ordered) tableIds.set(table.name, uniqueIdentifier(table.name, usedNames));

	const idOf = (tableName: string): string => tableIds.get(tableName) ?? toIdentifier(tableName);

	for (const table of ordered) {
		const identifier = idOf(table.name);
		const usedColumns = new Set<string>();
		const columnIds = new Map<string, string>();
		for (const column of Object.values(table.columns)) {
			columnIds.set(column.name, uniqueIdentifier(column.name, usedColumns));
		}
		const columnId = (columnName: string): string => columnIds.get(columnName) ?? toIdentifier(columnName);

		lines.push(`export const ${identifier} = sqliteTable('${table.name}', {`);

		for (const column of Object.values(table.columns)) {
			// By affinity, so a live column declared `VARCHAR(255)`, `BOOLEAN` or
			// `INT` — anything not written by d1zzle — maps to the factory
			// SQLite would actually give it, rather than collapsing to `text`.
			// `numeric` used to fall through to `text` here despite being one of
			// our own column types.
			const affinity = typeAffinity(column.type);
			const factory = affinity === 'integer'
				? 'integer'
				: affinity === 'real'
				? 'real'
				: affinity === 'blob'
				? 'blob'
				: affinity === 'numeric'
				? 'numeric'
				: 'text';
			imports.add(factory);

			let chain = `${factory}('${column.name}')`;
			if (column.primaryKey) chain += column.autoincrement ? '.primaryKey({ autoIncrement: true })' : '.primaryKey()';
			else if (column.notNull) chain += '.notNull()';
			// Everything below used to be dropped on the floor. The pulled
			// *snapshot* kept it, so the next `generate` diffed a module missing
			// every constraint against a snapshot that had them and emitted
			// statements to tear them all down.
			if (column.unique) chain += '.unique()';
			if (column.generated) {
				imports.add('sql');
				chain += `.generatedAlwaysAs(sql\`${column.generated.as}\`, { mode: '${column.generated.mode}' })`;
			}
			if (column.default !== undefined) {
				imports.add('sql');
				chain += `.default(sql\`${column.default}\`)`;
			}
			if (column.references) {
				const target = column.references;
				chain += `.references(() => ${idOf(target.tableTo)}.${
					columnIdIn(snapshot, target.tableTo, target.columnsTo[0] ?? '')
				}`;
				const actions = [
					...(target.onDelete ? [`onDelete: '${target.onDelete}'`] : []),
					...(target.onUpdate ? [`onUpdate: '${target.onUpdate}'`] : []),
				];
				chain += actions.length > 0 ? `, { ${actions.join(', ')} })` : ')';
			}
			lines.push(`\t${columnId(column.name)}: ${chain},`);
		}

		const extras: string[] = [];

		for (const index of Object.values(table.indexes)) {
			const factory = index.isUnique ? 'uniqueIndex' : 'index';
			imports.add(factory);
			const columns = index.columns.map((c) => `t.${columnId(c)}`).join(', ');
			const where = index.where ? `.where(sql\`${index.where}\`)` : '';
			if (index.where) imports.add('sql');
			extras.push(`${factory}('${index.name}').on(${columns})${where}`);
		}

		for (const pk of Object.values(table.compositePrimaryKeys)) {
			imports.add('primaryKey');
			extras.push(`primaryKey({ columns: [${pk.columns.map((c) => `t.${columnId(c)}`).join(', ')}] })`);
		}

		for (const u of Object.values(table.uniqueConstraints)) {
			imports.add('unique');
			extras.push(`unique('${u.name}').on(${u.columns.map((c) => `t.${columnId(c)}`).join(', ')})`);
		}

		for (const fk of Object.values(table.foreignKeys)) {
			imports.add('foreignKey');
			const columns = fk.columns.map((c) => `t.${columnId(c)}`).join(', ');
			const target = fk.columnsTo
				.map((c) => `${idOf(fk.tableTo)}.${columnIdIn(snapshot, fk.tableTo, c)}`)
				.join(', ');
			let chain = `foreignKey({ columns: [${columns}], foreignColumns: [${target}] })`;
			if (fk.onDelete) chain += `.onDelete('${fk.onDelete}')`;
			if (fk.onUpdate) chain += `.onUpdate('${fk.onUpdate}')`;
			extras.push(chain);
		}

		for (const c of Object.values(table.checkConstraints)) {
			imports.add('check');
			imports.add('sql');
			extras.push(`check('${c.name}', sql\`${c.value}\`)`);
		}

		if (extras.length === 0) {
			lines.push('});', '');
			continue;
		}

		lines.push('}, (t) => [');
		for (const extra of extras) lines.push(`\t${extra},`);
		lines.push(']);', '');
	}

	lines[0] = `import { ${[...imports].sort().join(', ')} } from 'd1zzle';`;

	return lines.join('\n');
}

/** Referenced tables first; cycles fall back to declaration order. */
const orderByReference = (snapshot: Snapshot) => {
	const tables = Object.values(snapshot.tables);
	const byName = new Map(tables.map((t) => [t.name, t]));
	const ordered: typeof tables = [];
	const seen = new Set<string>();

	const visit = (table: typeof tables[number], path: Set<string>): void => {
		if (seen.has(table.name) || path.has(table.name)) return;
		path.add(table.name);
		const references = [
			...Object.values(table.foreignKeys),
			...Object.values(table.columns).map((c) => c.references).filter((r) => r !== undefined),
		];
		for (const fk of references) {
			const target = byName.get(fk.tableTo);
			if (target && target !== table) visit(target, path);
		}
		path.delete(table.name);
		if (seen.has(table.name)) return;
		seen.add(table.name);
		ordered.push(table);
	};

	for (const table of tables) visit(table, new Set());
	return ordered;
};

const toIdentifier = (name: string): string =>
	name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The binding a column in *another* table was given.
 *
 * Recomputed rather than threaded through, because it is only needed for the
 * far side of a foreign key, and it has to agree with what that table emitted.
 */
const columnIdIn = (snapshot: Snapshot, tableName: string, columnName: string): string => {
	const table = snapshot.tables[tableName];
	if (!table) return toIdentifier(columnName);

	const used = new Set<string>();
	for (const column of Object.values(table.columns)) {
		const id = uniqueIdentifier(column.name, used);
		if (column.name === columnName) return id;
	}
	return toIdentifier(columnName);
};

/**
 * Reserved words and globals that cannot be a `const` binding, or that would
 * shadow something the generated module needs.
 */
const RESERVED = new Set([
	'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
	'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
	'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected',
	'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
	'void', 'while', 'with', 'yield',
	// Everything the rendered module imports.
	'blob', 'check', 'foreignKey', 'index', 'integer', 'primaryKey', 'real', 'sql', 'sqliteTable',
	'text', 'unique', 'uniqueIndex',
]);

/**
 * A binding name that is legal, and distinct from the ones already used.
 *
 * `toIdentifier` is lossy — `user_roles`, `userRoles` and `user-roles` all map
 * to `userRoles` — so a database with two of them produced a module with a
 * duplicate `export const`. A table called `new` produced `export const new`.
 * Both are files that do not compile, from a command whose whole job is to
 * write one.
 */
const uniqueIdentifier = (name: string, used: Set<string>): string => {
	const base = toIdentifier(name);
	let candidate = RESERVED.has(base) || !/^[A-Za-z_$]/.test(base) ? `${base}_` : base;

	for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
	used.add(candidate);
	return candidate;
};

// --------------------------------------------------------------------- check

export interface CheckResult {
	readonly pending: readonly string[];
	readonly drift: readonly string[];
	/** Drift that has no safe migration — reported, and still a failure. */
	readonly blocked: readonly string[];
	readonly ok: boolean;
}

/**
 * Drift is the failure mode that actually bites teams: someone runs a manual
 * ALTER against production and the next generated migration is computed from a
 * false baseline. This is the command that catches it, and it exits non-zero.
 */
/**
 * The two kinds of drift, separated from the I/O so they can be tested without
 * a database.
 *
 * `blocked` is drift the differ *refused* to express — a rebuild it cannot do
 * safely produces an error and no statements. Counting only statements meant a
 * parent table whose column type had diverged reported "no drift" and exited
 * 0, in the one command whose entire job is to notice.
 */
export const driftBetween = (
	live: Snapshot,
	expected: Snapshot,
): { drift: string[]; blocked: string[]; warnings: string[] } => {
	const comparison = diffSnapshots(live, expected);
	return {
		drift: comparison.statements.map((s) => s.sql),
		blocked: [...comparison.errors],
		warnings: [...comparison.warnings],
	};
};

export async function check(ctx: CommandContext, flags: TargetFlags = {}): Promise<CheckResult> {
	const journal = await readJournal(ctx.config.out);
	const runner = await resolveRunner(ctx, flags);
	// Read-only: this is the CI command, and it may be pointed at production
	// with a read-only token. Creating the bookkeeping table would be a write.
	const applied = await appliedMigrations(runner, ctx.config.migrationsTable, false);
	const pending = pendingMigrations(journal, applied).map((entry) => entry.tag);

	const live = await introspect(runner);
	const expected = await readLatestSnapshot(ctx.config.out);
	const { drift, blocked, warnings } = driftBetween(live, expected);

	for (const tag of pending) ctx.log(`Unapplied migration: ${tag}`);
	for (const warning of warnings) ctx.log(`  ! ${warning}`);
	for (const statement of drift) ctx.log(`Drift: ${statement}`);
	for (const error of blocked) ctx.log(`Drift (no safe migration): ${error}`);

	const ok = pending.length === 0 && drift.length === 0 && blocked.length === 0;
	if (ok) ctx.log('Up to date, no drift.');

	return { pending, drift, blocked, ok };
}

// -------------------------------------------------------------------- verify

export interface VerifyResult {
	/** Statements that would still be needed — empty when the replay matches. */
	readonly differences: readonly string[];
	/** Structural failures found by SQLite itself. */
	readonly corruption: readonly string[];
	readonly applied: number;
	readonly ok: boolean;
}

/**
 * Replay every migration into an empty database and compare the result with the
 * schema module. Needs no database of its own, so it belongs in CI.
 *
 * This is a different question from {@link check}, and neither subsumes the
 * other:
 *
 * - `check` asks **"does the live database match the snapshot?"** — it catches
 *   drift: an unapplied migration, or someone running `ALTER` by hand.
 * - `verify` asks **"do the migrations still add up to the schema?"** — it
 *   catches a broken *history*, with no database involved at all.
 *
 * The gap `verify` fills is the one that hurts. `generate` writes two artifacts
 * from one diff: the SQL, and the snapshot. Nothing forces them to agree. If
 * the renderer drops a constraint, both artifacts are self-consistent, `check`
 * compares the live database against the snapshot that shares the bug, and CI
 * stays green while the constraint is silently gone. That is not hypothetical:
 * it is exactly how drizzle-kit lost `.unique()` on three tables of a real
 * schema while every check passed.
 *
 * Comparing the *replayed* database against the *schema* — two sources that
 * share no code path with each other — is what closes it.
 */
export async function verify(ctx: CommandContext): Promise<VerifyResult> {
	const journal = await readJournal(ctx.config.out);
	const runner = await scratchRunner();

	// In journal order, which is the order a new environment applies them in.
	// Reading from the journal rather than globbing the folder also means a
	// migration that exists on disk but was never recorded is caught here.
	for (const entry of journal.entries) {
		const sql = await readMigration(ctx.config.out, entry.tag);
		try {
			await runner.batch(applicableStatements(sql));
		} catch (error) {
			return {
				differences: [`${entry.tag} failed to apply: ${(error as Error).message}`],
				corruption: [],
				applied: journal.entries.length,
				ok: false,
			};
		}
	}

	const corruption: string[] = [];
	const fk = await runner.all<Record<string, unknown>>('pragma foreign_key_check');
	if (fk.length > 0) corruption.push(`${fk.length} foreign key violation(s) after replay`);
	const integrity = await runner.all<{ integrity_check: string }>('pragma integrity_check');
	if (integrity[0]?.integrity_check !== 'ok') {
		corruption.push(`integrity_check: ${integrity.map((r) => r.integrity_check).join(', ')}`);
	}

	const replayed = await introspect(runner);
	const expected = await snapshotOfSchema(ctx);
	const diff = diffSnapshots(replayed, expected);

	// Both halves count: a statement means the replay is missing something the
	// schema has, and a refusal means the differ could not even express the gap.
	const differences = [...diff.statements.map((s) => s.reason ?? s.sql), ...diff.errors];

	for (const problem of corruption) ctx.log(`Corrupt: ${problem}`);
	for (const difference of differences) ctx.log(`Mismatch: ${difference}`);

	const ok = differences.length === 0 && corruption.length === 0;
	ctx.log(
		ok
			? `Replayed ${journal.entries.length} migration(s); the result matches the schema.`
			: `Replayed ${journal.entries.length} migration(s); the result does NOT match the schema.`,
	);

	return { differences, corruption, applied: journal.entries.length, ok };
}

// ------------------------------------------------------------------------ up

/** Rewrite snapshots in the current format after a kit version bump. */
export async function up(ctx: CommandContext): Promise<number> {
	const journal = await readJournal(ctx.config.out);
	let migrated = 0;

	// Per entry, not per call: reading the *latest* snapshot inside the loop
	// would have written it over every historical index the moment the version
	// bumped, flattening the history into whatever the newest state was.
	for (const entry of journal.entries) {
		const snapshot = await readSnapshot(ctx.config.out, entry.idx);
		if (!snapshot || snapshot.version === SNAPSHOT_VERSION) continue;
		await writeSnapshot(ctx.config.out, entry.idx, { ...snapshot, version: SNAPSHOT_VERSION });
		migrated++;
	}

	ctx.log(migrated === 0 ? 'Snapshots are already current.' : `Upgraded ${migrated} snapshots.`);
	return migrated;
}
