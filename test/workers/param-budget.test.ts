/**
 * D1's bound-parameter budget, at the seams where two correct decisions meet.
 *
 * These run against real workerd + D1 rather than asserting on compiled SQL:
 * the failure being pinned here is `too many SQL variables`, which only SQLite
 * can tell us about.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { blob, drizzle, inArray, integer, sqliteTable, text } from '../../src/index.js';
import { defineRelations } from '../../src/relations/index.js';

const DB = (env as { DB: D1Database }).DB;

// A blob primary key — UUID-as-bytes is a real pattern, and the one key shape
// that cannot collapse to a single `json_each` parameter.
const owners = sqliteTable('pb_owners', {
	id: blob('id').primaryKey(),
	name: text('name'),
});
const items = sqliteTable('pb_items', {
	id: integer('id').primaryKey(),
	ownerId: blob('owner_id').notNull(),
});

// The integer control, so a regression in chunking cannot be mistaken for a
// regression in stitching.
const nOwners = sqliteTable('pi_owners', {
	id: integer('id').primaryKey(),
	name: text('name'),
});
const nItems = sqliteTable('pi_items', {
	id: integer('id').primaryKey(),
	ownerId: integer('owner_id').notNull(),
});

const relations = defineRelations({ owners, items, nOwners, nItems }, (r) => ({
	owners: { items: r.many.items() },
	items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
	nOwners: { items: r.many.nItems() },
	nItems: { owner: r.one.nOwners({ from: r.nItems.ownerId, to: r.nOwners.id }) },
}));

const db = drizzle({ client: DB, relations });

// Comfortably past the default 100-parameter budget.
const N = 150;
const keyOf = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff, 0xaa, 0xbb]);

const allTables = [owners, items, nOwners, nItems];

beforeEach(async () => {
	for (const name of ['pb_items', 'pb_owners', 'pi_items', 'pi_owners']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(allTables)) await DB.prepare(statement).run();

	await db.insert(owners).values(Array.from({ length: N }, (_, i) => ({ id: keyOf(i), name: `n${i}` })));
	await db.insert(items).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, ownerId: keyOf(i) })));
	await db.insert(nOwners).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, name: `n${i}` })));
	await db.insert(nItems).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, ownerId: i + 1 })));
});

describe('relational loads over more parents than the parameter budget', () => {
	it('chunks a blob key, which cannot collapse to json_each', async () => {
		const rows = await db.query.owners.findMany({ with: { items: true } });

		expect(rows).toHaveLength(N);
		expect(rows.filter((r) => r.items.length > 0)).toHaveLength(N);
		// Every parent got its own child, not somebody else's.
		for (const row of rows) {
			expect(row.items).toHaveLength(1);
			expect(row.items[0]!.ownerId).toEqual(row.id);
		}
	});

	it('loads a one relation back across the same blob key', async () => {
		const rows = await db.query.items.findMany({ with: { owner: true } });

		expect(rows).toHaveLength(N);
		expect(rows.every((r) => r.owner !== null)).toBe(true);
		for (const row of rows) expect(row.owner!.id).toEqual(row.ownerId);
	});

	it('control: an integer key still collapses and still stitches', async () => {
		const rows = await db.query.nOwners.findMany({ with: { items: true } });

		expect(rows).toHaveLength(N);
		for (const row of rows) {
			expect(row.items).toHaveLength(1);
			expect(row.items[0]!.ownerId).toBe(row.id);
		}
	});

	it('chunks a blob key under a per-parent window too', async () => {
		const rows = await db.query.owners.findMany({
			with: { items: { limit: 1 } },
		});

		expect(rows).toHaveLength(N);
		expect(rows.filter((r) => r.items.length === 1)).toHaveLength(N);
	});
});

describe('inArray against the budget directly', () => {
	it('names the budget rather than leaking SQLITE_ERROR for binary values', async () => {
		const many = Array.from({ length: N }, (_, i) => keyOf(i));

		await expect(db.select().from(owners).where(inArray(owners.id, many)))
			.rejects.toThrow(/exceeds the bound-parameter limit of 100.*no json_each spelling/s);
	});

	it('lets a collapsible array of the same length through', async () => {
		const many = Array.from({ length: N }, (_, i) => i + 1);
		const rows = await db.select().from(nOwners).where(inArray(nOwners.id, many));

		expect(rows).toHaveLength(N);
	});
});

/**
 * The gap between "these values *could* collapse to `json_each`" and "this call
 * *will* collapse them".
 *
 * `collapsesToJsonEach` answers only the first question — it asks whether the
 * values have a faithful JSON spelling, which every integer does. `InArray`
 * asks a second one before switching strategy: is the list at least
 * `jsonEachThreshold` long? Below the threshold it binds one parameter per
 * value, exactly like a composite key.
 *
 * The chunker tested only the first, so a short key list disabled chunking
 * (`maxKeys = keys.length`) while still binding one parameter each — and the
 * budget deliberately reserved for the child's own predicates was handed back
 * out. The statement then overflowed by exactly the reserved count, which
 * surfaces as D1's bare `too many SQL variables`.
 *
 * Reachable at stock defaults only with a child filter binding >71 parameters,
 * so this reaches it the documented way instead: a lowered `maxParams`, which
 * is the lever for shorter statements.
 */
describe('a key list too short to reach json_each', () => {
	// 9 parents against a budget of 10, with a threshold they cannot reach.
	const tight = drizzle({ client: DB, relations, maxParams: 10, jsonEachThreshold: 10 });
	const PARENTS = 9;

	/** Three bound parameters in the child's own `where`, and no more. */
	const childWhere = { id: { gte: 1, lte: 10_000 }, ownerId: { gte: 1 } } as const;

	it('does not overflow D1’s real limit at the stock budget', async () => {
		// The failure as it actually arrives, against the 100 D1 enforces —
		// confirmed here rather than assumed, since our `maxParams` is a budget
		// and not the database's own ceiling.
		//
		// 99 parents is one short of the threshold, so every key binds a
		// parameter, and the child's `where` binds three more: 102 against 100.
		// The reserved budget was computed correctly and then discarded, so this
		// used to come back as a bare `too many SQL variables` naming nothing.
		const raised = drizzle({ client: DB, relations, jsonEachThreshold: 100 });

		const rows = await raised.query.nOwners.findMany({
			columns: { id: true },
			where: { id: { lte: 99 } },
			with: { items: { columns: { id: true, ownerId: true }, where: childWhere } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toHaveLength(99);
		for (const row of rows) expect(row.items[0]!.ownerId).toBe(row.id);
	});

	it('chunks by the remaining budget instead of binding the whole list', async () => {
		const rows = await tight.query.nOwners.findMany({
			columns: { id: true },
			where: { id: { lte: PARENTS } },
			with: { items: { columns: { id: true, ownerId: true }, where: childWhere } },
			orderBy: { id: 'asc' },
		});

		// Every parent still gets its own child: chunking must not lose or
		// cross-wire a bucket, which is the failure mode a naive fix invites.
		expect(rows).toHaveLength(PARENTS);
		for (const row of rows) {
			expect(row.items).toHaveLength(1);
			expect(row.items[0]!.ownerId).toBe(row.id);
		}
	});

	it('sends more than one child statement, which is what proves it chunked', async () => {
		// Without this the test above passes on the broken code the moment the
		// budget happens to be generous enough — the assertion that matters is
		// that the keys were split at all.
		const sqls: string[] = [];
		const counted = drizzle({
			client: DB,
			relations,
			maxParams: 10,
			jsonEachThreshold: 10,
			onQuery: (e) => void sqls.push(e.sql),
		});

		await counted.query.nOwners.findMany({
			columns: { id: true },
			where: { id: { lte: PARENTS } },
			with: { items: { columns: { id: true }, where: childWhere } },
		});

		// One for the parents, then the children split across the 7 slots the
		// child's 3 reserved parameters leave of the 10.
		expect(sqls).toHaveLength(3);
		expect(sqls.filter((s) => s.includes('json_each'))).toHaveLength(0);
	});

	it('still collapses once the list is long enough to be worth it', async () => {
		// The control: the same query over enough parents takes the json_each
		// path and needs no chunking, so the fix narrowed the condition rather
		// than disabling the optimisation.
		const sqls: string[] = [];
		const counted = drizzle({
			client: DB,
			relations,
			maxParams: 10,
			jsonEachThreshold: 10,
			onQuery: (e) => void sqls.push(e.sql),
		});

		await counted.query.nOwners.findMany({
			columns: { id: true },
			where: { id: { lte: 20 } },
			with: { items: { columns: { id: true }, where: childWhere } },
		});

		expect(sqls).toHaveLength(2);
		expect(sqls[1]).toContain('json_each');
	});
});
