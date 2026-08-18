/**
 * [reviewer issue 2] A cyclic column rename (a 2-way swap, or a longer
 * rotation) cannot be expressed as a sequence of in-place
 * `alter table … rename column` statements: whichever statement closes the
 * cycle names a column an earlier statement in the same batch has already
 * renamed away. Against real D1, this used to either fail to apply
 * ("duplicate column name") or silently apply and land values in the wrong
 * columns, depending on rename order. `diffSnapshots` now detects the cycle
 * and routes the table through the rebuild path instead, which maps values
 * directly via `INSERT … SELECT` and has no such ordering hazard.
 */
import { env } from 'cloudflare:test';
import { integer, sqliteTable, text } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/core/apply.js';
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

beforeEach(dropEverything);

describe('a cyclic column rename applies correctly against real D1', () => {
	it('a 2-way swap (x<->y) lands each row\'s values in the correct, swapped columns', async () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: text('x'),
			y: text('y'),
		});
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into t (id, x, y) values (1, 'xval', 'yval')`).run();

		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: text('x'),
			y: text('y'),
		});
		const diff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]), {
			renamedColumns: { 't.x': 'y', 't.y': 'x' },
		});
		expect(diff.errors).toEqual([]);
		await expect(
			applyMigrations(runner, [{ tag: `m_${Math.random().toString(36).slice(2)}`, sql: renderMigration(diff) }]),
		).resolves.not.toThrow();

		const rows = await runner.all<{ x: string; y: string }>(`select x, y from t where id = 1`);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ x: 'yval', y: 'xval' });
	});

	it('a 3-way rotation (a->b, b->c, c->a) lands each row\'s values in the correctly rotated columns', async () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			a: text('a'),
			b: text('b'),
			c: text('c'),
		});
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));
		await DB.prepare(`insert into t (id, a, b, c) values (1, 'aval', 'bval', 'cval')`).run();

		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			a: text('a'),
			b: text('b'),
			c: text('c'),
		});
		const diff = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]), {
			renamedColumns: { 't.a': 'b', 't.b': 'c', 't.c': 'a' },
		});
		expect(diff.errors).toEqual([]);
		await expect(
			applyMigrations(runner, [{ tag: `m_${Math.random().toString(36).slice(2)}`, sql: renderMigration(diff) }]),
		).resolves.not.toThrow();

		const rows = await runner.all<{ a: string; b: string; c: string }>(`select a, b, c from t where id = 1`);
		expect(rows).toHaveLength(1);
		// a's new value comes from old c, b's from old a, c's from old b.
		expect(rows[0]).toEqual({ a: 'cval', b: 'aval', c: 'bval' });
	});
});
