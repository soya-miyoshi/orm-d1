/**
 * [F-078] A column named `__proto__` must survive the full snapshot
 * roundtrip: `snapshotFromSchema` → `JSON.stringify` → `JSON.parse` →
 * `reviveSnapshot` → `Object.keys()` enumeration. `JSON.parse` always
 * builds plain objects, and `map['__proto__'] = v` on a plain `{}` sets the
 * object's prototype instead of adding an entry — the column silently
 * vanishes. `snapshotFromSchema` already uses `Object.create(null)` for its
 * maps, and `reviveSnapshot` re-establishes it after parsing; this test pins
 * that the full cycle is sound.
 */
import { sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { reviveSnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const roundTrip = (snapshot: Snapshot): Snapshot =>
	reviveSnapshot(JSON.parse(JSON.stringify(snapshot)) as Snapshot);

describe('[F-078] __proto__ column survives snapshot roundtrip', () => {
	it('is present in Object.keys after snapshotFromSchema', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const snapshot = snapshotFromSchema({ t });
		const columns = snapshot.tables.t!.columns;

		expect(Object.keys(columns)).toContain('__proto__');
		expect(Object.hasOwn(columns, '__proto__')).toBe(true);
		expect(columns['__proto__']!.name).toBe('__proto__');
	});

	it('survives JSON roundtrip and reviveSnapshot', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const original = snapshotFromSchema({ t });
		const revived = roundTrip(original);

		const columns = revived.tables.t!.columns;
		expect(Object.keys(columns)).toContain('__proto__');
		expect(Object.hasOwn(columns, '__proto__')).toBe(true);
		expect(columns['__proto__']!.name).toBe('__proto__');
		expect(Object.getPrototypeOf(columns)).toBeNull();
	});

	it('the revived snapshot is byte-identical to the parsed one', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const original = snapshotFromSchema({ t });
		const parsed = JSON.parse(JSON.stringify(original)) as Snapshot;
		const revived = reviveSnapshot(parsed);

		expect(JSON.stringify(revived)).toBe(JSON.stringify(parsed));
	});
});
