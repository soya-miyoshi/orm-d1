/**
 * [reviewer issue 3] Four remaining plain `{}` object literals, all keyed by
 * *table* name (as opposed to the column/constraint-name maps a previous
 * round already fixed): `snapshotFromSchema`'s `result` (`snapshot.ts`),
 * `snapshotFromIntrospection`'s `tables` (`introspect.ts`), and
 * `diffSnapshots`'s `renamedTables` and `effectiveBefore` (`diff.ts`). A
 * table literally named `__proto__` is legal SQL and a legal `sqliteTable`
 * name — assigning it as a key on a plain object sets the object's
 * *prototype* instead of adding an entry, so the table silently vanishes
 * from `Object.keys(...)`. A table named `constructor`/`toString`/etc.
 * resolves to the built-in `Object` property instead of `undefined`, which
 * can also throw or misbehave depending on what is done with the "value".
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';

describe('a table literally named __proto__', () => {
	it('is present in the snapshot as an own entry, not swallowed into the prototype', () => {
		const t = sqliteTable('__proto__', { id: integer('id').primaryKey() });
		const snapshot = snapshotFromSchema([t]);

		expect(Object.hasOwn(snapshot.tables, '__proto__')).toBe(true);
		expect(snapshot.tables['__proto__']).toBeDefined();
		expect(snapshot.tables['__proto__']!.name).toBe('__proto__');
		expect(Object.getPrototypeOf(snapshot.tables)).toBeNull();
	});

	it('produces a create table statement from a fresh diff, instead of being silently omitted', () => {
		const t = sqliteTable('__proto__', { id: integer('id').primaryKey() });
		const after = snapshotFromSchema([t]);
		const diff = diffSnapshots(emptySnapshot(), after);

		expect(diff.errors).toEqual([]);
		expect(diff.statements.length).toBeGreaterThan(0);
		expect(diff.statements.some((s) => /create table "__proto__"/.test(s.sql))).toBe(true);
	});

	it('is renamable without corrupting renamedTables/effectiveBefore', () => {
		const before = sqliteTable('__proto__', { id: integer('id').primaryKey() });
		const after = sqliteTable('regular_name', { id: integer('id').primaryKey() });

		// `{ __proto__: … }` in an object *literal* sets the prototype rather
		// than adding an own key — that is JS syntax, unrelated to the
		// `Object.create(null)` bug under test — so the key is set via a
		// computed property name instead, which behaves as a normal assignment.
		const { statements, errors } = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]), {
			renamedTables: { ['__proto__']: 'regular_name' },
		});

		expect(errors).toEqual([]);
		expect(statements).toEqual([
			{ sql: 'alter table "__proto__" rename to "regular_name"', destructive: false },
		]);
	});
});

describe('a table literally named constructor', () => {
	it('produces a create table statement without throwing, and is not confused with Object.prototype.constructor', () => {
		const t = sqliteTable('constructor', { id: integer('id').primaryKey(), note: text('note') });
		const after = snapshotFromSchema([t]);

		expect(() => diffSnapshots(emptySnapshot(), after)).not.toThrow();
		const diff = diffSnapshots(emptySnapshot(), after);
		expect(diff.errors).toEqual([]);
		expect(diff.statements.some((s) => /create table "constructor"/.test(s.sql))).toBe(true);
	});

	it('a no-op diff against itself proposes nothing (not swallowed, not mistaken for the built-in)', () => {
		const t = sqliteTable('constructor', { id: integer('id').primaryKey() });
		const snapshot = snapshotFromSchema([t]);
		const diff = diffSnapshots(snapshot, snapshotFromSchema([t]));
		expect(diff.errors).toEqual([]);
		expect(diff.statements).toEqual([]);
	});
});
