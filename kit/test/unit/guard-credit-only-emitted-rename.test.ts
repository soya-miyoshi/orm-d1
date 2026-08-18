/**
 * [Finding 1] `guardChanged` (`diff.ts`) forward-maps `previous.appendOnly`
 * through `columnRenames` unconditionally, but the `alter table … rename
 * column` loop just above it only emits a rename when *both* ends exist
 * (`previous.columns[from]` and `next.columns[to]`). A `--rename-column`
 * flag can name a rename that loop skips — e.g. a stale live guard naming a
 * column the table does not actually have (documented in
 * `kit/src/node/commands.ts`'s `sidecarDisagreementWarnings`: SQLite accepts
 * `UPDATE OF <unknown>` silently). Before the fix, crediting that unemitted
 * rename made `guardChanged` conclude the guard was already reconciled, so
 * `diffSnapshots` emitted nothing at all — leaving the live guard still
 * naming the ghost column and `x` fully unguarded.
 */
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable, text } from 'orm-d1';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

describe('guardChanged only credits a rename that diffSnapshots actually emits', () => {
	it('still restates the guard when the credited rename names a column the live table does not have', () => {
		// Live: t(id, x), guard covers a column named "ghost" that does not
		// exist on the table at all (a stale/hand-written trigger).
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: integer('x'),
		});
		const liveBefore: Snapshot = {
			...snapshotFromSchema([before]),
			origin: 'introspection',
			tables: {
				t: {
					...snapshotFromSchema([before]).tables['t']!,
					appendOnly: ['ghost'],
				},
			},
		};

		// Schema: t(id, x), appendOnly: ['x'] — a real guard on a real column.
		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: integer('x'),
		});
		const schemaAfter = {
			...snapshotFromSchema([after]),
			tables: {
				t: { ...snapshotFromSchema([after]).tables['t']!, appendOnly: ['x'] },
			},
		};

		// `--rename-column t.ghost=x`: this cannot be emitted as an in-place
		// rename because "ghost" is not a real column, so the rename loop
		// skips it — but `columnRenames` still names it.
		const { statements, errors } = diffSnapshots(liveBefore, schemaAfter, {
			renamedColumns: { 't.ghost': 'x' },
		});
		expect(errors).toEqual([]);

		// The guard must be restated (drop the stale trigger, create the real
		// one over "x") — not silently skipped because the diff thought the
		// unemitted rename already reconciled it.
		const dropsTrigger = statements.some((s) => /drop trigger/i.test(s.sql));
		const createsTrigger = statements.some((s) => /create trigger/i.test(s.sql) && /update of "x"/i.test(s.sql));
		expect(dropsTrigger).toBe(true);
		expect(createsTrigger).toBe(true);
	});
});
