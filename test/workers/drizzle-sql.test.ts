/**
 * Drizzle fragments executed against real D1.
 *
 * `test/unit/drizzle-sql.test.ts` proves the bridge renders the right text and
 * parameter slots. That is not the same claim as "D1 accepts it and returns the
 * right rows" — a fragment can compile to plausible SQL and still bind a
 * boolean where SQLite wants an integer, or quote an identifier a way the
 * parser rejects. This file closes that gap: every fragment here is built with
 * Drizzle's own operators over orm-d1 columns, run through an orm-d1 query, and
 * checked against the rows the equivalent orm-d1 expression returns.
 *
 * This is the path Pothos' model loader takes when it batches by primary key.
 */
import { env } from 'cloudflare:test';
import { and as dAnd, eq as dEq, gt as dGt, inArray as dInArray, or as dOr, sql as dSql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { asDrizzleTable } from '../../src/drizzle.js';
import { and, drizzle, eq, gt, inArray, sql } from '../../src/index.js';
import * as schema from '../schema.js';

const DB = (env as { DB: D1Database }).DB;
const db = drizzle({ client: DB, relations: schema.relations });

/** The same objects, typed as Drizzle's. Identity at runtime. */
const dUsers = asDrizzleTable(schema.users);
const dPosts = asDrizzleTable(schema.posts);

const ids = (rows: readonly { id: number }[]) => rows.map((r) => r.id);

beforeAll(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(schema.allTables)) await DB.prepare(statement).run();

	await db.insert(schema.users).values([
		{ id: 1, email: 'ada@example.com', name: 'Ada', active: true, createdAt: new Date(0) },
		{ id: 2, email: 'bob@example.com', name: 'Bob', active: false, createdAt: new Date(0) },
	]);
	await db.insert(schema.posts).values([
		{ id: 10, authorId: 1, title: 'first', views: 5 },
		{ id: 11, authorId: 1, title: 'second', views: 50 },
		{ id: 12, authorId: 2, title: 'third', views: 1 },
	]);
});

describe('a Drizzle fragment in an orm-d1 where clause', () => {
	it('returns what the equivalent orm-d1 expression returns', async () => {
		const theirs = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(dGt(dPosts.views, 1) as never).orderBy(schema.posts.id).all();
		const ours = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(gt(schema.posts.views, 1)).orderBy(schema.posts.id).all();

		expect(ids(theirs)).toEqual([10, 11]);
		expect(theirs).toEqual(ours);
	});

	it('binds through the column encoder — a boolean has to reach D1 as an integer', async () => {
		// `active` is `mode: 'boolean'`. Binding `true` unencoded is the failure
		// this catches, and it is invisible to a text-only assertion.
		const rows = await db.select({ id: schema.users.id }).from(schema.users)
			.where(dEq(dUsers.active, true) as never).all();
		expect(ids(rows)).toEqual([1]);
	});

	it('runs inArray, including the composite tuple form the Pothos loader builds', async () => {
		const single = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(dInArray(dPosts.id, [10, 12]) as never).orderBy(schema.posts.id).all();
		expect(ids(single)).toEqual([10, 12]);

		// `(a, b) in ((?, ?), (?, ?))` — what the loader emits for a composite
		// key, with the row values Drizzle builds from a nested array. Row-value
		// syntax is the part SQLite could refuse, so it is run, not just rendered.
		const tuple = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(
				dInArray(
					dSql`(${dSql.join([dPosts.id, dPosts.authorId], dSql`, `)})` as never,
					[[10, 1], [12, 2]] as never,
				) as never,
			)
			.orderBy(schema.posts.id)
			.all();
		expect(ids(tuple)).toEqual([10, 12]);
	});

	it('composes with our own operators in one predicate', async () => {
		const rows = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(and(eq(schema.posts.authorId, 1), dGt(dPosts.views, 10) as never))
			.all();
		expect(ids(rows)).toEqual([11]);
	});

	it('nests and/or without losing a parameter or its order', async () => {
		const rows = await db.select({ id: schema.posts.id }).from(schema.posts)
			.where(dOr(dAnd(dEq(dPosts.authorId, 1), dGt(dPosts.views, 10)), dEq(dPosts.id, 12))! as never)
			.orderBy(schema.posts.id)
			.all();
		expect(ids(rows)).toEqual([11, 12]);
	});

	it('works as a RAW filter in db.query, which is how adapters reach it', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			where: { RAW: (table) => dInArray((table as never as typeof dPosts).id, [10, 11]) as never },
			orderBy: { id: 'asc' },
		});
		expect(ids(rows)).toEqual([10, 11]);
	});

	it('renders as a projected expression, not only as a predicate', async () => {
		const rows = await db.select({ shouty: dSql<string>`upper(${dUsers.email})` as never })
			.from(schema.users).orderBy(schema.users.id).all();
		expect(rows.map((r) => r.shouty)).toEqual(['ADA@EXAMPLE.COM', 'BOB@EXAMPLE.COM']);
	});

	it('agrees with our own rendering of the same predicate, statement for statement', async () => {
		const seen: string[] = [];
		const counted = drizzle({ client: DB, relations: schema.relations, onQuery: (e) => seen.push(e.sql) });

		await counted.select({ id: schema.posts.id }).from(schema.posts)
			.where(dInArray(dPosts.id, [10, 11]) as never).all();
		await counted.select({ id: schema.posts.id }).from(schema.posts)
			.where(inArray(schema.posts.id, [10, 11])).all();

		expect(seen[0]).toBe(seen[1]);
	});
});

describe('a Drizzle fragment carrying a placeholder', () => {
	it('binds Drizzle’s own placeholder at execution time', async () => {
		const query = db.select({ id: schema.posts.id }).from(schema.posts)
			.where(dEq(dPosts.id, dSql.placeholder('wanted')) as never);

		expect(ids(await query.all({ wanted: 11 }))).toEqual([11]);
		expect(ids(await query.all({ wanted: 12 }))).toEqual([12]);
	});

	it('binds an orm-d1 placeholder interpolated into a Drizzle fragment', async () => {
		// Easy to write once both are in scope. Drizzle does not recognise ours,
		// so without the bridge handling it the object reaches `.bind()` and D1
		// answers `Type 'object' not supported` from a line that looks correct.
		const query = db.select({ id: schema.posts.id }).from(schema.posts)
			.where(dEq(dPosts.id, sql.placeholder('wanted') as never) as never);

		expect(ids(await query.all({ wanted: 10 }))).toEqual([10]);
	});
});
