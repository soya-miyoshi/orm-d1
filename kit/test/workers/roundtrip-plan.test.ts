/**
 * The three-pass draft, applied for real.
 *
 * A plan whose SQL is only ever inspected is a plan that has never been shown
 * to work. So each pass is applied to a real D1 in order, with data in the
 * tables, and the assertions are about the database afterwards: the target has
 * its new shape, the children still have their rows, and the foreign keys are
 * back and enforcing.
 *
 * The pass-1 refusal case is the reason this cannot be a unit test either —
 * whether `PRAGMA defer_foreign_keys` lets a drop through is a property of the
 * engine, not of the differ.
 */
import { env } from 'cloudflare:test';
import { createSchema } from 'orm-d1/ddl';
import { check, integer, sqliteTable, text } from 'orm-d1';
import { sql } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import { diffSnapshots } from '../../src/core/diff.js';
import { renderRoundtrip, roundtripPlan } from '../../src/core/roundtrip.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

/** `parent` carries a CHECK whose change forces a rebuild. */
const parentBefore = sqliteTable('rt_parent', {
	id: text('id').primaryKey(),
	kind: text('kind').notNull(),
}, (t) => [check('rt_parent_kind_enum', sql`${t.kind} in ('a', 'b')`)]);

const parentAfter = sqliteTable('rt_parent', {
	id: text('id').primaryKey(),
	kind: text('kind').notNull(),
}, (t) => [check('rt_parent_kind_enum', sql`${t.kind} in ('a', 'b', 'c')`)]);

const child = sqliteTable('rt_child', {
	id: text('id').primaryKey(),
	parentId: text('parent_id').notNull().references(() => parentBefore.id),
	label: text('label'),
});

const grandchild = sqliteTable('rt_grandchild', {
	id: text('id').primaryKey(),
	childId: text('child_id').notNull().references(() => child.id),
	n: integer('n'),
});

const before = snapshotFromSchema([parentBefore, child, grandchild], '');
const after = snapshotFromSchema([parentAfter, child, grandchild], '');

const apply = async (statements: readonly { sql: string }[]): Promise<void> => {
	if (statements.length === 0) return;
	await DB.batch(statements.map((s) => DB.prepare(s.sql)));
};

const rows = async <T>(query: string): Promise<T[]> => (await DB.prepare(query).all<T>()).results;

beforeEach(async () => {
	for (const name of ['rt_grandchild', 'rt_child', 'rt_parent']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema([parentBefore, child, grandchild])) {
		await DB.prepare(statement).run();
	}
	await DB.prepare(`insert into "rt_parent" ("id", "kind") values ('p1', 'a')`).run();
	await DB.prepare(`insert into "rt_child" ("id", "parent_id", "label") values ('c1', 'p1', 'keep')`).run();
	await DB.prepare(`insert into "rt_grandchild" ("id", "child_id", "n") values ('g1', 'c1', 7)`).run();
});

describe('roundtripPlan', () => {
	it('is only offered when the rebuild is actually blocked', () => {
		expect(() => roundtripPlan(before, after, 'rt_grandchild')).toThrow(/nothing references/);
	});

	it('names the whole closure, not just the direct children', () => {
		const plan = roundtripPlan(before, after, 'rt_parent');
		expect(plan.closure).toEqual(['rt_child', 'rt_grandchild']);
		// Detach, rebuild, then one restore per level: `rt_child` has to be back
		// before `rt_grandchild` can point at it again.
		expect(plan.legs.map((l) => l.title.slice(0, 2))).toEqual(['1.', '2.', '3.', '4.']);
		expect(plan.legs[2]!.title).toContain('"rt_child"');
		expect(plan.legs[3]!.title).toContain('"rt_grandchild"');
	});

	it('confirms the one-shot migration really is refused', () => {
		// If this ever stops erroring the draft is solving a problem that no
		// longer exists, and the test should be deleted rather than adjusted.
		expect(diffSnapshots(before, after, {}).errors.join(' ')).toMatch(/rt_parent.*references/s);
	});

	// The whole point: apply the three passes, in order, to a real database.
	it('applies pass by pass and leaves the schema and the data right', async () => {
		const plan = roundtripPlan(before, after, 'rt_parent');
		expect(plan.incomplete).toBe(false);

		for (const leg of plan.legs) {
			expect(leg.errors).toEqual([]);
			await apply(leg.statements);
		}

		// The rows survived all three rebuilds.
		expect(await rows(`select "id", "label" from "rt_child"`)).toEqual([{ id: 'c1', label: 'keep' }]);
		expect(await rows(`select "id", "n" from "rt_grandchild"`)).toEqual([{ id: 'g1', n: 7 }]);
		expect(await rows(`select "id", "kind" from "rt_parent"`)).toEqual([{ id: 'p1', kind: 'a' }]);

		// The target's new shape is in force: 'c' was rejected before.
		await DB.prepare(`insert into "rt_parent" ("id", "kind") values ('p2', 'c')`).run();
		await expect(DB.prepare(`insert into "rt_parent" ("id", "kind") values ('p3', 'z')`).run())
			.rejects.toThrow();

		// And the foreign keys are back and enforcing.
		await expect(
			DB.prepare(`insert into "rt_child" ("id", "parent_id") values ('c9', 'nope')`).run(),
		).rejects.toThrow();
		await expect(
			DB.prepare(`insert into "rt_grandchild" ("id", "child_id") values ('g9', 'nope')`).run(),
		).rejects.toThrow();
	});

	// Running is not the same as arriving. Read the database back and diff it
	// against the schema the plan was built for: anything the passes failed to
	// restore shows up here as leftover work, which is how the missing
	// restoration of the target's own foreign key was found.
	it('lands exactly on the target schema, with nothing left over', async () => {
		const plan = roundtripPlan(before, after, 'rt_parent');
		for (const leg of plan.legs) await apply(leg.statements);

		const runner = {
			all: async <T>(query: string) => (await DB.prepare(query).all<T>()).results,
			batch: async () => {},
		};
		const live = await introspect(runner);
		const only = (s: typeof live) => ({
			...s,
			tables: Object.fromEntries(
				Object.entries(s.tables).filter(([n]) => n.startsWith('rt_')),
			),
		});
		expect(diffSnapshots(only(live), only(after), {}).statements).toEqual([]);
		expect(diffSnapshots(only(after), only(live), {}).statements).toEqual([]);
	});

	// The window the header warns about, shown rather than asserted in prose.
	it('leaves the keys unenforced between pass 1 and pass 3', async () => {
		const plan = roundtripPlan(before, after, 'rt_parent');
		await apply(plan.legs[0]!.statements);

		// An orphan is accepted here and would not be after pass 3.
		await DB.prepare(`insert into "rt_child" ("id", "parent_id") values ('orphan', 'gone')`).run();
		await apply(plan.legs[1]!.statements);
		// The orphan's parent is gone, so restoring rt_child's key rejects it.
		await expect(apply(plan.legs[2]!.statements)).rejects.toThrow();
	});

	// Real schemas have these: a club pointing at its default label while the
	// label points back at the club. There is no order that restores both.
	it('refuses to order a closure containing a reference cycle', () => {
		// Built by patching the snapshot rather than by two mutually referencing
		// `sqliteTable` calls: those cannot be type-checked without an explicit
		// annotation, and the function under test takes snapshots anyway.
		const cyclic = (kinds: string) => {
			const one = sqliteTable('rt_a', {
				id: text('id').primaryKey(),
				bId: text('b_id'),
				kind: text('kind').notNull(),
			}, (t) => [check('rt_a_kind_enum', sql`${t.kind} in (${sql.raw(kinds)})`)]);
			const two = sqliteTable('rt_b', {
				id: text('id').primaryKey(),
				aId: text('a_id'),
			});
			const snapshot = snapshotFromSchema([one, two], '');
			// a -> b and b -> a: a cycle no restore order can satisfy.
			const link = (from: string, column: string, to: string) => ({
				...snapshot.tables[from]!,
				columns: {
					...snapshot.tables[from]!.columns,
					[column]: {
						...snapshot.tables[from]!.columns[column]!,
						references: {
							name: `${from}_${column}_fk`,
							columns: [column],
							tableTo: to,
							columnsTo: ['id'],
						},
					},
				},
			});
			return {
				...snapshot,
				tables: {
					...snapshot.tables,
					rt_a: link('rt_a', 'b_id', 'rt_b'),
					rt_b: link('rt_b', 'a_id', 'rt_a'),
				},
			} as typeof snapshot;
		};

		const plan = roundtripPlan(cyclic(`'x'`), cyclic(`'x', 'y'`), 'rt_a');
		expect(plan.closure).toEqual(['rt_b']);
		expect(plan.incomplete).toBe(true);
		expect(plan.legs.at(-1)!.errors.join(' ')).toMatch(/reference cycle/);
		// And the draft says so at the top rather than reading as runnable.
		expect(renderRoundtrip(plan)).toContain('INCOMPLETE');
	});

	it('generates no work for a pass that has none', () => {
		const unchanged = roundtripPlan(before, before, 'rt_parent');
		expect(unchanged.legs[1]!.statements).toEqual([]);
	});
});

describe('roundtripPlan leg 3 collation carry-forward', () => {
	// Regression: `carryForwardCollations(before, merged, {})` used to walk
	// *every* table in `before`, not just the ones just restored from the
	// schema-derived `after` in this level. A table with no connection to the
	// closure being restored — here "products", live-collated, sitting beside
	// an unrelated "orgs" <- "users" <- "posts" hierarchy — got `before`'s
	// collation folded onto its `after`-derived (uncollated) copy in `merged`,
	// which reads as "changes its collation" and forces a spurious (sometimes
	// destructive) recreate of a table the roundtrip never touches.
	const adapter = {
		async all<T>(sql: string): Promise<T[]> {
			return (await DB.prepare(sql).all()).results as T[];
		},
		async batch(statements: readonly string[]): Promise<void> {
			if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
		},
	};

	beforeEach(async () => {
		for (const name of ['orders', 'products', 'posts', 'users', 'orgs']) {
			await DB.prepare(`drop table if exists "${name}"`).run();
		}
		await DB.prepare('create table "orgs" ("id" text primary key, "name" text not null)').run();
		await DB.prepare(
			'create table "users" ("id" text primary key, '
				+ '"org_id" text not null references "orgs"("id"))',
		).run();
		await DB.prepare(
			'create table "posts" ("id" text primary key, '
				+ '"user_id" text not null references "users"("id"))',
		).run();
		await DB.prepare(
			'create table "products" ("id" text primary key, "sku" text collate nocase not null)',
		).run();
		await DB.prepare(
			'create table "orders" ("id" text primary key, '
				+ '"product_id" text not null references "products"("id"))',
		).run();
	});

	it('does not touch a table outside the closure being restored', async () => {
		const live = await introspect(adapter);

		// `after` stands in for the schema-derived snapshot `generate` diffs
		// against: identical shape, but structurally unable to state a
		// `collate` the schema DSL never expressed (the same gap [F-107]
		// closes for the persisted baseline).
		const cloned = structuredClone(live) as typeof live;
		const { collate: _dropped, ...skuRest } = cloned.tables['products']!.columns['sku']!;
		const schemaDerived: typeof live = {
			...cloned,
			// `snapshotFromSchema` always stamps `origin: 'schema'` — it is what
			// tells `columnDifference` an absent `collate` here means "the schema
			// DSL cannot express one", not "the live column lost it", the same
			// exemption that lets ordinary `generate` calls carry a collation
			// forward across the persisted snapshot without reporting drift.
			origin: 'schema',
			tables: {
				...cloned.tables,
				products: {
					...cloned.tables['products']!,
					columns: { ...cloned.tables['products']!.columns, sku: skuRest },
				},
			},
		};

		const plan = roundtripPlan(live, schemaDerived, 'orgs');
		expect(plan.incomplete).toBe(false);
		for (const leg of plan.legs) {
			expect(leg.errors).toEqual([]);
			for (const statement of leg.statements) {
				expect(statement.sql).not.toContain('products');
				expect(statement.sql).not.toContain('orders');
			}
		}
	});
});

describe('renderRoundtrip', () => {
	it('leads with a refusal to be treated as a migration', () => {
		const text = renderRoundtrip(roundtripPlan(before, after, 'rt_parent'));
		expect(text.startsWith('-- DRAFT — not a migration.')).toBe(true);
		expect(text).toContain('has to be its own migration');
		expect(text).toContain('Tables in the closure: rt_child, rt_grandchild');
	});

	it('marks the destructive statements so they are not skimmed past', () => {
		const text = renderRoundtrip(roundtripPlan(before, after, 'rt_parent'));
		expect(text).toContain('-- DESTRUCTIVE:');
	});

	it('says so when a pass could not be expressed', () => {
		const plan = { ...roundtripPlan(before, after, 'rt_parent') };
		const broken = {
			...plan,
			incomplete: true,
			legs: [{ ...plan.legs[0]!, errors: ['something could not be expressed'] }],
		};
		const text = renderRoundtrip(broken);
		expect(text).toContain('INCOMPLETE');
		expect(text).toContain('-- !! something could not be expressed');
	});
});
