/**
 * [reviewer issue 1] Step 4 of `diffSnapshots` (in-place alteration, no table
 * rename) used to compare the append-only guard's raw `appendOnly` arrays,
 * not their post-rename column sets. An "expand/contract" rename — the
 * guarded column is renamed away and a fresh plain column is added back
 * under its old name, with the schema's `appendOnly` spelled identically
 * (`['x']`) before and after — used to read as "no change" and leave the
 * live trigger, after SQLite auto-repoints its `UPDATE OF` list across the
 * `RENAME COLUMN`, guarding the wrong (renamed-away) column instead of the
 * new one the schema actually names.
 */
import { env } from 'cloudflare:test';
import { tableOptions } from 'orm-d1/ddl';
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

describe('append-only guard survives an expand/contract column rename (step 4, no table rename)', () => {
	it('ends up guarding exactly the new plain column, not the renamed-away one', async () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey(), x: text('x') });
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]])),
		);

		// `x` renamed to `y`, and a brand new plain column added back under the
		// old name `x` — `appendOnly` reads `['x']` on both sides of the diff.
		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			y: text('y'),
			x: text('x'),
		});
		const diff = diffSnapshots(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['x'] }]])),
			{ renamedColumns: { 't.x': 'y' } },
		);
		expect(diff.errors).toEqual([]);
		await applyMigrations(runner, [{ tag: `m_${Math.random().toString(36).slice(2)}`, sql: renderMigration(diff) }]);

		const trigger = await runner.all<{ sql: string }>(
			`select sql from sqlite_master where type = 'trigger' and name = 't_no_update'`,
		);
		expect(trigger).toHaveLength(1);
		const sql = trigger[0]!.sql.toLowerCase();
		const match = /update of\s+(.+?)\s+on\b/.exec(sql);
		expect(match).not.toBeNull();
		const guardedColumns = new Set(match![1]!.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
		expect(guardedColumns).toEqual(new Set(['x']));

		// Behaviourally: updating the new "x" is blocked, updating "y" (which
		// carries the data renamed away from the old "x") is not.
		await DB.prepare(`insert into t (id, y, x) values (1, 'yval', 'xval')`).run();
		await expect(DB.prepare(`update t set x = 'nope' where id = 1`).run()).rejects.toThrow();
		await expect(DB.prepare(`update t set y = 'fine' where id = 1`).run()).resolves.toBeDefined();
	});
});
