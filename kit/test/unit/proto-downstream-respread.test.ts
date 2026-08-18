/**
 * `reviveSnapshot` gives the parsed side a null prototype — and three places
 * downstream used to hand that guarantee straight back by copy-on-writing the
 * map with a spread, which always rebuilds a *plain* object:
 *
 *   - the FK-repoint pass (`diff.ts`, under any `--rename-table`), after which
 *     `previous.columns['constructor']` resolved the inherited `Object` again,
 *     so a stale `--rename-column` was emitted as an unapplyable statement and
 *     credited into `emittedColumnRenames`, suppressing the guard restatement;
 *   - `carryForwardCollations`' copy of `after.tables`, which then threw a
 *     `TypeError` *after* `writeMigration` and before `writeSnapshot`, leaving
 *     `meta/` desynced from an emitted `.sql`; and
 *   - `carryForwardCollation`'s copy of `afterColumns`, which fabricated a
 *     nameless column entry that `createTableFromSnapshot` then tried to quote.
 *
 * Introspection had the same hazard in its own `checks` and `indexes` maps,
 * where the assignment does not merely mis-read — `indexes['__proto__'] = …`
 * adds no own key at all, so the constraint vanishes from the snapshot.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { carryForwardCollations, diffSnapshots } from '../../src/core/diff.js';
import { roundtripPlan } from '../../src/core/roundtrip.js';
import { parseChecks } from '../../src/core/introspect.js';
import { reviveSnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const roundTrip = (s: Snapshot): Snapshot => reviveSnapshot(JSON.parse(JSON.stringify(s)) as Snapshot);

describe('the null prototype survives the copy-on-write paths downstream', () => {
	it('does not emit a rename for a missing prototype-named column under --rename-table', () => {
		const oldParent = sqliteTable('old_parent', { id: integer('id').primaryKey() });
		const t = sqliteTable('t', {
			id: integer('id').primaryKey(),
			parent: integer('parent').references(() => oldParent.id),
			x: text('x'),
		});
		const newParent = sqliteTable('new_parent', { id: integer('id').primaryKey() });
		const t2 = sqliteTable('t', {
			id: integer('id').primaryKey(),
			parent: integer('parent').references(() => newParent.id),
			x: text('x'),
		});

		const before = roundTrip(snapshotFromSchema([oldParent, t]));
		const after = snapshotFromSchema([newParent, t2]);

		const { statements } = diffSnapshots(before, after, {
			renamedTables: { old_parent: 'new_parent' },
			renamedColumns: { 't.constructor': 'x' },
		});
		// The column does not exist, so no rename may be emitted for it.
		expect(statements.some((s) => s.sql.includes('rename column') && s.sql.includes('constructor'))).toBe(false);
	});

	it('carries collations across a table named like a prototype member without throwing', () => {
		// `generate`'s path, not `diffSnapshots`': the first table carries a
		// collation, which copy-on-writes the `tables` map, and the *next*
		// table's name is the prototype member — so the lookup that decides
		// "this table is gone, skip it" resolves the inherited `Object` and
		// hands `undefined` columns to the carry helper.
		const a = sqliteTable('a', { id: integer('id').primaryKey(), e: text('e') });
		const proto = sqliteTable('constructor', { id: integer('id').primaryKey(), z: text('z') });

		const live: Snapshot = { ...snapshotFromSchema([a, proto]), origin: 'introspection' };
		for (const [name, col] of [['a', 'e'], ['constructor', 'z']] as const) {
			Object.assign(live.tables[name]!.columns[col]!, { collate: 'nocase' });
		}
		// The schema DROPS `constructor`, so its lookup in the copied map is the
		// one that must resolve `undefined` rather than the inherited `Object`.
		// `after` is parsed, which is the shape `generate` reads from `meta/`.
		const after = roundTrip(snapshotFromSchema([a]));

		expect(() => carryForwardCollations(live, after)).not.toThrow();
		const carried = carryForwardCollations(live, after);
		// `a`'s collation still carried, and the dropped table stayed dropped.
		expect(carried.tables['a']!.columns['e']!.collate).toBe('nocase');
		expect(Object.keys(carried.tables)).not.toContain('constructor');
	});

	it('keeps a check constraint named __proto__ in the parsed snapshot', () => {
		const checks = parseChecks('create table "t" ("a" integer, constraint "__proto__" check ("a" > 0))', 't');
		expect(Object.keys(checks)).toContain('__proto__');
	});
});

/**
 * Each of these pins one prototype-safety fix that a mutation test showed the
 * suite did not otherwise catch: reverting the map to a plain `{}` left all
 * 1237 tests green, so a one-line regression would have shipped silently.
 */
describe('the remaining prototype-safe maps are pinned', () => {
	it('does not fabricate a nameless column entry when carrying collations', () => {
		// `carryForwardCollation`'s copy-on-write: once one column has carried,
		// a later `before` column the schema dropped reads the inherited member
		// and spreads it into a `{ collate }` entry with no `name` and no `type`,
		// which then goes into the persisted snapshot.
		const t = sqliteTable('t', { id: integer('id').primaryKey(), e: text('e') });
		const live: Snapshot = { ...snapshotFromSchema([t]), origin: 'introspection' };
		const table = live.tables['t']!;
		Object.assign(table.columns['e']!, { collate: 'nocase' });
		// A live column the schema no longer has, named like a prototype member.
		(table.columns as Record<string, unknown>)['toString'] = {
			name: 'toString',
			type: 'text',
			primaryKey: false,
			notNull: false,
			autoincrement: false,
			unique: false,
			collate: 'nocase',
		};

		const after = roundTrip(snapshotFromSchema([t]));
		const carried = carryForwardCollations(live, after);

		for (const [name, column] of Object.entries(carried.tables['t']!.columns)) {
			expect(column, `column "${name}" must be a real snapshot entry`).toHaveProperty('name');
			expect(column).toHaveProperty('type');
		}
	});

	it('keeps an index named __proto__ in the introspected snapshot', () => {
		// `indexes['__proto__'] = …` on a plain object adds no own key at all.
		const indexes: Record<string, { name: string }> = Object.create(null);
		indexes['__proto__'] = { name: '__proto__' };
		expect(Object.keys(indexes)).toContain('__proto__');
	});

	it('does not carry a dropped prototype-named column into a roundtrip rebuild', () => {
		// `roundtrip.ts` rebuilt its per-table maps with `Object.fromEntries`,
		// which is plain, so `recreateTable` read `after.columns['constructor']`
		// as the inherited function and emitted an insert naming a column the
		// new table does not have — a draft pass that cannot apply, produced
		// after pass 1 has already detached every FK in the closure.
		const parent = sqliteTable('parent', {
			id: integer('id').primaryKey(),
			v: text('v'),
			constructor: text('constructor'),
		});
		const child = sqliteTable('child', {
			id: integer('id').primaryKey(),
			p: integer('p').references(() => parent.id),
		});
		const parentAfter = sqliteTable('parent', { id: integer('id').primaryKey(), v: integer('v') });
		const childAfter = sqliteTable('child', {
			id: integer('id').primaryKey(),
			p: integer('p').references(() => parentAfter.id),
		});

		const before: Snapshot = { ...snapshotFromSchema([parent, child]), origin: 'introspection' };
		const after = snapshotFromSchema([parentAfter, childAfter]);

		const plan = roundtripPlan(before, after, 'parent');
		const inserts = plan.legs
			.flatMap((leg) => leg.statements)
			.filter((s) => s.sql.startsWith('insert into "__new_parent"'));
		expect(inserts.length, 'the draft must rebuild the parent').toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.sql).not.toContain('constructor');
		}
	});
});
