/**
 * [Finding 3] `check` used to report NO DRIFT for a live table whose name is
 * a JS `Object.prototype` member (`constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__`) that the baseline no longer has — the table
 * should be flagged as dropped, but `emptySnapshot()`'s `tables: {}` (and any
 * other plain-object `Snapshot.tables`) resolves `after.tables['constructor']`
 * to the inherited `Object` function, which is truthy, so
 * `!after.tables[name]` never fires and the table is silently never reported.
 */
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable } from 'orm-d1';
import { diffSnapshots } from '../../src/core/diff.js';
import { emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const prototypeNames = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('diffSnapshots reports a prototype-named live table as dropped when the baseline lacks it', () => {
	for (const name of prototypeNames) {
		it(`flags "${name}" as dropped, not silently ignored`, () => {
			const t = sqliteTable(name, { id: integer('id').primaryKey() });
			const liveBefore: Snapshot = { ...snapshotFromSchema([t]), origin: 'introspection' };

			const { statements, errors } = diffSnapshots(liveBefore, emptySnapshot());
			expect(errors).toEqual([]);
			expect(statements.some((s) => s.sql.includes('drop table') && s.sql.includes(name))).toBe(true);
		});
	}
});
