/**
 * [reviewer issue 1] Step 4 of `diffSnapshots` (the in-place, no-table-rename
 * alteration path) used to compare the append-only guard's *raw* column list
 * (`appendOnlyKey(previous.appendOnly)` vs. `appendOnlyKey(next.appendOnly)`)
 * instead of forward-mapping it through this same diff's `columnRenames`
 * first, unlike the table-rename branch (step 1), which already does that
 * forward-map-and-compare-as-sets dance for exactly this reason.
 *
 * SQLite auto-repoints a live trigger's `UPDATE OF` list across
 * `RENAME COLUMN`. So the "expand/contract" pattern — rename a guarded column
 * away, then add a fresh column back under its old name, with `appendOnly`
 * spelled identically on both sides of the diff (`['x']`) — used to emit
 * nothing at all: `previousGuard === nextGuard` as raw strings, even though
 * the live trigger, once the rename lands, actually guards the renamed-away
 * column ("y"), not the new plain column that ends up holding the name "x".
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { tableOptions } from 'orm-d1/ddl';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

describe('append-only guard survives an expand/contract column rename (step 4, no table rename)', () => {
	it('restates the trigger instead of silently leaving it guarding the renamed-away column', () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: text('x'),
		});
		// `x` is renamed to `y`, and a brand new plain column is added back
		// under the old name `x` — `appendOnly` reads `['x']` on both sides.
		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			y: text('y'),
			x: text('x'),
		});

		const beforeSnapshot = snapshotFromSchema([before], '', tableOptions([[before, { appendOnly: ['x'] }]]));
		const afterSnapshot = snapshotFromSchema([after], '', tableOptions([[after, { appendOnly: ['x'] }]]));

		const { statements, errors } = diffSnapshots(beforeSnapshot, afterSnapshot, {
			renamedColumns: { 't.x': 'y' },
		});

		expect(errors).toEqual([]);

		// The rename ALTER for x -> y is still there.
		expect(statements.some((s) => s.sql === 'alter table "t" rename column "x" to "y"')).toBe(true);

		// The guard has to be dropped and recreated so it names the live "x"
		// after the rename runs — not silently left alone because the raw
		// appendOnly arrays read identically on both sides.
		const dropIndex = statements.findIndex((s) => s.sql.includes('drop trigger if exists "t_no_update"'));
		const createIndex = statements.findIndex((s) => /create trigger "t_no_update"/.test(s.sql));
		expect(dropIndex).toBeGreaterThanOrEqual(0);
		expect(createIndex).toBeGreaterThan(dropIndex);

		const createSql = statements[createIndex]!.sql;
		expect(createSql).toMatch(/update of "x"/i);
		expect(createSql).not.toMatch(/"y"/);
	});
});
