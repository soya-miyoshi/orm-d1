/**
 * `reviveSnapshot` has to go one level deeper than the `tables` map.
 *
 * Every per-table map is keyed by a name the *database* chose — a column, an
 * index, a constraint — and `diff.ts` reads all of them with bracket indexing
 * (`next.columns[target]`, `after.indexes[name]`, …). Reviving only `tables`
 * left each of those resolving `Object.prototype` members on the parsed side,
 * which is the plain-object hazard the sweep exists to remove, one level down:
 *
 *   - a live column named `constructor` that the baseline lacks read back as
 *     "already there", so `check` reported no drift at all; and
 *   - a live index named `constructor` reached `canonicalIndex`, which read
 *     `.columns.map` off the inherited `Object` function and threw a raw
 *     `TypeError` out of `check`.
 *
 * Both are reproduced here through the parsed shape `readLatestSnapshot`
 * actually hands the diff engine: `JSON.parse(JSON.stringify(...))`, since
 * `JSON.parse` can never produce a null-prototype object on its own.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { reviveSnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const prototypeNames = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

/** What `store.ts` does: read the file, parse it, revive it. */
const roundTrip = (snapshot: Snapshot): Snapshot =>
	reviveSnapshot(JSON.parse(JSON.stringify(snapshot)) as Snapshot);

describe('reviveSnapshot revives the per-table maps, not just `tables`', () => {
	for (const name of prototypeNames) {
		it(`reports a live column named "${name}" that the baseline lacks`, () => {
			const live = sqliteTable('t', {
				id: integer('id').primaryKey(),
				extra: text(name),
			});
			const baseline = sqliteTable('t', { id: integer('id').primaryKey() });

			const before: Snapshot = { ...snapshotFromSchema([live]), origin: 'introspection' };
			const after = roundTrip(snapshotFromSchema([baseline]));

			const { statements, errors } = diffSnapshots(before, after);
			expect(errors).toEqual([]);
			expect(statements.some((s) => s.sql.includes(name))).toBe(true);
		});

		it(`does not throw on a live index named "${name}"`, () => {
			// An index the baseline does not have has to reach `canonicalIndex`
			// on the parsed side; before the deep revive that read `.columns.map`
			// off `Object` and threw.
			const live = sqliteTable('t', { id: integer('id').primaryKey(), a: text('a') });
			const before: Snapshot = { ...snapshotFromSchema([live]), origin: 'introspection' };
			const beforeTable = before.tables.t!;
			const withIndex: Snapshot = {
				...before,
				tables: {
					...before.tables,
					t: {
						...beforeTable,
						indexes: {
							...beforeTable.indexes,
							[name]: { name, columns: ['a'], isUnique: true },
						},
					},
				},
			};
			const after = roundTrip(snapshotFromSchema([live]));

			expect(() => diffSnapshots(withIndex, after)).not.toThrow();
			const { statements } = diffSnapshots(withIndex, after);
			expect(statements.some((s) => s.sql.includes('drop index') && s.sql.includes(name))).toBe(true);
		});
	}

	it('changes nothing else about the snapshot', () => {
		const t = sqliteTable('t', { id: integer('id').primaryKey(), a: text('a') });
		const snapshot = snapshotFromSchema([t]);
		const parsed = JSON.parse(JSON.stringify(snapshot)) as Snapshot;

		// Faithful: the revive is only about prototypes, so the serialised form
		// has to be byte-identical on both sides of it.
		expect(JSON.stringify(reviveSnapshot(parsed))).toBe(JSON.stringify(parsed));
	});
});
