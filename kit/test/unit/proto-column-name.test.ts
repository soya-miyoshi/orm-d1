/**
 * [round 5] A column (or constraint name) literally spelled `__proto__` is
 * legal SQL and a legal `sqliteTable` key — `sqliteTable('t', { p:
 * text('__proto__') })` compiles and `createTable` emits `"__proto__" text`.
 * `snapshotFromSchema`'s per-table column map used to be a plain `{}`
 * (`kit/src/core/snapshot.ts`), the same hazard `indexes`/`foreignKeys`/etc.
 * in the very same function are already `Object.create(null)` for, with a
 * comment spelling it out — just missed for the column map itself.
 * `columns['__proto__'] = snapshot` sets the object's *prototype* instead of
 * adding an entry, so the column silently vanishes: `createTableFromSnapshot`
 * renders the table without it, and `diffSnapshots` for adding it back emits
 * zero statements (both sides drop it identically), so `check` reports clean
 * and a rebuild for any other reason drops the column and its data with no
 * error at all.
 */
import { sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';

describe('a column literally named __proto__', () => {
	it('is present in the snapshot as an own entry, not swallowed into the prototype', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const snapshot = snapshotFromSchema({ t });

		expect(Object.hasOwn(snapshot.tables.t!.columns, '__proto__')).toBe(true);
		expect(snapshot.tables.t!.columns['__proto__']).toBeDefined();
		expect(snapshot.tables.t!.columns['__proto__']!.name).toBe('__proto__');
		// Not inherited from Object.prototype, which every plain object exposes
		// unless it is null-prototype.
		expect(Object.getPrototypeOf(snapshot.tables.t!.columns)).toBeNull();
	});

	it('is proposed by a fresh diff, instead of being silently omitted', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const after = snapshotFromSchema({ t });
		const diff = diffSnapshots(emptySnapshot(), after);

		expect(diff.errors).toEqual([]);
		const createStatement = diff.statements.find((s) => /create table/i.test(s.sql));
		expect(createStatement?.sql).toContain('"__proto__"');
	});

	it('does not disappear from a no-op diff against itself', () => {
		const t = sqliteTable('t', { id: text('id').primaryKey(), p: text('__proto__') });
		const snapshot = snapshotFromSchema({ t });
		// Both sides derived from the same schema, so a correct diff proposes
		// nothing — this is the regression's own failure shape stated
		// positively: before the fix, adding the column against an *empty*
		// snapshot ALSO proposed nothing, because both producers dropped it
		// identically and so still "agreed".
		const diff = diffSnapshots(snapshot, snapshotFromSchema({ t }));
		expect(diff.statements).toEqual([]);
		expect(diff.errors).toEqual([]);
	});
});
