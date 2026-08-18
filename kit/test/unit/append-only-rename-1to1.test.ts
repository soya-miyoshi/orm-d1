/**
 * [Finding 5] Regression coverage the round-8 widening removed and never
 * replaced: a pure 1:1 guarded-column rename — `x` renamed to `y`, nothing
 * added back under the old name — must NOT restate the guard.
 * `guardChanged` forward-maps `previous.appendOnly` (`['x']`) through the
 * emitted rename (`x -> y`) and compares it as a set against `next.appendOnly`
 * (`['y']`): they match, so no drop/create trigger is needed — SQLite's own
 * auto-repointing of `UPDATE OF` across `RENAME COLUMN` (verified against
 * real D1 in the sibling `kit/test/workers/append-only-rename-1to1.test.ts`)
 * already lands the live trigger on the new column name for free.
 *
 * `append-only-rename-swap.test.ts` (unit and workers) only covers the
 * expand/contract case, where a *new* column is added back under the old
 * name — that one legitimately needs a restatement, and is a different code
 * path (`guardChanged` reads `true` there because the mapped set does not
 * match `next`'s). This test pins the opposite outcome for the simpler,
 * far more common shape, so a regression that makes `guardChanged` fire on
 * every rename (not just the ones that actually need it) would emit a
 * needless destructive-looking drop+create and this test would catch it.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { tableOptions } from 'orm-d1/ddl';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

describe('a pure 1:1 guarded-column rename emits no guard restatement', () => {
	it('renames the column and says nothing about the trigger', () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey(), x: text('x') });
		const after = sqliteTable('t', { id: integer('id').primaryKey(), y: text('y') });

		const beforeSnapshot = snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]]));
		const afterSnapshot = snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['y'] }]]));

		const { statements, errors } = diffSnapshots(beforeSnapshot, afterSnapshot, {
			renamedColumns: { 't.x': 'y' },
		});
		expect(errors).toEqual([]);

		expect(statements.some((s) => s.sql === 'alter table "t" rename column "x" to "y"')).toBe(true);
		expect(statements.some((s) => /trigger/i.test(s.sql))).toBe(false);
	});
});
