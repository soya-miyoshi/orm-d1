/**
 * [reviewer issue 4] `unquote` (kit/src/core/introspect.ts) only stripped
 * `"…"` double-quoting. SQLite also accepts `[…]` (bracket) and `` `…` ``
 * (backtick) identifier quoting, and a hand-written trigger's
 * `UPDATE OF [amount]` used to come through with the brackets still
 * attached — `"[amount]"` instead of `"amount"` — which then failed to match
 * the real column name anywhere downstream: `introspect()`'s appendOnly
 * output for the table silently dropped the column.
 */
import { env } from 'cloudflare:test';
import { integer, sqliteTable, text } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots, renderMigration } from '../../src/core/diff.js';
import { emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import { applyMigrations } from '../../src/core/apply.js';
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

describe('introspect reads a hand-written trigger\'s bracket/backtick-quoted UPDATE OF column', () => {
	it('reports the appendOnly column list with the quoting stripped, for a bracket-quoted column', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), amount: text('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		// A hand-written guard, bypassing orm-d1's own trigger creation, using
		// SQLite's bracket identifier quoting for the column name.
		await DB.prepare(
			'create trigger "accounts_no_update" before update of [amount] on "accounts" '
				+ "begin select raise(abort, 'amount is append-only'); end",
		).run();

		const foreignTriggers: Record<string, string[]> = {};
		const live = await introspect(runner, foreignTriggers);

		expect(live.tables['accounts']?.appendOnly).toEqual(['amount']);
		// Recognised as orm-d1's own guard shape (just spelled differently), so
		// it must not also show up as a foreign trigger orm-d1 does not own.
		expect(foreignTriggers['accounts'] ?? []).toEqual([]);
	});

	it('reports the appendOnly column list with the quoting stripped, for a backtick-quoted column', async () => {
		const before = sqliteTable('accounts', { id: integer('id').primaryKey(), amount: text('amount') });
		await migrateTo(emptySnapshot(), snapshotFromSchema([before]));

		await DB.prepare(
			'create trigger "accounts_no_update" before update of `amount` on "accounts" '
				+ "begin select raise(abort, 'amount is append-only'); end",
		).run();

		const live = await introspect(runner);
		expect(live.tables['accounts']?.appendOnly).toEqual(['amount']);
	});
});
