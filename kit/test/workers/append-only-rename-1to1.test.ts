/**
 * [Finding 5] Real-D1 counterpart to `kit/test/unit/append-only-rename-1to1.test.ts`:
 * a pure 1:1 guarded-column rename emits no guard restatement, and the live
 * guard still ends up on the new column name — because SQLite auto-repoints
 * a live trigger's `UPDATE OF` list across `RENAME COLUMN` by itself.
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

describe('a pure 1:1 guarded-column rename, against real D1', () => {
	it('leaves the guard in force on the renamed column, with no drop/create trigger emitted', async () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey(), x: text('x') });
		await migrateTo(
			emptySnapshot(),
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]])),
		);
		await DB.prepare(`insert into t (id, x) values (1, 'xval')`).run();

		const after = sqliteTable('t', { id: integer('id').primaryKey(), y: text('y') });
		const diff = diffSnapshots(
			snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]])),
			snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['y'] }]])),
			{ renamedColumns: { 't.x': 'y' } },
		);
		expect(diff.errors).toEqual([]);
		expect(diff.statements.some((s) => /trigger/i.test(s.sql))).toBe(false);

		await applyMigrations(runner, [{ tag: `m_${Math.random().toString(36).slice(2)}`, sql: renderMigration(diff) }]);

		const trigger = await runner.all<{ sql: string }>(
			`select sql from sqlite_master where type = 'trigger' and name = 't_no_update'`,
		);
		expect(trigger).toHaveLength(1);
		expect(trigger[0]!.sql.toLowerCase()).toContain('update of "y"');

		await expect(DB.prepare(`update t set y = 'nope' where id = 1`).run()).rejects.toThrow();
		const row = await runner.all<{ y: string }>(`select y from t where id = 1`);
		expect(row[0]!.y).toBe('xval');
	});
});
