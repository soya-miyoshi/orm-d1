/**
 * Batching, and the invariant a table rebuild depends on: `applyMigration`
 * (and `push`, tested against real D1 in `kit/test/workers/migrate.test.ts`)
 * must never split a rebuild group — `create table "__new_X"` … `alter table
 * "__new_X" rename to "X"` — across two `batch()` calls, since D1 only gives
 * atomicity *within* one batch. Splitting it can commit the `drop table "X"`
 * in one batch and fail the rename in the next, leaving the table gone.
 */
import { describe, expect, it } from 'vitest';
import { applyMigration, MAX_STATEMENTS_PER_BATCH } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { packIntoBatches, statementGroups } from '../../src/core/sql.js';

const recordingRunner = (): { runner: SqlRunner; batches: string[][] } => {
	const batches: string[][] = [];
	return {
		batches,
		runner: {
			all: async () => [],
			batch: async (statements) => {
				batches.push([...statements]);
			},
		},
	};
};

/** A table rebuild, exactly as `recreateTable` in `diff.ts` emits it. */
const rebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table "__new_${table}" ("id" integer)`,
	`insert into "__new_${table}" ("id") select "id" from "${table}"`,
	`drop table "${table}"`,
	`alter table "__new_${table}" rename to "${table}"`,
];

describe('statementGroups', () => {
	it('gives every plain statement its own group', () => {
		const statements = ['create table "a" ("id" integer)', 'create table "b" ("id" integer)'];
		const groups = statementGroups(statements);
		expect(groups[0]).not.toBe(groups[1]);
	});

	it('groups a whole rebuild — including its leading defer_foreign_keys pragma — as one unit', () => {
		const statements = [
			'create table "before" ("id" integer)',
			...rebuildGroup('x'),
			'create index "x_idx" on "x" ("id")',
			'create table "after" ("id" integer)',
		];
		const groups = statementGroups(statements);

		// The unrelated statement before it is not folded in.
		expect(groups[0]).not.toBe(groups[1]);
		// The index create after the rename *is* part of the rebuild group:
		// `recreateTable` (`diff.ts`) emits it after the rename to restore the
		// constraints the drop just took with it, so a batch boundary landing
		// between the rename and it is exactly as unsafe as one landing before
		// the rename — see `[F-041]`. Only the statement after *that* is free.
		expect(groups[6]).toBe(groups[1]);
		expect(groups[7]).not.toBe(groups[1]);
		// PRAGMA through the trailing index create share one id.
		expect(new Set(groups.slice(1, 7)).size).toBe(1);
	});
});

describe('packIntoBatches', () => {
	it('never splits a rebuild group across two batches', () => {
		// Pad with plain statements so the rebuild group would straddle a
		// batch boundary under naive fixed-stride slicing.
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];

		const batches = packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH);

		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
		// And the group did land in exactly one batch, together.
		const groupBatch = batches.find((b) => b.includes('drop table "orders"'));
		expect(groupBatch).toBeDefined();
		expect(groupBatch).toEqual(expect.arrayContaining(rebuildGroup('orders')));
	});

	it('refuses outright, rather than splitting, when a single group exceeds the batch limit', () => {
		// The rebuild group is 5 statements; a limit of 3 cannot hold it, and
		// there is no safe way to split it, so this must throw rather than
		// emit a migration that can leave the table dropped and never renamed.
		expect(() => packIntoBatches(rebuildGroup('orders'), 3)).toThrow(/exceeds the per-batch limit/);
	});
});

describe('applyMigration batching', () => {
	it('never lets a batch drop "X" without also renaming "__new_X" to "X" in the same batch', async () => {
		const { runner, batches } = recordingRunner();
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];
		await applyMigration(runner, 'm_rebuild', `${statements.join(';\n')};`);

		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
	});

	it('does not split at all for a runner that says it needs no ceiling', async () => {
		// The local path and the remote import path both run any number of
		// statements as one unit. Splitting them under `/query`'s ceiling used
		// to give away atomicity for nothing.
		const { runner, batches } = recordingRunner();
		const unlimited: SqlRunner = { ...runner, atomicLimit: () => Infinity };
		const statements = Array.from(
			{ length: MAX_STATEMENTS_PER_BATCH * 3 },
			(_, i) => `create table "t${i}" ("id" integer)`,
		);

		const warnings = await applyMigration(unlimited, 'm_unlimited', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(statements.length + 1); // + the d1_migrations record
		expect(warnings).toEqual([]);
	});

	it('honours a ceiling the runner reports for these particular statements', async () => {
		const { runner, batches } = recordingRunner();
		const picky: SqlRunner = { ...runner, atomicLimit: (s) => (s.length > 5 ? Infinity : 2) };

		await applyMigration(picky, 'm_small_capped', 'create table "a" ("id" integer);\ncreate table "b" ("id" integer);');
		// 2 statements + the record = 3, over the ceiling of 2 → split.
		expect(batches.length).toBeGreaterThan(1);

		batches.length = 0;
		const many = Array.from({ length: 10 }, (_, i) => `create table "u${i}" ("id" integer)`);
		await applyMigration(picky, 'm_large_uncapped', `${many.join(';\n')};`);
		expect(batches).toHaveLength(1);
	});

	it('names the ceiling it actually used in the split warning', async () => {
		const { runner } = recordingRunner();
		const capped: SqlRunner = { ...runner, atomicLimit: () => 4 };
		const statements = Array.from({ length: 9 }, (_, i) => `create table "v${i}" ("id" integer)`);

		const warnings = await applyMigration(capped, 'm_capped', `${statements.join(';\n')};`);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('batches of up to 4');
	});

	it('appends the d1_migrations record to the final batch, not a separate one', async () => {
		const { runner, batches } = recordingRunner();
		const statements = Array.from({ length: MAX_STATEMENTS_PER_BATCH + 10 }, (_, i) => `create table "t${i}" ("id" integer)`);
		await applyMigration(runner, 'm_many', `${statements.join(';\n')};`);

		expect(batches.length).toBeGreaterThan(1);
		const last = batches[batches.length - 1]!;
		expect(last.some((s) => s.includes("insert into \"d1_migrations\" (name) values ('m_many')"))).toBe(true);
		// No batches after the one carrying the record.
		for (const batch of batches.slice(0, -1)) {
			expect(batch.some((s) => s.startsWith('insert into "d1_migrations"'))).toBe(false);
		}
	});

	it('shifts a statement out of an exactly-full last batch so the record does not become its own trailing batch (gap 2)', async () => {
		const { runner, batches } = recordingRunner();
		// Exactly MAX_STATEMENTS_PER_BATCH real statements: greedy packing fills
		// the (only) batch of real statements exactly, with no room left over.
		// [F-043]: the record must not become its own one-statement trailing
		// batch here — one real statement is shifted out of the full batch so
		// the record always rides along with a real statement.
		const statements = Array.from({ length: MAX_STATEMENTS_PER_BATCH }, (_, i) => `create table "t${i}" ("id" integer)`);
		await applyMigration(runner, 'm_exact', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(MAX_STATEMENTS_PER_BATCH - 1);
		expect(batches[1]).toHaveLength(2);
		expect(batches[1]).toContain(`insert into "d1_migrations" (name) values ('m_exact')`);
		expect(batches[1]!.some((s) => s !== `insert into "d1_migrations" (name) values ('m_exact')`)).toBe(true);
	});

	it('keeps a rebuild group whole when it is what makes the last batch fill exactly, and rides the record along with it (gap 2)', async () => {
		const { runner, batches } = recordingRunner();
		// 95 plain creates + a 5-statement rebuild group = exactly 100: the
		// group must not be split to make room for the record. [F-043]/[F-041]:
		// the whole group is shifted into a second batch together with the
		// record, rather than leaving the record alone in a trailing batch.
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 5 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];
		await applyMigration(runner, 'm_rebuild_exact', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(MAX_STATEMENTS_PER_BATCH - 5);
		expect(batches[1]).toHaveLength(6);
		expect(batches[1]).toContain(`insert into "d1_migrations" (name) values ('m_rebuild_exact')`);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
		// The whole rebuild group landed in the second batch, with the record.
		expect(batches[1]).toContain('drop table "orders"');
		expect(batches[1]).toContain('alter table "__new_orders" rename to "orders"');
	});

	it('keeps the record in the single batch when the migration is small', async () => {
		const { runner, batches } = recordingRunner();
		await applyMigration(runner, 'm_small', 'create table "t" ("id" integer);');

		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual([
			'create table "t" ("id" integer)',
			`insert into "d1_migrations" (name) values ('m_small')`,
		]);
	});
});
