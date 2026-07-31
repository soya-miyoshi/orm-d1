/**
 * The migration engine against a real D1 database.
 *
 * Unit tests prove the diff engine emits the SQL we intended; these prove the
 * SQL actually runs on D1, that introspecting the result reproduces the
 * schema, and — the test class that catches table-recreation bugs — that data
 * seeded before a migration survives it.
 */
import { env } from 'cloudflare:test';
import { createSchema, tableOptions } from 'd1zzle/ddl';
import { integer, real, sql, sqliteTable, text, uniqueIndex } from 'd1zzle';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, appliedMigrations, checkForeignTriggerConflicts, introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots, renderMigration } from '../../src/core/diff.js';
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
		// 96 plain table creates, plus a rebuild of one more table — 5 more
		// statements — for 101 total: one over `MAX_STATEMENTS_PER_BATCH`
		// (100), forcing a split. Under the old fixed-stride slicing, the
		// rebuild's `drop table "rebuilt"` and its `alter table "__new_rebuilt"
		// rename to "rebuilt"` would land in different batches.
		const before = sqliteTable('rebuilt', { id: integer('id').primaryKey(), age: text('age') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into rebuilt (id, age) values (1, '30')`).run();

		const filler = Array.from({ length: 96 }, (_, i) => sqliteTable(`filler_${i}`, { id: integer('id').primaryKey() }));
		// A type change on "age" forces `recreateTable`'s rebuild path.
		const after = sqliteTable('rebuilt', { id: integer('id').primaryKey(), age: integer('age') });

		const diff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([...filler, after]));
		expect(diff.errors).toEqual([]);
		const sql = renderMigration(diff);
		// Confirms the fixture actually exercises the >100-statement split this
		// test is about, rather than accidentally fitting in one batch.
		expect(sql.split(';').filter((s) => s.trim()).length).toBeGreaterThan(100);

		let calls = 0;
		const throwingRunner: SqlRunner = {
			...runner,
			batch: async (statements) => {
				calls++;
				if (calls === 2) throw new Error('simulated failure on the second batch');
				await runner.batch(statements);
			},
		};

		await expect(
			applyMigrations(throwingRunner, [{ tag: 'm_rebuild_split', sql }]),
		).rejects.toThrow(/simulated failure/);

		// The rebuild group is 5 statements — far short of the 100-statement
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
	});
});

describe('a rebuild refuses to silently drop a foreign trigger (finding 2)', () => {
	it('refuses a rebuild-forcing push when the live table carries a trigger d1zzle did not author, naming it', async () => {
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

		// A hand-written trigger d1zzle did not author, on the live (pre-rename)
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
