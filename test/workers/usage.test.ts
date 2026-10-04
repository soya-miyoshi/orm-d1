/**
 * `usage` and `budget` against a real D1 (`docs/08-observability.md` §1–§3).
 *
 * The unit suite pins the arithmetic against a stub that reports whatever it is
 * told. What only D1 can say is here: that `rows_read` / `rows_written` arrive
 * in real `meta` and reach the totals, and that the totals see every statement
 * actually sent — each member of a `batch()`, each chunk of a chunked write,
 * and every statement a `withSession()` database runs.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import type { QueryEvent } from '../../src/index.js';
import {
	count,
	D1BudgetExceededError,
	defineRelations,
	drizzle,
	eq,
	integer,
	ormD1,
	primaryKey,
	sqliteTable,
	text,
} from '../../src/index.js';
import { allTables, posts, users } from '../schema.js';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(allTables)) await DB.prepare(statement).run();
	const db = ormD1(DB);
	await db.insert(users).values([
		{ id: 1, email: 'a@b.c', name: 'Ada' },
		{ id: 2, email: 'b@b.c', name: 'Bob' },
	]);
	await db.insert(posts).values([
		{ id: 10, authorId: 1, title: 'first' },
		{ id: 11, authorId: 1, title: 'second' },
	]);
});

describe('usage against real D1', () => {
	it('totals the rows D1 reports reading and writing', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(DB, { usage: true, onQuery: (e) => events.push(e) });

		await db.select({ id: users.id }).from(users);
		await db.insert(posts).values({ id: 20, authorId: 2, title: 'third' }).run();

		const usage = db.usage();
		expect(usage.statements).toBe(2);
		// Real meta, not a stub's: non-zero, and equal to what onQuery was told.
		expect(usage.rowsRead).toBeGreaterThan(0);
		expect(usage.rowsWritten).toBeGreaterThan(0);
		expect(usage.rowsRead).toBe(events.reduce((n, e) => n + e.rowsRead, 0));
		expect(usage.rowsWritten).toBe(events.reduce((n, e) => n + e.rowsWritten, 0));
		expect(usage.byTable['users']!.rowsRead).toBe(events[0]!.rowsRead);
		expect(usage.byTable['posts']!.rowsWritten).toBe(events[1]!.rowsWritten);
	});

	it('reads rows_read off a select with no onQuery listening', async () => {
		// Without a listener a select reads through `.raw()`, which carries no
		// meta at all. The meter has to keep it on the keyed path.
		const db = ormD1(DB, { usage: true });
		await db.select({ id: users.id }).from(users);
		expect(db.usage().rowsRead).toBeGreaterThan(0);
	});

	it('counts each member of a batch', async () => {
		const db = ormD1(DB, { usage: true });
		await db.batch([
			db.select({ id: users.id }).from(users),
			db.select({ id: posts.id }).from(posts),
			db.delete(posts).where(eq(posts.id, 11)),
		]);

		const usage = db.usage();
		expect(usage.statements).toBe(3);
		expect(usage.byKind).toMatchObject({ select: 2, delete: 1 });
		expect(usage.byTable['users']!.statements).toBe(1);
		expect(usage.byTable['posts']!.statements).toBe(2);
		expect(usage.rowsWritten).toBeGreaterThan(0);
	});

	it('counts each chunk of a chunked write', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(DB, { usage: true, maxParams: 10, onQuery: (e) => events.push(e) });
		const rows = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, authorId: 1, title: `t${i}` }));
		await db.insert(posts).values(rows).run();

		// Ten params a statement cannot carry twelve rows: chunked, every chunk sent.
		expect(events.length).toBeGreaterThan(1);
		const usage = db.usage();
		expect(usage.statements).toBe(events.length);
		expect(usage.byKind.insert).toBe(events.length);
		expect(usage.rowsWritten).toBe(events.reduce((n, e) => n + e.rowsWritten, 0));
		// The chunks share one SQL text but are one logical statement: each is a
		// statement D1 runs, none is a repeat.
		expect(events.filter((e) => e.sql === events[0]!.sql).length).toBeGreaterThan(1);
		expect(usage.repeats).toEqual([]);
		expect(await ormD1(DB).select({ n: count() }).from(posts)).toEqual([{ n: 14 }]);
	});

	it('shares one accumulator with a withSession() database', async () => {
		const db = ormD1(DB, { usage: true });
		const session = db.withSession('first-primary');

		await db.select({ id: users.id }).from(users);
		await session.select({ id: posts.id }).from(posts);
		await session.insert(posts).values({ id: 30, authorId: 2, title: 's' }).run();

		const usage = db.usage();
		expect(usage.statements).toBe(3);
		expect(session.usage()).toEqual(usage);
		expect(usage.byTable['posts']!.statements).toBe(2);
		expect(usage.rowsWritten).toBeGreaterThan(0);
	});
});

describe('budget against real D1', () => {
	it('refuses before sending, so a refused write never lands', async () => {
		const db = ormD1(DB, { budget: { maxStatements: 1, onExceeded: 'throw' } });
		await db.select({ id: users.id }).from(users);

		await expect(db.insert(posts).values({ id: 40, authorId: 1, title: 'refused' }).run())
			.rejects.toBeInstanceOf(D1BudgetExceededError);
		expect(await ormD1(DB).select({ id: posts.id }).from(posts).where(eq(posts.id, 40))).toEqual([]);
	});

	it('stops on rows actually read', async () => {
		const db = ormD1(DB, { budget: { maxRowsRead: 1, onExceeded: 'throw' } });
		// Two users: D1 reports at least two rows read, past a ceiling of one.
		await db.select({ id: users.id }).from(users);
		const error = await db.select({ id: users.id }).from(users).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(D1BudgetExceededError);
		expect((error as D1BudgetExceededError).observed).toBeGreaterThan(1);
	});
});

describe('a relational read that chunks its child query', () => {
	// A composite key binds a parameter per key column per parent, so 24
	// parents against a cap of 10 split the child read into several chunks.
	const regions = sqliteTable('usage_regions', {
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
	}, (t) => [primaryKey({ columns: [t.country, t.zone] })]);
	const sites = sqliteTable('usage_sites', {
		id: integer('id').primaryKey(),
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
	});
	const relations = defineRelations({ regions, sites }, (r) => ({
		regions: { sites: r.many.sites() },
		sites: {
			region: r.one.regions({ from: [r.sites.country, r.sites.zone], to: [r.regions.country, r.regions.zone] }),
		},
	}));
	const PARENTS = 24;

	beforeEach(async () => {
		for (const name of ['usage_sites', 'usage_regions']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([regions, sites])) await DB.prepare(statement).run();
		const seed = ormD1(DB);
		await seed.insert(regions).values(Array.from({ length: PARENTS }, (_, i) => ({ country: `c${i}`, zone: i })));
		await seed.insert(sites).values(
			Array.from({ length: PARENTS }, (_, i) => ({ id: i + 1, country: `c${i}`, zone: i })),
		);
	});

	it('counts every chunk as a statement and the read as one execution of each shape', async () => {
		const events: QueryEvent[] = [];
		const db = drizzle({
			client: DB,
			relations,
			maxParams: 10,
			usage: true,
			budget: { repeatsPerShape: 1, onExceeded: 'throw' },
			onQuery: (e) => events.push(e),
		});
		const read = () =>
			db.query.regions.findMany({
				columns: { country: true, zone: true },
				with: { sites: { columns: { id: true } } },
			});

		const rows = await read();
		expect(rows).toHaveLength(PARENTS);
		expect(rows.every((r) => r.sites.length === 1)).toBe(true);

		// Several identical full-size child chunks — each one counted as a statement.
		const children = events.slice(1);
		expect(children.filter((e) => e.sql === children[0]!.sql).length).toBeGreaterThan(1);
		expect(db.usage().statements).toBe(events.length);
		expect(db.usage().repeats).toEqual([]);

		// Running the whole read a second time is a repeat, and it is refused.
		await expect(read()).rejects.toBeInstanceOf(D1BudgetExceededError);
	});
});

