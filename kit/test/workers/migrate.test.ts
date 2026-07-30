/**
 * The migration engine against a real D1 database.
 *
 * Unit tests prove the diff engine emits the SQL we intended; these prove the
 * SQL actually runs on D1, that introspecting the result reproduces the
 * schema, and — the test class that catches table-recreation bugs — that data
 * seeded before a migration survives it.
 */
import { env } from 'cloudflare:test';
import { createSchema } from 'd1zzle/ddl';
import { integer, real, sqliteTable, text, uniqueIndex } from 'd1zzle';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, appliedMigrations, introspect } from '../../src/core/apply.js';
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
