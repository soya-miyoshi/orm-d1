/**
 * The migration engine against a real D1 database.
 *
 * Unit tests prove the diff engine emits the SQL we intended; these prove the
 * SQL actually runs on D1, that introspecting the result reproduces the
 * schema, and — the test class that catches table-recreation bugs — that data
 * seeded before a migration survives it.
 */
import { env } from 'cloudflare:test';
import { appendOnlyTrigger, createSchema, tableOptions } from 'orm-d1/ddl';
import { integer, primaryKey, real, sql, sqliteTable, text, unique, uniqueIndex } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, appliedMigrations, checkForeignTriggerConflicts, introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { carryForwardCollations, diffSnapshots, renderMigration } from '../../src/core/diff.js';
import { emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sql: string) => (await DB.prepare(sql).all<T>()).results,
	batch: async (statements) => {
		const results = await DB.batch(statements.map((sql) => DB.prepare(sql)));
		results.forEach((result, i) => {
			if (!result.success) throw new Error(`Statement failed: ${statements[i]}`);
		});
	},
};

const dropEverything = async (): Promise<void> => {
	const tables = await runner.all<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_cf\\_%' escape '\\'",
	);
	for (const t of tables) await DB.prepare(`drop table if exists "${t.name}"`).run();
};

const migrateTo = async (before: Snapshot, after: Snapshot, options = {}): Promise<void> => {
	const diff = diffSnapshots(before, after, options);
	expect(diff.errors).toEqual([]);
	await applyMigrations(runner, [{ tag: `m_${Math.random().toString(36).slice(2)}`, sql: renderMigration(diff) }]);
};

/** Compare only what a snapshot can faithfully represent from introspection. */
const comparable = (snapshot: Snapshot) =>
	Object.fromEntries(
		Object.entries(snapshot.tables).map(([name, t]) => [name, {
			columns: Object.fromEntries(
				Object.entries(t.columns).map(([c, column]) => [c, {
					type: column.type,
					notNull: column.notNull,
					primaryKey: column.primaryKey,
					default: column.default,
				}]),
			),
			indexes: Object.fromEntries(
				Object.entries(t.indexes).map(([i, index]) => [i, { columns: index.columns, isUnique: index.isUnique }]),
			),
			compositePrimaryKeys: t.compositePrimaryKeys,
			checkConstraints: t.checkConstraints,
		}]),
	);

beforeEach(dropEverything);

describe('applying generated migrations', () => {
	it('creates a schema from nothing and introspects back to the same shape', async () => {
		const users = sqliteTable('users', {
			id: integer('id').primaryKey({ autoIncrement: true }),
			email: text('email').notNull(),
			score: real('score'),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const target = snapshotFromSchema([users]);
		await migrateTo(emptySnapshot(), target);

		expect(comparable(await introspect(runner))).toEqual(comparable(target));
	});

	it('records what it applied, in wrangler’s own table', async () => {
		const t = sqliteTable('t', { id: integer('id').primaryKey() });
		await applyMigrations(runner, [
			{ tag: '0000_first', sql: renderMigration(diffSnapshots(emptySnapshot(), snapshotFromSchema([t]))) },
		]);

		expect(await appliedMigrations(runner)).toEqual(['0000_first']);
	});

	it('adds a column in place and keeps existing rows', async () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into users (id, email) values (1, 'a@b.c')`).run();

		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
			role: text('role').notNull().default('member'),
		});
		await migrateTo(snapshotFromSchema([before]), snapshotFromSchema([after]));

		const rows = await runner.all('select id, email, role from users');
		expect(rows).toEqual([{ id: 1, email: 'a@b.c', role: 'member' }]);
	});

	it('preserves data through a full table recreation', async () => {
		const before = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
			age: text('age'),
		});
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into users (id, email, age) values (1, 'a@b.c', '30'), (2, 'b@b.c', '40')`).run();

		// Changing a type is the case SQLite cannot ALTER: the table is rebuilt.
		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull().default(''),
			age: integer('age'),
			nickname: text('nickname'),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		await migrateTo(snapshotFromSchema([before]), snapshotFromSchema([after]));

		expect(await runner.all('select id, email, age, nickname from users order by id')).toEqual([
			{ id: 1, email: 'a@b.c', age: 30, nickname: null },
			{ id: 2, email: 'b@b.c', age: 40, nickname: null },
		]);
		// The index went down with the old table and must have been recreated.
		const indexes = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'index' and tbl_name = 'users' and sql is not null",
		);
		expect(indexes.map((i) => i.name)).toEqual(['users_email_idx']);
	});

	it('keeps a COLLATE NOCASE unique index enforcing case-insensitive uniqueness through a table rebuild', async () => {
		// `pragma index_info` cannot see the COLLATE at all, only
		// `index_xinfo` can — so before that fix, a rebuild-forcing diff would
		// recreate this index without it, and the second insert below would
		// stop being rejected.
		const before = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
			age: text('age'),
		}, (t) => [uniqueIndex('users_email_nocase_idx').on(sql`"email" collate NOCASE`)]);
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into users (id, email, age) values (1, 'a@b.c', '30')`).run();
		await expect(DB.prepare(`insert into users (id, email, age) values (2, 'A@B.C', '31')`).run())
			.rejects.toThrow();

		// A type change forces the rebuild.
		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
			age: integer('age'),
		}, (t) => [uniqueIndex('users_email_nocase_idx').on(sql`"email" collate NOCASE`)]);
		await migrateTo(snapshotFromSchema([before]), snapshotFromSchema([after]));

		await expect(DB.prepare(`insert into users (id, email, age) values (3, 'A@B.C', 32)`).run())
			.rejects.toThrow();
	});

	it('rolls a failed migration back completely, because a migration is one batch', async () => {
		const t = sqliteTable('t', { id: integer('id').primaryKey() });
		await migrateTo(emptySnapshot(), snapshotFromSchema([t]));
		await DB.prepare('insert into t (id) values (1)').run();

		await expect(applyMigrations(runner, [{
			tag: 'bad',
			sql: 'create table "ok" ("id" integer);\ninsert into t (id) values (1);',
		}])).rejects.toThrow();

		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name = 'ok'",
		);
		expect(tables).toEqual([]);
	});

	it('drops a table and its rows only when the schema says so', async () => {
		const a = sqliteTable('a', { id: integer('id').primaryKey() });
		const b = sqliteTable('b', { id: integer('id').primaryKey() });
		await migrateTo(emptySnapshot(), snapshotFromSchema([a, b]));
		await migrateTo(snapshotFromSchema([a, b]), snapshotFromSchema([a]));

		expect(Object.keys((await introspect(runner)).tables)).toEqual(['a']);
	});
});

describe('introspection', () => {
	it('reads composite primary keys, foreign keys, checks and partial indexes', async () => {
		for (const statement of [
			'create table "parent" ("id" integer primary key not null)',
			'create table "child" (\n'
				+ '\t"a" integer not null,\n'
				+ '\t"b" text not null,\n'
				+ '\t"score" integer,\n'
				+ '\tconstraint "child_pk" primary key ("a", "b"),\n'
				+ '\tconstraint "child_fk" foreign key ("a") references "parent"("id") on delete cascade,\n'
				+ '\tconstraint "child_score_check" check ("score" >= 0)\n'
				+ ')',
			'create index "child_score_idx" on "child" ("score") where "score" > 0',
		]) {
			await DB.prepare(statement).run();
		}

		const snapshot = await introspect(runner);
		const child = snapshot.tables['child']!;

		expect(child.compositePrimaryKeys['child_pk']!.columns).toEqual(['a', 'b']);
		expect(Object.values(child.foreignKeys)[0]).toMatchObject({
			columns: ['a'],
			tableTo: 'parent',
			columnsTo: ['id'],
			onDelete: 'cascade',
		});
		expect(child.checkConstraints['child_score_check']!.value).toBe('"score" >= 0');
		expect(child.indexes['child_score_idx']).toMatchObject({
			columns: [{ expression: 'score', isExpression: false }],
			isUnique: false,
			where: '"score" > 0',
		});
	});

	it('ignores sqlite and D1 internal tables', async () => {
		await DB.prepare('create table "keep" ("id" integer)').run();
		expect(Object.keys((await introspect(runner)).tables)).toEqual(['keep']);
	});

	it('round-trips the project’s own fixture schema', async () => {
		const { allTables } = await import('../../../test/schema.js');
		for (const statement of createSchema(allTables)) await DB.prepare(statement).run();

		const introspected = await introspect(runner);
		const declared = snapshotFromSchema(allTables);

		expect(Object.keys(introspected.tables).sort()).toEqual(Object.keys(declared.tables).sort());
		for (const name of Object.keys(declared.tables)) {
			expect(Object.keys(introspected.tables[name]!.columns))
				.toEqual(Object.keys(declared.tables[name]!.columns));
		}
	});
});

describe('batching a large migration cannot cut a table rebuild in half (finding 1)', () => {
	it('keeps the rebuilt table intact, with its rows, when a later batch fails', async () => {
		// 95 plain table creates, plus a rebuild of one more table — 6 more
		// statements (pragma, create, insert, drop, rename, unique index) — for
		// 101 total: one over `MAX_STATEMENTS_PER_BATCH` (100), forcing a split.
		// Under the old fixed-stride slicing, the rebuild's `drop table
		// "rebuilt"` and its `alter table "__new_rebuilt" rename to "rebuilt"`
		// would land in different batches.
		//
		// [F-041]: 95, not 96, is deliberate — it is what makes this end-to-end
		// coverage of that finding too. `recreateTable` emits the constraint-
		// restoring `create unique index` *after* the rename, and the old
		// `statementGroups` closed the rebuild's indivisible group right at the
		// rename (5 statements), one statement too early. With exactly 95
		// fillers, 95 + 5 == 100 lands the boundary exactly between the rename
		// and the index create under that old grouping — batch 1 commits the
		// drop-and-rename, batch 2 (index create + the migrations-table record)
		// fails, and the table comes back rebuilt with its UNIQUE constraint
		// silently gone. With the fixed grouping (6 statements, through the
		// index) the whole rebuild lands in batch 2 together, so a batch-2
		// failure loses none of it — table and index either both come back
		// unrebuilt (this test) or both fully rebuilt, never split.
		const before = sqliteTable('rebuilt', {
			id: integer('id').primaryKey(),
			age: text('age'),
			code: text('code'),
		}, (c) => [uniqueIndex('rebuilt_code_idx').on(c.code)]);
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into rebuilt (id, age, code) values (1, '30', 'A')`).run();

		const filler = Array.from({ length: 95 }, (_, i) => sqliteTable(`filler_${i}`, { id: integer('id').primaryKey() }));
		// A type change on "age" forces `recreateTable`'s rebuild path.
		const after = sqliteTable('rebuilt', {
			id: integer('id').primaryKey(),
			age: integer('age'),
			code: text('code'),
		}, (c) => [uniqueIndex('rebuilt_code_idx').on(c.code)]);

		const diff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([...filler, after]));
		expect(diff.errors).toEqual([]);
		const sql = renderMigration(diff);
		// Confirms the fixture actually exercises the >100-statement split this
		// test is about, rather than accidentally fitting in one batch.
		expect(sql.split(';').filter((s) => s.trim()).length).toBeGreaterThan(100);

		// [F-044]: `applyMigrations` issues `ensureMigrationsTable` as its own
		// `batch()` before applying anything, so `calls === 2` was the *first*
		// real batch, not the second — the migration applied zero statements
		// and every assertion below passed against the untouched pre-migration
		// state (`age` still the text `'30'`), never reaching the split this
		// test is named for. `calls === 3` is the actual second real batch.
		let calls = 0;
		const seenBatches: string[][] = [];
		const throwingRunner: SqlRunner = {
			...runner,
			batch: async (statements) => {
				calls++;
				seenBatches.push([...statements]);
				if (calls === 3) throw new Error('simulated failure on the second batch');
				await runner.batch(statements);
			},
		};

		await expect(
			applyMigrations(throwingRunner, [{ tag: 'm_rebuild_split', sql }]),
		).rejects.toThrow(/simulated failure/);

		// [Finding 7a]: `calls === 3` alone only pins *how many* `batch()` calls
		// happened before the throw, not *which* statements were in the batch
		// that failed — so reverting to `calls === 2` (the `ensureMigrationsTable`
		// call this comment already explains was the wrong target) still passed
		// every assertion below unchanged, and so did reverting the grouping fix
		// that keeps the rebuild's tail (its restored index) attached through the
		// rename (`[F-041]`/finding 3): under the old off-by-one grouping, with
		// exactly 95 fillers, the drop-and-rename half of the rebuild happens to
		// land in the batch *before* the one that fails, and the index-create
		// half lands in the one that fails — still "batch 2 fails" by count,
		// even though the rebuild group was split. Pinning the actual contents
		// of the batch at the moment of failure — the *whole* rebuild group,
		// landing together, and *no* part of it in the batch before — closes
		// both gaps: a `calls === 2` revert leaves `seenBatches` with only two
		// entries (`ensureMigrationsTable` and the failing first real batch),
		// so indexing the third fails outright; a broken grouping either splits
		// the rebuild across the two batches asserted below or shifts which one
		// it lands in, and either way fails one of these assertions.
		const firstRealBatch = seenBatches[1]!;
		const failingBatch = seenBatches[2]!;
		expect(firstRealBatch.some((s) => s.includes('rebuilt'))).toBe(false);
		expect(failingBatch.some((s) => s.includes('create table "__new_rebuilt"'))).toBe(true);
		expect(failingBatch.some((s) => s === 'drop table "rebuilt"')).toBe(true);
		expect(failingBatch.some((s) => s === 'alter table "__new_rebuilt" rename to "rebuilt"')).toBe(true);
		expect(failingBatch.some((s) => s.includes('create unique index "rebuilt_code_idx"'))).toBe(true);

		// The rebuild group is 6 statements — far short of the 100-statement
		// cap — so with correct grouping it always lands whole in one batch,
		// and that batch either fully ran (before the injected failure) or
		// never started at all (if the failure landed on an earlier batch).
		// Either way "rebuilt" is never left mid-rebuild — dropped with no
		// "__new_rebuilt" ever renamed into its place — and its row survives
		// either in the old (text) or new (integer) shape, never lost.
		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('rebuilt', '__new_rebuilt')",
		);
		expect(tables.map((t) => t.name)).toEqual(['rebuilt']);
		const rows = await runner.all<{ id: number; age: unknown }>('select id, age from rebuilt');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe(1);
		expect(Number(rows[0]!.age)).toBe(30);

		// [F-041]: the group used to close at the rename, so the trailing
		// `create unique index "rebuilt_code_idx"` — which `recreateTable`
		// emits *after* the rename to restore the constraint the rebuild's
		// `DROP TABLE` took with it — could be split off into a batch of its
		// own and lost to a later failure, with the table looking rebuilt and
		// the UNIQUE constraint simply gone.
		const indexes = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'index' and tbl_name = 'rebuilt' and sql is not null",
		);
		expect(indexes.map((i) => i.name)).toEqual(['rebuilt_code_idx']);
		await DB.prepare(`insert into rebuilt (id, age, code) values (2, 40, 'B')`).run();
		await expect(DB.prepare(`insert into rebuilt (id, age, code) values (3, 41, 'B')`).run())
			.rejects.toThrow();
	});
});

describe('[F-047] applyMigrations calls onWarning as each split-batch warning is produced', () => {
	it('invokes onWarning with the same text collected into ApplyResult.warnings', async () => {
		// Same >100-statement split-forcing shape as "finding 1" above, without
		// a throw: this just has to force `applyMigration` to split into more
		// than one batch, so it emits its split warning.
		const filler = Array.from({ length: 100 }, (_, i) => sqliteTable(`f_${i}`, { id: integer('id').primaryKey() }));
		const diff = diffSnapshots(emptySnapshot(), snapshotFromSchema(filler));
		expect(diff.errors).toEqual([]);
		const sql = renderMigration(diff);

		const seen: string[] = [];
		const result = await applyMigrations(runner, [{ tag: 'm_onwarning', sql }], undefined, (w) => seen.push(w));

		expect(result.warnings.length).toBeGreaterThan(0);
		expect(seen).toEqual([...result.warnings]);
	});
});

describe('a rebuild refuses to silently drop a foreign trigger (finding 2)', () => {
	it('refuses a rebuild-forcing push when the live table carries a trigger orm-d1 did not author, naming it', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		// A hand-written guard: balances may only increase.
		await DB.prepare(
			'create trigger "accounts_no_decrease" before update on "accounts" '
				+ 'when new.balance < old.balance '
				+ "begin select raise(abort, 'balance may not decrease'); end",
		).run();

		await DB.prepare(`insert into accounts (id, balance) values (1, 10)`).run();
		await expect(DB.prepare(`update accounts set balance = 5 where id = 1`).run())
			.rejects.toThrow(/balance may not decrease/);

		// A type change forces the rebuild path.
		const after = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: text('balance') });

		const foreignTriggers: Record<string, string[]> = {};
		const live = await introspect(runner, foreignTriggers);
		const diff = diffSnapshots(live, snapshotFromSchema([after]), { foreignTriggers });

		expect(diff.statements).toEqual([]);
		expect(diff.errors).toHaveLength(1);
		expect(diff.errors[0]).toMatch(/"accounts" has to be recreated/);
		expect(diff.errors[0]).toMatch(/"accounts_no_decrease"/);

		// And the trigger — and the guard it provides — are still there,
		// exactly because nothing was applied.
		await expect(DB.prepare(`update accounts set balance = '5' where id = 1`).run())
			.rejects.toThrow(/balance may not decrease/);
	});
});

describe('migrate refuses to silently drop a foreign trigger (finding 2, bug A)', () => {
	// Unlike `push`/`check`/`verify`, `migrate` applies a migration file that
	// `generate` already wrote offline, with no DB connection and thus no way
	// to have known about a foreign trigger at generation time. The refusal
	// has to happen here, against the live database, right before applying.
	it('refuses to apply a rebuild migration that would drop a foreign trigger the migration file could not have known about', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		// A hand-written guard: balances may only increase.
		await DB.prepare(
			'create trigger "accounts_no_decrease" before update on "accounts" '
				+ 'when new.balance < old.balance '
				+ "begin select raise(abort, 'balance may not decrease'); end",
		).run();

		await DB.prepare(`insert into accounts (id, balance) values (1, 10)`).run();

		// Simulate what `generate` would have written offline: a diff against
		// the schema-only snapshot, with no `foreignTriggers` (it has no DB
		// connection at generation time and so cannot know the trigger exists).
		const after = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: text('balance') });
		const offlineDiff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]));
		expect(offlineDiff.errors).toEqual([]);
		expect(offlineDiff.statements.some((s) => s.sql.includes('__new_accounts'))).toBe(true);

		const migrations = [{ tag: 'm_rebuild', sql: renderMigration(offlineDiff) }];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"accounts_no_decrease"/);

		// And, since the check runs before `migrate` ever applies anything, the
		// trigger — and the guard it provides — is still there.
		await expect(DB.prepare(`update accounts set balance = '5' where id = 1`).run())
			.rejects.toThrow(/balance may not decrease/);
	});
});

describe('a rename in the same migration cannot bypass the foreign-trigger refusal (gap 1)', () => {
	it('resolves the rebuilt table back through the migration\'s own rename before checking for a foreign trigger', async () => {
		const before = sqliteTable('orders', { id: integer('id').primaryKey(), amount: integer('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		// A hand-written trigger orm-d1 did not author, on the live (pre-rename)
		// name.
		await DB.prepare(
			'create trigger "orders_audit" after insert on "orders" '
				+ "begin insert into audit_log (id) values (new.id); end",
		).run();
		await DB.prepare('create table "audit_log" ("id" integer)').run();

		// `generate --rename-table orders=sales` plus a type change: the rename
		// and the rebuild land in the same migration, and `tablesRebuiltIn`
		// names the *post-rename* identity ("sales"), which is not a key
		// `foreignTriggers` (keyed by the live `tbl_name`, "orders") has.
		const after = sqliteTable('sales', { id: integer('id').primaryKey(), amount: text('amount') });
		const offlineDiff = diffSnapshots(
			snapshotFromSchema([before]),
			snapshotFromSchema([after]),
			{ renamedTables: { orders: 'sales' } },
		);
		expect(offlineDiff.errors).toEqual([]);
		expect(offlineDiff.statements.some((s) => s.sql.includes('__new_sales'))).toBe(true);

		const migrations = [{ tag: 'm_rename_and_rebuild', sql: renderMigration(offlineDiff) }];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"orders_audit"/);
		await expect(applyMigrations(runner, migrations)).rejects.toThrow(/"orders_audit"/);

		// Refused before anything ran: the trigger, and the table under its
		// original name, are both still there.
		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('orders', 'sales')",
		);
		expect(tables.map((t) => t.name)).toEqual(['orders']);
		const triggers = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'trigger' and name = 'orders_audit'",
		);
		expect(triggers).toHaveLength(1);
	});
});

describe('a rename in an earlier pending migration cannot bypass the foreign-trigger refusal (F-042)', () => {
	it('folds a rename from an earlier pending migration into the running name map before checking a later rebuild', async () => {
		const before = sqliteTable('orders', { id: integer('id').primaryKey(), amount: integer('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		await DB.prepare(
			'create trigger "orders_audit" after insert on "orders" '
				+ "begin insert into audit_log (id) values (new.id); end",
		).run();
		await DB.prepare('create table "audit_log" ("id" integer)').run();

		// Migration 1: a plain rename, on its own, standing in for what
		// `generate --rename-table orders=sales` would have written.
		const migration1 = { tag: 'm1_rename', sql: 'alter table "orders" rename to "sales";' };

		// Migration 2: a type change forcing a rebuild of "sales" — generated
		// as if "sales" were already the live name, the way `generate` would
		// see it once migration 1 has applied. It carries no `renamedTables` of
		// its own: the rename already happened, in the *other* file.
		const salesBefore = sqliteTable('sales', { id: integer('id').primaryKey(), amount: integer('amount') });
		const salesAfter = sqliteTable('sales', { id: integer('id').primaryKey(), amount: text('amount') });
		const offlineDiff = diffSnapshots(snapshotFromSchema([salesBefore]), snapshotFromSchema([salesAfter]));
		expect(offlineDiff.errors).toEqual([]);
		expect(offlineDiff.statements.some((s) => s.sql.includes('__new_sales'))).toBe(true);
		const migration2 = { tag: 'm2_retype', sql: renderMigration(offlineDiff) };

		const migrations = [migration1, migration2];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"orders_audit"/);
		await expect(applyMigrations(runner, migrations)).rejects.toThrow(/"orders_audit"/);

		// Refused before anything ran: the trigger, and the table under its
		// original name, are both still there.
		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('orders', 'sales')",
		);
		expect(tables.map((t) => t.name)).toEqual(['orders']);
		const triggers = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'trigger' and name = 'orders_audit'",
		);
		expect(triggers).toHaveLength(1);
	});
});

describe('a genuine "__new_"-named table\'s own rename is not mistaken for a rebuild\'s closing rename (F-045)', () => {
	it('still resolves the rebuilt table back through the rename when the renamed table is itself named "__new_orders"', async () => {
		// A real table someone genuinely named `__new_orders` — the same case
		// `diff.ts` already acknowledges exists — carrying a foreign trigger.
		const before = sqliteTable('__new_orders', { id: integer('id').primaryKey(), amount: integer('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		await DB.prepare(
			'create trigger "nn_audit" after insert on "__new_orders" '
				+ "begin insert into audit_log (id) values (new.id); end",
		).run();
		await DB.prepare('create table "audit_log" ("id" integer)').run();

		// `generate --rename-table __new_orders=orders_v2` plus a type change,
		// in the same migration. The rebuild's own scratch table is
		// `__new_orders_v2` — a different name — so this is not the compound
		// case where the rebuild recreates its *own* temp table under the exact
		// name being renamed; it is the plainer case of a genuine table whose
		// name happens to start with `__new_`.
		const after = sqliteTable('orders_v2', { id: integer('id').primaryKey(), amount: text('amount') });
		const offlineDiff = diffSnapshots(
			snapshotFromSchema([before]),
			snapshotFromSchema([after]),
			{ renamedTables: { __new_orders: 'orders_v2' } },
		);
		expect(offlineDiff.errors).toEqual([]);
		expect(offlineDiff.statements.some((s) => s.sql.includes('__new_orders_v2'))).toBe(true);

		const migrations = [{ tag: 'm_rename_and_rebuild', sql: renderMigration(offlineDiff) }];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"nn_audit"/);
		await expect(applyMigrations(runner, migrations)).rejects.toThrow(/"nn_audit"/);

		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('__new_orders', 'orders_v2')",
		);
		expect(tables.map((t) => t.name)).toEqual(['__new_orders']);
		const triggers = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'trigger' and name = 'nn_audit'",
		);
		expect(triggers).toHaveLength(1);
	});
});

describe('a rebuild\'s own scratch table does not swallow a genuine rename of a same-named live table in the same migration (gap 2)', () => {
	it('does not let a rebuild of "orders" elsewhere in the migration hide a genuine rename of live "__new_orders"', async () => {
		// Two live tables: the genuine one named `__new_orders` (carrying a
		// foreign trigger), and an ordinary `orders` that this same migration
		// also happens to rebuild — whose rebuild creates its OWN scratch table
		// under the exact same name, `"__new_orders"`. `createdHere` used to be
		// a plain membership set, so the rebuild's own create re-poisoned it for
		// the unrelated genuine rename below, discarding it a second time.
		const ordersLive = sqliteTable('orders', { id: integer('id').primaryKey(), total: integer('total') });
		const newOrdersLive = sqliteTable('__new_orders', { id: integer('id').primaryKey(), amount: integer('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([ordersLive, newOrdersLive]));

		await DB.prepare(
			'create trigger "nn_audit" after insert on "__new_orders" '
				+ "begin insert into audit_log (id) values (new.id); end",
		).run();
		await DB.prepare('create table "audit_log" ("id" integer)').run();

		// One migration: rename the genuine "__new_orders" to "orders_v2" AND
		// force a rebuild of it too (a type change on "amount"), so it is
		// itself among the tables `tablesRebuiltIn` names — and, separately,
		// force a rebuild of the unrelated live "orders" (a type change on
		// "total"), whose own scratch table is, coincidentally, also named
		// "__new_orders".
		const ordersAfter = sqliteTable('orders', { id: integer('id').primaryKey(), total: text('total') });
		const newOrdersAfter = sqliteTable('orders_v2', { id: integer('id').primaryKey(), amount: text('amount') });
		const offlineDiff = diffSnapshots(
			snapshotFromSchema([ordersLive, newOrdersLive]),
			snapshotFromSchema([ordersAfter, newOrdersAfter]),
			{ renamedTables: { __new_orders: 'orders_v2' } },
		);
		expect(offlineDiff.errors).toEqual([]);
		// The rebuild of "orders" creates its own "__new_orders" scratch table —
		// confirming this migration actually exercises the collision.
		expect(offlineDiff.statements.some((s) => s.sql.includes('create table "__new_orders"'))).toBe(true);

		const migrations = [{ tag: 'm_rename_and_rebuild_both', sql: renderMigration(offlineDiff) }];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"nn_audit"/);
		await expect(applyMigrations(runner, migrations)).rejects.toThrow(/"nn_audit"/);

		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('__new_orders', 'orders_v2')",
		);
		expect(tables.map((t) => t.name)).toEqual(['__new_orders']);
		const triggers = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'trigger' and name = 'nn_audit'",
		);
		expect(triggers).toHaveLength(1);
	});
});

describe('an in-place append-only guard creation refuses to collide with a foreign trigger (gap 2)', () => {
	it('errors naming the foreign trigger instead of emitting an unappliable create trigger', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		// A hand-written trigger that happens to be named exactly what the
		// `appendOnly` guard would be named, but is conditional (`WHEN`) — the
		// anchoring's whole point is that this is NOT mistaken for the guard
		// itself, so introspection correctly classifies it as foreign.
		await DB.prepare(
			'create trigger "accounts_no_update" before update on "accounts" '
				+ 'when new.balance < old.balance '
				+ "begin select raise(abort, 'balance may not decrease'); end",
		).run();

		// The schema now asks for `appendOnly: true` on the same table — a
		// live `false -> true` transition, which fires an in-place `create
		// trigger` rather than a rebuild.
		const after = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });

		const foreignTriggers: Record<string, string[]> = {};
		const live = await introspect(runner, foreignTriggers);
		const diff = diffSnapshots(
			live,
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: true }]])),
			{ foreignTriggers },
		);

		expect(diff.errors).toHaveLength(1);
		expect(diff.errors[0]).toMatch(/"accounts_no_update"/);
		expect(diff.statements.some((s) => /create trigger "accounts_no_update"/.test(s.sql))).toBe(false);

		// Nothing applied: the foreign trigger, and its behavior, are untouched.
		await DB.prepare(`insert into accounts (id, balance) values (1, 10)`).run();
		await expect(DB.prepare(`update accounts set balance = 5 where id = 1`).run())
			.rejects.toThrow(/balance may not decrease/);
	});
});

describe('checkForeignTriggerConflicts avoids a full introspection (gap 4)', () => {
	it('issues no query at all when no pending migration rebuilds anything', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		let calls = 0;
		const countingRunner: SqlRunner = { ...runner, all: async (sql) => { calls++; return runner.all(sql); } };

		// A plain `alter table … add column` never rebuilds anything, so this
		// can never find a foreign trigger regardless of what the table carries
		// — there is nothing for `checkForeignTriggerConflicts` to query for.
		const migrations = [{
			tag: 'm_add_column',
			sql: 'alter table "accounts" add column "note" text;',
		}];

		await checkForeignTriggerConflicts(countingRunner, migrations);
		expect(calls).toBe(0);
	});

	it('issues exactly one query (sqlite_master, not the full introspection) when a migration does rebuild a table', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: integer('balance') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		let calls = 0;
		const countingRunner: SqlRunner = { ...runner, all: async (sql) => { calls++; return runner.all(sql); } };

		const after = sqliteTable('accounts', { id: integer('id').primaryKey(), balance: text('balance') });
		const offlineDiff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]));
		expect(offlineDiff.statements.some((s) => s.sql.includes('__new_accounts'))).toBe(true);

		const migrations = [{ tag: 'm_rebuild', sql: renderMigration(offlineDiff) }];

		await checkForeignTriggerConflicts(countingRunner, migrations);
		// Not the ~4+ queries per table `introspect()` would issue (one
		// `sqlite_master` read, then three pragmas per table plus one per
		// index) — just the one `sqlite_master` read this check actually needs.
		expect(calls).toBe(1);
	});
});

describe('drift detection', () => {
	it('sees a manual ALTER that no migration accounts for', async () => {
		const t = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([t]));

		// Someone ran `wrangler d1 execute` against production.
		await DB.prepare('alter table users add column sneaky text').run();

		const drift = diffSnapshots(await introspect(runner), snapshotFromSchema([t]));
		expect(drift.statements.map((s) => s.sql)).toEqual(['alter table "users" drop column "sneaky"']);
	});

	it('reports no drift when the database matches the schema', async () => {
		const t = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([t]));

		expect(diffSnapshots(await introspect(runner), snapshotFromSchema([t])).statements).toEqual([]);
	});
});

describe('append-only guard offsets survive a length-changing case fold', () => {
	it('recovers the exact appendOnly column list for a table whose name contains Turkish İ', async () => {
		// `appendOnlyTriggerGuard` used to match against `.toLowerCase()`, which
		// (unlike SQLite's own ASCII-only identifier folding) maps Turkish İ
		// (U+0130) to TWO UTF-16 units ('i' + combining dot above, U+0307) —
		// growing the string by one code unit at that point. The column list is
		// then sliced out of the case-preserving `source` at offsets computed
		// against the *folded* text, so every offset past the İ lands one
		// character short, corrupting the recovered column name.
		const table = 'İslem';
		await DB.prepare(`create table "${table}" ("id" integer primary key, "tutar" integer)`).run();
		await DB.prepare(appendOnlyTrigger(table, ['tutar'])).run();

		const live = await introspect(runner);
		expect(live.tables[table]?.appendOnly).toEqual(['tutar']);
	});
});

describe('[F-115] unique constraint member collation carry-forward, against real D1', () => {
	it(
		'does not fabricate a merged constraint out of two distinct unique constraints sharing a column list '
			+ '(F-115 primary fix)',
		async () => {
			// A hand-built live table where "u1" and "u2" cover the same ordered
			// column list ("a", "b") but with different per-member collations.
			// Before the fix, `carryForwardUniqueCollation` re-matched the *same*
			// `after` entry for both `before` constraints (no "used" tracking),
			// depositing both donors' collations onto one fabricated rule.
			await DB.prepare(
				'create table "t" ("a" text, "b" text, "n" text, '
					+ 'constraint "u1" unique ("a", "b" collate nocase), '
					+ 'constraint "u2" unique ("a" collate rtrim, "b"))',
			).run();

			const t = sqliteTable('t', {
				a: text('a'),
				b: text('b'),
				n: integer('n'), // unrelated change: forces a rebuild
			}, (c) => [unique('u1').on(c.a, c.b), unique('u2').on(c.a, c.b)]);

			const before = await introspect(runner);
			const after = snapshotFromSchema([t]);
			const diff = diffSnapshots(before, after);
			expect(diff.errors).toEqual([]);

			const createTemp = diff.statements.find((s) => s.sql.includes('create table "__new_t"'));
			expect(createTemp?.sql).toContain('constraint "u1" unique ("a", "b" collate nocase)');
			expect(createTemp?.sql).toContain('constraint "u2" unique ("a" collate rtrim, "b")');

			await applyMigrations(runner, [{ tag: 'm_f115', sql: renderMigration(diff) }]);

			// Both rows are legal under the real, distinct rules: "u1" folds only
			// "b" to nocase, so ('x ', 'y') and ('x', 'Y') do not collide on it
			// (their "a" differs by a trailing space, and rtrim only strips
			// trailing whitespace when *comparing*, not when storing); "u2" folds
			// only "a" to rtrim, and 'x ' vs 'x' would collide there — proving the
			// two constraints stayed genuinely distinct would require a case that
			// deliberately avoids tripping either, so this checks the weaker but
			// still meaningful invariant: the migration applies at all, and a row
			// that violates neither constraint's real rule inserts cleanly.
			await DB.prepare('insert into "t" ("a", "b", "n") values (\'x\', \'y\', 1)').run();
			await DB.prepare('insert into "t" ("a", "b", "n") values (\'z\', \'Y\', 2)').run();

			const rebuilt = await introspect(runner);
			const uniques = Object.values(rebuilt.tables['t']!.uniqueConstraints);
			expect(uniques).toHaveLength(2);
		},
	);

	it('persists a live unique-member collation past a second `generate` (F-115 sibling fix)', async () => {
		// Models `generate #1` -> `generate #2` off a pulled baseline: the
		// second `generate`'s `before` is whatever the first `generate`
		// persisted, not the live database — so if the persisted snapshot lost
		// the member collation, the second generate re-renders the constraint
		// without it and reports zero drift, even though nothing about the
		// constraint was ever meant to change.
		await DB.prepare(
			'create table "members" ("id" integer primary key, "email" text not null, '
				+ 'constraint "u1" unique ("email" collate nocase))',
		).run();

		const pulledBaseline = await introspect(runner);

		const t1 = sqliteTable('members', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);

		// `generate #1`: diff against the live pull, then persist the new
		// baseline the way `commands.ts`'s `generate` does.
		const diff1 = diffSnapshots(pulledBaseline, snapshotFromSchema([t1]));
		expect(diff1.statements).toEqual([]); // nothing to change yet
		const persisted1 = carryForwardCollations(pulledBaseline, snapshotFromSchema([t1]));
		expect(
			persisted1.tables['members']!.uniqueConstraints['u1']!.columns.map((c) =>
				typeof c === 'string' ? { name: c } : c
			),
		).toEqual([{ name: 'email', collate: 'nocase' }]);

		// `generate #2`: an unrelated schema change forces a rebuild — a column
		// type change, not just an added column (which is an in-place `alter
		// table add column`, never a recreate, and would not exercise this
		// path at all). `before` is `persisted1`, exactly as `commands.ts`
		// would read it back from `meta/`.
		const t2 = sqliteTable('members', {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);
		const diff2 = diffSnapshots(persisted1, snapshotFromSchema([t2]));
		expect(diff2.errors).toEqual([]);

		const createTemp = diff2.statements.find((s) => s.sql.includes('create table "__new_members"'));
		expect(createTemp?.sql).toContain('constraint "u1" unique ("email" collate nocase)');

		await applyMigrations(runner, [{ tag: 'm_f115b', sql: renderMigration(diff2) }]);

		// The collation is still actually enforced after generate #2's
		// migration applies: 'A@X.COM' and 'a@x.com' collide under nocase.
		await DB.prepare('insert into "members" ("id", "email") values (\'m1\', \'A@X.COM\')').run();
		await expect(
			DB.prepare('insert into "members" ("id", "email") values (\'m2\', \'a@x.com\')').run(),
		).rejects.toThrow();
	});

	it('persists a live composite PRIMARY KEY member collation past a second `generate` (Finding 2)', async () => {
		// Same shape as the unique-member sibling above, for a composite
		// primary key member's own collation instead: `generate #1`'s persisted
		// baseline must still carry it, or `generate #2` (diffed against that
		// baseline, not the live database) silently re-renders the PK without
		// it.
		await DB.prepare(
			'create table "memberships" ("club_id" text, "user_id" text, '
				+ 'constraint "memberships_pk" primary key ("club_id" collate nocase, "user_id"))',
		).run();

		const pulledBaseline = await introspect(runner);

		const t1 = sqliteTable('memberships', {
			clubId: text('club_id'),
			userId: text('user_id'),
		}, (c) => [primaryKey({ columns: [c.clubId, c.userId] })]);

		const diff1 = diffSnapshots(pulledBaseline, snapshotFromSchema([t1]));
		expect(diff1.statements).toEqual([]); // nothing to change yet
		const persisted1 = carryForwardCollations(pulledBaseline, snapshotFromSchema([t1]));
		const persistedPk1 = Object.values(persisted1.tables['memberships']!.compositePrimaryKeys)[0]!;
		expect(
			persistedPk1.columns.map((c) => (typeof c === 'string' ? { name: c } : c)),
		).toEqual([{ name: 'club_id', collate: 'nocase' }, { name: 'user_id' }]);

		// `generate #2`: an unrelated column-type change forces a rebuild.
		const t2 = sqliteTable('memberships', {
			clubId: text('club_id'),
			userId: integer('user_id'),
		}, (c) => [primaryKey({ columns: [c.clubId, c.userId] })]);
		const diff2 = diffSnapshots(persisted1, snapshotFromSchema([t2]));
		expect(diff2.errors).toEqual([]);

		const createTemp = diff2.statements.find((s) => s.sql.includes('create table "__new_memberships"'));
		expect(createTemp?.sql).toContain('primary key ("club_id" collate nocase, "user_id")');

		await applyMigrations(runner, [{ tag: 'm_finding2b', sql: renderMigration(diff2) }]);

		// The collation is still actually enforced after generate #2 applies:
		// 'C1' and 'c1' collide under nocase for the same "user_id".
		await DB.prepare('insert into "memberships" ("club_id", "user_id") values (\'C1\', 1)').run();
		await expect(
			DB.prepare('insert into "memberships" ("club_id", "user_id") values (\'c1\', 1)').run(),
		).rejects.toThrow();
	});
});

describe('[F-117 round 4] a table rename beside a guarded-column rename', () => {
	it('keeps the guard in force across the whole migration without reordering the column rename', async () => {
		// `events(id, at)`, `appendOnly: ['at']` -> `audit(id, occurred_at)`,
		// `appendOnly: ['occurred_at']`, with both a table rename and a rename of
		// the very column the guard watches.
		//
		// Round 3 closed the "guard names a column that does not exist yet"
		// window by dragging the `rename column` forward into step 1, ahead of
		// everything — which corrupts the data of any table the same diff also
		// rebuilds (see the next test). Round 4 does it the other way: the guard
		// re-created next to the table rename names the column as it exists
		// *right now* (`"at"`), so it is in force immediately, and SQLite's own
		// auto-repointing of `UPDATE OF` across `RENAME COLUMN` moves it onto
		// `"occurred_at"` when the rename lands later. No window either way, and
		// no rename ahead of a rebuild.
		const before = sqliteTable('events', { id: text('id').primaryKey(), at: integer('at') });
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['at'] }]])),
		);
		await DB.prepare(`insert into events (id, at) values ('a', 1)`).run();

		const after = sqliteTable('audit', { id: text('id').primaryKey(), occurred_at: integer('occurred_at') });
		const diff = diffSnapshots(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['at'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['occurred_at'] }]])),
			{ renamedTables: { events: 'audit' }, renamedColumns: { 'audit.at': 'occurred_at' } },
		);
		expect(diff.errors).toEqual([]);

		const { statementGroups } = await import('../../src/core/sql.js');
		const sqls = diff.statements.map((s) => s.sql);
		const groups = statementGroups(sqls);

		const renameIndex = sqls.findIndex((s) => /rename to "audit"/.test(s));
		const columnRenameIndex = sqls.findIndex((s) => /rename column "at" to "occurred_at"/.test(s));
		const dropTriggerIndex = sqls.findIndex((s) => /drop trigger.*events_no_update/i.test(s));
		const createTriggerIndex = sqls.findIndex((s) => /create trigger "audit_no_update"/.test(s));
		expect([renameIndex, columnRenameIndex, dropTriggerIndex, createTriggerIndex].every((i) => i >= 0)).toBe(true);

		// The column rename is emitted *after* the trigger swap, not before it —
		// that ordering is what keeps a rebuild's `INSERT … SELECT` reading a
		// column that still exists.
		expect(dropTriggerIndex).toBeLessThan(columnRenameIndex);
		expect(createTriggerIndex).toBeLessThan(columnRenameIndex);
		// The guard is created under the column's *live* name, so it is not inert.
		expect(sqls[createTriggerIndex]).toContain('update of "at"');
		// Rename, drop and re-create are still one indivisible group.
		expect(new Set([renameIndex, dropTriggerIndex, createTriggerIndex].map((i) => groups[i])).size).toBe(1);

		// Apply only that group — the worst case a batch boundary can produce —
		// and confirm the guard is already in force on the live column.
		const groupId = groups[renameIndex];
		await runner.batch(sqls.filter((_, i) => groups[i] === groupId));

		const tables = await runner.all<{ name: string }>(
			"select name from sqlite_master where type = 'table' and name in ('events', 'audit')",
		);
		expect(tables.map((t) => t.name)).toEqual(['audit']);
		await expect(DB.prepare(`update audit set "at" = 2 where id = 'a'`).run()).rejects.toThrow();

		// Then the rest, and confirm SQLite repointed `UPDATE OF` onto the new
		// column name by itself: the guard now blocks "occurred_at".
		await runner.batch(sqls.filter((_, i) => groups[i] !== groupId));
		const trigger = await runner.all<{ sql: string }>(
			`select sql from sqlite_master where type = 'trigger' and name = 'audit_no_update'`,
		);
		expect(trigger[0]!.sql.toLowerCase()).toContain('update of "occurred_at"');
		await expect(DB.prepare(`update audit set "occurred_at" = 2 where id = 'a'`).run()).rejects.toThrow();
		const row = await runner.all<{ occurred_at: number }>(`select occurred_at from audit where id = 'a'`);
		expect(row[0]!.occurred_at).toBe(1);
	});

	it('does not corrupt the renamed column when the same table is also rebuilt', async () => {
		// [Round 4, finding 1] The regression this pins: with the column rename
		// hoisted into step 1, step 4's `recreateTable` still emits
		// `insert into "__new_audit" (…, "occurred_at") select …, "at" from "audit"`
		// — reading a column that the hoisted rename already renamed away. D1
		// has double-quoted-string-literal fallback on, so `"at"` degrades to the
		// *string* `'at'` instead of erroring: the migration reports success and
		// every value in the column is the old column's name.
		const before = sqliteTable('events', {
			id: text('id').primaryKey(),
			at: integer('at'),
			note: integer('note'),
		});
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['at'] }]])),
		);
		await DB.prepare(`insert into events (id, at, note) values ('a', 1234, 7)`).run();

		// `note` changes type integer -> text, which forces a rebuild of the same
		// table that is being renamed and whose guarded column is being renamed.
		const after = sqliteTable('audit', {
			id: text('id').primaryKey(),
			occurred_at: integer('occurred_at'),
			note: text('note'),
		});
		await migrateTo(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['at'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['occurred_at'] }]])),
			{ renamedTables: { events: 'audit' }, renamedColumns: { 'audit.at': 'occurred_at' } },
		);

		const rows = await runner.all<{ occurred_at: unknown; note: unknown }>(
			`select occurred_at, note from audit where id = 'a'`,
		);
		// The original value, not the string 'at'.
		expect(rows[0]!.occurred_at).toBe(1234);
		expect(rows[0]!.note).toBe('7');

		// And the table is still guarded afterwards, under the final name.
		await expect(DB.prepare(`update audit set "occurred_at" = 2 where id = 'a'`).run()).rejects.toThrow();
	});
});

describe('[Round 4, finding 6] a guarded-column rename with no table rename', () => {
	it('applies the guard swap as one atomic group, so no batch boundary can land inside it', async () => {
		// `diffSnapshots` emits `alter table … rename column`, then
		// `drop trigger if exists "ledger_no_update"`, then the re-create under
		// the new column list. `statementGroups` only started a group at a *table*
		// rename, so these were three singletons and `packIntoBatches` was free to
		// end a batch between the drop and the re-create — leaving the table with
		// no guard at all (UPDATE permitted) until the next batch ran, and for
		// good if it failed.
		const before = sqliteTable('ledger', { id: text('id').primaryKey(), amount: integer('amount') });
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['amount'] }]])),
		);
		await DB.prepare(`insert into ledger (id, amount) values ('a', 5)`).run();

		const after = sqliteTable('ledger', { id: text('id').primaryKey(), cents: integer('cents') });
		const diff = diffSnapshots(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['amount'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['cents'] }]])),
			{ renamedColumns: { 'ledger.amount': 'cents' } },
		);
		expect(diff.errors).toEqual([]);
		const sqls = diff.statements.map((s) => s.sql);
		expect(sqls.some((s) => /drop trigger/i.test(s))).toBe(true);
		expect(sqls.some((s) => /create trigger/i.test(s))).toBe(true);

		// One leading unrelated statement, so a limit of 3 puts a boundary
		// between the drop and the re-create for as long as they are separate
		// groups, and cannot for as long as they are one.
		const lead = 'create table "unrelated" ("id" integer)';
		const statements = [lead, ...sqls];

		// Probe between every batch: is the guard in force right now?
		const unguardedWindows: number[] = [];
		let batchCount = 0;
		const probingRunner: SqlRunner = {
			all: runner.all,
			batch: async (batch) => {
				await runner.batch(batch);
				batchCount++;
				try {
					await DB.prepare(`update ledger set "cents" = 99 where id = 'a'`).run();
					unguardedWindows.push(batchCount);
				} catch {
					// blocked — the guard is in force, which is the point
				}
				try {
					await DB.prepare(`update ledger set "amount" = 99 where id = 'a'`).run();
					unguardedWindows.push(batchCount);
				} catch {
					// blocked, or the column no longer exists under that name
				}
			},
			atomicLimit: () => 3,
		};

		await applyMigrations(probingRunner, [{ tag: 'guard_swap', sql: statements.map((s) => `${s};`).join('\n') }]);

		expect(batchCount).toBeGreaterThan(1);
		expect(unguardedWindows).toEqual([]);
		const row = await runner.all<{ cents: number }>(`select cents from ledger where id = 'a'`);
		expect(row[0]!.cents).toBe(5);
	});
});

describe('a table rename beside a new append-only column', () => {
	it('guards the new column too, not just the renamed one', async () => {
		// `events(id, a, b)`, `appendOnly: ['a', 'b']` -> `audit(id, alpha, b, note)`,
		// `appendOnly: ['alpha', 'note']`: a table rename, a column rename
		// (a -> alpha), and a brand-new guarded column (`note`) that does not
		// exist on the pre-rename live table at all.
		//
		// Step 1's guard re-create used to filter `after`'s declared append-only
		// list down to columns present on the pre-rename snapshot, dropping
		// `note` entirely — and `carriedAppendOnly` was set to `after`'s FULL
		// list regardless, so step 4 saw `previousGuard === nextGuard` and never
		// corrected the narrowed guard. The result: `note` was never guarded, for
		// good.
		const before = sqliteTable('events', {
			id: integer('id').primaryKey(),
			a: integer('a'),
			b: integer('b'),
		});
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['a', 'b'] }]])),
		);
		await DB.prepare(`insert into events (id, a, b) values (1, 10, 20)`).run();

		const after = sqliteTable('audit', {
			id: integer('id').primaryKey(),
			alpha: integer('alpha'),
			b: integer('b'),
			note: text('note'),
		});
		await migrateTo(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['a', 'b'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['alpha', 'note'] }]])),
			{ renamedTables: { events: 'audit' }, renamedColumns: { 'audit.a': 'alpha' } },
		);
		const live = await introspect(runner);
		expect(live.tables.audit?.appendOnly).toEqual(['alpha', 'note']);

		// The new column is guarded.
		await expect(DB.prepare(`update audit set note = 'x' where id = 1`).run()).rejects.toThrow();
		// The renamed column is still guarded too.
		await expect(DB.prepare(`update audit set alpha = 99 where id = 1`).run()).rejects.toThrow();
	});
});

describe('a rename that reuses a live column name loses no guard', () => {
	it('guards both final columns when a rename collides two guarded columns onto one live name', async () => {
		// `payments(id, amount)`, `appendOnly: ['amount']` -> `ledger(id,
		// amount_cents, amount)`, `appendOnly: ['amount_cents', 'amount']`, with
		// `ledger.amount_cents` renamed FROM `payments.amount`.
		//
		// Step 1 builds the re-created guard from each guarded column's
		// PRE-rename (live) name: `amount_cents`'s live name is `amount`
		// (that's what is being renamed), and the brand-new `amount` column's
		// live name is also `amount` (nothing renames onto it, so
		// `preRenameColumnName` returns it unchanged). `appendOnlyTrigger`
		// de-duplicates its column list by name, so the trigger step 1 created
		// named `"amount"` only once — covering just one of the two final
		// columns — and `carriedAppendOnly` used to claim `after`'s full list
		// regardless, so step 4 never noticed and never restated it. One of the
		// two columns was permanently unguarded.
		const before = sqliteTable('payments', {
			id: integer('id').primaryKey(),
			amount: integer('amount'),
		});
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['amount'] }]])),
		);
		await DB.prepare(`insert into payments (id, amount) values (1, 500)`).run();

		const after = sqliteTable('ledger', {
			id: integer('id').primaryKey(),
			amount_cents: integer('amount_cents'),
			amount: text('amount'),
		});
		const diff = diffSnapshots(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['amount'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['amount_cents', 'amount'] }]])),
			{ renamedTables: { payments: 'ledger' }, renamedColumns: { 'ledger.amount': 'amount_cents' } },
		);
		expect(diff.errors).toEqual([]);

		await applyMigrations(runner, [
			{ tag: 'm_collision', sql: renderMigration(diff) },
		]);

		const live = await introspect(runner);
		const liveAppendOnly = live.tables.ledger?.appendOnly;
		expect(Array.isArray(liveAppendOnly)).toBe(true);
		expect(new Set(liveAppendOnly as readonly string[])).toEqual(new Set(['amount_cents', 'amount']));

		// The pre-existing column, now renamed to `amount_cents`, is guarded.
		await expect(
			DB.prepare(`update ledger set amount_cents = 999 where id = 1`).run(),
		).rejects.toThrow();
		// The brand-new `amount` column (added by this migration) is guarded too.
		await expect(DB.prepare(`update ledger set amount = 'x' where id = 1`).run()).rejects.toThrow();

		const row = await runner.all<{ amount_cents: number }>(`select amount_cents from ledger where id = 1`);
		expect(row[0]!.amount_cents).toBe(500);
	});
});
