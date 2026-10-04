/**
 * [F-077] `diffIndexes` reads `before.indexes[name]` / `after.indexes[name]`
 * with a bare bracket lookup. When either side is a plain object (from
 * `JSON.parse` of a stored snapshot, or any caller that did not pass through
 * `reviveSnapshot`), a prototype key like `constructor` resolves to the
 * inherited `Object` function — truthy, so `canonicalIndex` reads
 * `.columns.map` off a function and throws `TypeError`.
 *
 * The fix adds `Object.hasOwn` guards in both loops of `diffIndexes`. This
 * test constructs a plain-object `before` snapshot (simulating `JSON.parse`
 * without `reviveSnapshot`) where the `after` side has an index named after a
 * prototype key, and asserts:
 *   - no TypeError is thrown;
 *   - the diff correctly reports the index as created (before→after) or
 *     dropped (after→before), not silently swallowed.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot, TableSnapshot } from '../../src/core/snapshot.js';

const prototypeNames = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

/**
 * Build a snapshot whose inner maps are plain objects (no null prototype),
 * the way `JSON.parse` produces them — simulating a caller that forgot to
 * call `reviveSnapshot`.
 */
const plainObjectSnapshot = (snapshot: Snapshot): Snapshot =>
	JSON.parse(JSON.stringify(snapshot)) as Snapshot;

/**
 * Inject an index named `name` into a table snapshot, keeping the result a
 * plain object (no null prototype) to simulate the `JSON.parse` path.
 */
const withNamedIndex = (
	snapshot: Snapshot,
	tableName: string,
	indexName: string,
): Snapshot => {
	const table = snapshot.tables[tableName]!;
	const indexes = { ...table.indexes, [indexName]: { name: indexName, columns: ['a'], isUnique: false } };
	return {
		...snapshot,
		tables: { ...snapshot.tables, [tableName]: { ...table, indexes } },
	};
};

describe('[F-077] diffIndexes with prototype-key index names on plain-object snapshots', () => {
	for (const name of prototypeNames) {
		it(`does not throw when after has an index named "${name}" and before is a plain object`, () => {
			const t = sqliteTable('t', { id: integer('id').primaryKey(), a: text('a') });
			const before = plainObjectSnapshot(snapshotFromSchema([t]));
			const after = withNamedIndex(snapshotFromSchema([t]), 't', name);

			expect(() => diffSnapshots(before, after)).not.toThrow();
			const { statements, errors } = diffSnapshots(before, after);
			expect(errors).toEqual([]);
			expect(statements.some((s) => s.sql.includes(name))).toBe(true);
		});

		it(`does not throw when before has an index named "${name}" and after is a plain object`, () => {
			const t = sqliteTable('t', { id: integer('id').primaryKey(), a: text('a') });
			const before = withNamedIndex(snapshotFromSchema([t]), 't', name);
			const after = plainObjectSnapshot(snapshotFromSchema([t]));

			expect(() => diffSnapshots(before, after)).not.toThrow();
			const { statements, errors } = diffSnapshots(before, after);
			expect(errors).toEqual([]);
			expect(statements.some((s) => s.sql.includes('drop index') && s.sql.includes(name))).toBe(true);
		});

		it(`reports an unchanged index named "${name}" correctly`, () => {
			const t = sqliteTable('t', { id: integer('id').primaryKey(), a: text('a') });
			const before = withNamedIndex(plainObjectSnapshot(snapshotFromSchema([t])), 't', name);
			const after = withNamedIndex(plainObjectSnapshot(snapshotFromSchema([t])), 't', name);

			expect(() => diffSnapshots(before, after)).not.toThrow();
			const { statements, errors } = diffSnapshots(before, after);
			expect(errors).toEqual([]);
			expect(statements.filter((s) => s.sql.includes(name))).toEqual([]);
		});
	}
});
