import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { setDev, setWarn } from '../../src/dev.js';
import type { QueryEvent } from '../../src/index.js';
import {
	alias,
	and,
	asc,
	count,
	ormD1,
	desc,
	eq,
	gt,
	inArray,
	NoTransactionsError,
	ph,
	query,
	sql,
} from '../../src/index.js';
import { allTables, postTags, posts, users } from '../schema.js';

const DB = (env as { DB: D1Database }).DB;

const reset = async (): Promise<void> => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(allTables)) await DB.prepare(statement).run();
};

const seed = async (): Promise<void> => {
	const db = ormD1(DB);
	await db.insert(users).values([
		{ id: 1, email: 'a@b.c', name: 'Ada', active: true, score: 9.5, createdAt: new Date(1000) },
		{ id: 2, email: 'b@b.c', name: 'Bob', active: false, createdAt: new Date(2000) },
	]);
	await db.insert(posts).values([
		{ id: 10, authorId: 1, title: 'first', views: 5 },
		{ id: 11, authorId: 1, title: 'second', views: 50 },
	]);
};

beforeEach(async () => {
	await reset();
});

describe('the generated DDL runs on real D1', () => {
	it('creates every fixture table, index and constraint', async () => {
		// `_cf_METADATA` is D1's own bookkeeping table.
		const tables = await DB.prepare(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
				+ "and name not like '\\_cf\\_%' escape '\\' order by name",
		).all<{ name: string }>();
		expect(tables.results.map((r) => r.name)).toEqual(['post_tags', 'posts', 'users']);

		const indexes = await DB.prepare(
			"select name from sqlite_master where type = 'index' and sql is not null order by name",
		).all<{ name: string }>();
		expect(indexes.results.map((r) => r.name)).toContain('users_email_active_idx');
	});

	it('enforces the check constraint it generated', async () => {
		await expect(
			ormD1(DB).insert(users).values({ email: 'x@y.z', score: -1 }).run(),
		).rejects.toThrow();
	});
});

describe('reads and writes', () => {
	beforeEach(seed);

	it('selects and decodes every column type', async () => {
		const db = ormD1(DB);
		const row = await db.select().from(users).where(eq(users.id, 1)).get();

		expect(row).toEqual({
			id: 1,
			email: 'a@b.c',
			name: 'Ada',
			role: 'member',
			active: true,
			settings: null,
			score: 9.5,
			createdAt: new Date(1000),
			// `updatedAt` carries `$onUpdate` and no `default`, so an insert that
			// does not specify it now populates it too (F-005) — matching
			// drizzle-orm's `buildInsertQuery`, rather than leaving it null until
			// the first update.
			updatedAt: new Date(0),
		});
	});

	it('round-trips json and boolean columns', async () => {
		const db = ormD1(DB);
		await db.update(users).set({ settings: { theme: 'dark' }, active: false })
			.where(eq(users.id, 1))
			.run();

		const row = await db.select({ settings: users.settings, active: users.active })
			.from(users).where(eq(users.id, 1)).get();
		expect(row).toEqual({ settings: { theme: 'dark' }, active: false });
	});

	it('applies $onUpdate on every update', async () => {
		const db = ormD1(DB);
		await db.update(users).set({ name: 'Ada L.' }).where(eq(users.id, 1)).run();
		const row = await db.select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, 1)).get();
		expect(row?.updatedAt).toEqual(new Date(0));
	});

	it('populates a plain $onUpdate column on insert too, not just on update', async () => {
		// F-005: a column with `$onUpdate` and no `default` is populated at
		// insert time as well, matching drizzle-orm's `buildInsertQuery` — it
		// used to stay null until the first `update()` touched the row.
		const db = ormD1(DB);
		await db.insert(users).values({ id: 3, email: 'c@b.c' }).run();
		const row = await db.select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, 3)).get();
		expect(row?.updatedAt).not.toBeNull();
		expect(row?.updatedAt).toEqual(new Date(0));
	});

	it('returns inserted rows in order', async () => {
		const db = ormD1(DB);
		const returned = await db.insert(posts)
			.values([{ id: 20, authorId: 2, title: 'x' }, { id: 21, authorId: 2, title: 'y' }])
			.returning({ id: posts.id, title: posts.title });

		expect(returned).toEqual([{ id: 20, title: 'x' }, { id: 21, title: 'y' }]);
	});

	it('upserts', async () => {
		const db = ormD1(DB);
		await db.insert(users).values({ email: 'a@b.c', name: 'Replaced' })
			.onConflictDoUpdate({ target: users.email, set: { name: 'Replaced' } })
			.run();

		const rows = await db.select({ name: users.name }).from(users).where(eq(users.email, 'a@b.c'));
		expect(rows).toEqual([{ name: 'Replaced' }]);
	});

	it('deletes and reports the change count', async () => {
		const db = ormD1(DB);
		const result = await db.delete(posts).where(eq(posts.id, 10)).run();
		expect(result.meta.changes).toBe(1);
		expect(await db.select({ n: count() }).from(posts)).toEqual([{ n: 1 }]);
	});

	it('inserts 500 rows atomically and returns all of them in order', async () => {
		const db = ormD1(DB);
		const rows = Array.from({ length: 500 }, (_, i) => ({
			id: 1000 + i,
			authorId: 1,
			title: `t${i}`,
			views: i,
		}));

		const returned = await db.insert(posts).values(rows).returning({ id: posts.id });
		expect(returned).toHaveLength(500);
		expect(returned.map((r) => r.id)).toEqual(rows.map((r) => r.id));
		expect(await db.select({ n: count() }).from(posts)).toEqual([{ n: 502 }]);
	});

	it('rolls the whole chunked insert back when one chunk fails', async () => {
		const db = ormD1(DB);
		const rows = Array.from({ length: 120 }, (_, i) => ({ id: 2000 + i, authorId: 1, title: 't' }));
		rows[119] = { id: 10, authorId: 1, title: 'duplicate' };

		await expect(db.insert(posts).values(rows).run()).rejects.toThrow();
		expect(await db.select({ n: count() }).from(posts)).toEqual([{ n: 2 }]);
	});
});

describe('joins', () => {
	beforeEach(seed);

	it('nests one group per table and nulls missing left-joined rows', async () => {
		const db = ormD1(DB);
		const rows = await db.select().from(users)
			.leftJoin(posts, eq(posts.authorId, users.id))
			.orderBy(asc(users.id), asc(posts.id));

		expect(rows).toHaveLength(3);
		expect(rows[0]!.users.id).toBe(1);
		expect(rows[0]!.posts?.title).toBe('first');
		expect(rows[2]!.users.id).toBe(2);
		expect(rows[2]!.posts).toBeNull();
	});

	it('keeps duplicate column names distinct on the direct read path', async () => {
		const db = ormD1(DB);
		const rows = await db.select({ userId: users.id, postId: posts.id })
			.from(users)
			.innerJoin(posts, eq(posts.authorId, users.id))
			.orderBy(asc(posts.id));

		expect(rows).toEqual([{ userId: 1, postId: 10 }, { userId: 1, postId: 11 }]);
	});

	it('keeps them distinct inside batch(), where D1 returns keyed objects', async () => {
		const db = ormD1(DB);
		const [rows] = await db.batch([
			db.select({ a: { id: users.id }, b: { id: posts.id } })
				.from(users)
				.innerJoin(posts, eq(posts.authorId, users.id))
				.orderBy(asc(posts.id)),
		]);

		expect(rows).toEqual([
			{ a: { id: 1 }, b: { id: 10 } },
			{ a: { id: 1 }, b: { id: 11 } },
		]);
	});

	it('self-joins through an alias', async () => {
		const db = ormD1(DB);
		const author = alias(users, 'author');
		const rows = await db.select({ title: posts.title, author: author.name })
			.from(posts)
			.innerJoin(author, eq(author.id, posts.authorId))
			.orderBy(desc(posts.views));

		expect(rows).toEqual([{ title: 'second', author: 'Ada' }, { title: 'first', author: 'Ada' }]);
	});

	it('selects from a subquery', async () => {
		const db = ormD1(DB);
		const popular = db.select({ id: posts.id, views: posts.views }).from(posts)
			.where(gt(posts.views, 10))
			.as('popular');

		expect(await db.select({ id: popular.id }).from(popular)).toEqual([{ id: 11 }]);
	});

	it('selects from a subquery over a join, which renames the whole projection', async () => {
		// The compiled-SQL version of this is in the unit suite; this is the
		// half that matters, because the symptom was `no such column` from D1
		// rather than anything visible at compile time. A subquery whose
		// declared surface disagreed with its own statement typechecked, read
		// correctly, and only failed here.
		const db = ormD1(DB);
		const s = db.select().from(posts).innerJoin(users, eq(users.id, posts.authorId)).as('s');

		const rows = await db.select({ title: s.posts.title, author: s.users.name })
			.from(s)
			.where(gt(s.posts.views, 10));

		expect(rows).toEqual([{ title: 'second', author: 'Ada' }]);
	});

	it('runs an implicit select over such a subquery, regrouped as it went in', async () => {
		const db = ormD1(DB);
		const s = db.select().from(posts).innerJoin(users, eq(users.id, posts.authorId)).as('s');

		const rows = await db.select().from(s).where(gt(s.posts.views, 10));

		// `from(s)` with no selection reads the subquery's own columns back out,
		// so the nesting has to survive a round trip through `.as()`.
		expect(rows).toEqual([{ posts: expect.objectContaining({ title: 'second' }), users: expect.objectContaining({ name: 'Ada' }) }]);
	});

	it('gives a missed left join the same null group through .as() as directly', async () => {
		// Two spellings of one query used to give two shapes: `posts: null`
		// read directly, `posts: { id: null, … }` read back out of the
		// subquery, because the outer plan has no joins to re-derive it from.
		// Bob has no posts.
		const db = ormD1(DB);
		const on = eq(posts.authorId, users.id);

		const direct = await db.select().from(users).leftJoin(posts, on).where(eq(users.id, 2));

		const s = db.select().from(users).leftJoin(posts, on).as('s');
		const viaSubquery = await db.select().from(s).where(eq(s.users.id, 2));

		expect(direct).toEqual([{ users: expect.objectContaining({ name: 'Bob' }), posts: null }]);
		expect(viaSubquery).toEqual(direct);
	});

	it('collapses a group produced by joining to a nested subquery, not an object of nulls', async () => {
		// `s` is itself an inner join wrapped in `.as()`, so every leaf under
		// the outer `s` group sits two levels deeper than a plain joined
		// table's leaves (`s.posts.id` / `s.users.id` rather than `s.id`) —
		// `s` has no *direct* depth-2 Column leaf of its own to key a null
		// check off. Cara has no posts, so the inner join inside `s` never
		// produces a row for her, and the outer left join to `s` must read
		// back as `s: null` — not `{ posts: {...}, users: {...} }` with every
		// field null.
		const db = ormD1(DB);
		await db.insert(users).values({ id: 3, email: 'c@b.c', name: 'Cara', active: true });
		const s = db.select().from(posts).innerJoin(users, eq(users.id, posts.authorId)).as('s');

		const rows = await db.select().from(users).leftJoin(s, eq(s.users.id, users.id)).where(eq(users.id, 3));

		expect(rows).toEqual([{ users: expect.objectContaining({ name: 'Cara' }), s: null }]);
	});
});

describe('expressions against real SQLite', () => {
	beforeEach(seed);

	it('runs a long inArray through json_each', async () => {
		const db = ormD1(DB);
		const ids = [1, ...Array.from({ length: 200 }, (_, i) => 500 + i)];
		const rows = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
		expect(rows).toEqual([{ id: 1 }]);
	});

	it('groups, filters and orders', async () => {
		const db = ormD1(DB);
		const rows = await db.select({ author: posts.authorId, views: sql<number>`sum(${posts.views})` })
			.from(posts)
			.groupBy(posts.authorId)
			.having(gt(count(), 1));

		expect(rows).toEqual([{ author: 1, views: 55 }]);
	});

	it('honours a composite primary key', async () => {
		const db = ormD1(DB);
		await db.insert(postTags).values({ postId: 10, tag: 'sql' }).run();
		await expect(db.insert(postTags).values({ postId: 10, tag: 'sql' }).run()).rejects.toThrow();
	});
});

describe('compiled queries and placeholders', () => {
	beforeEach(seed);

	it('runs a query compiled without any database', async () => {
		const byEmail = query.select({ id: users.id, name: users.name })
			.from(users)
			.where(and(eq(users.email, ph('email')), eq(users.active, ph('active'))))
			.compile();

		const db = ormD1(DB);
		expect(await db.get(byEmail, { email: 'a@b.c', active: true })).toEqual({ id: 1, name: 'Ada' });
		expect(await db.all(byEmail, { email: 'b@b.c', active: true })).toEqual([]);
	});

	it('reuses one compilation across pages', async () => {
		const page = query.select({ id: posts.id }).from(posts)
			.orderBy(asc(posts.id))
			.limit(ph('limit'))
			.offset(ph('offset'))
			.compile();

		const db = ormD1(DB);
		expect(await db.all(page, { limit: 1, offset: 0 })).toEqual([{ id: 10 }]);
		expect(await db.all(page, { limit: 1, offset: 1 })).toEqual([{ id: 11 }]);
	});
});

describe('batch', () => {
	beforeEach(seed);

	it('returns a tuple typed per statement, in one round trip', async () => {
		const db = ormD1(DB);
		const [inserted, rows, deleted] = await db.batch([
			db.insert(posts).values({ id: 30, authorId: 2, title: 'batched' }).returning({ id: posts.id }),
			db.select({ id: posts.id }).from(posts).orderBy(asc(posts.id)),
			db.delete(posts).where(eq(posts.id, 10)),
		]);

		expect(inserted).toEqual([{ id: 30 }]);
		expect(rows.map((r) => r.id)).toEqual([10, 11, 30]);
		expect(deleted.meta.changes).toBe(1);
	});

	it('is all-or-nothing', async () => {
		const db = ormD1(DB);
		await expect(db.batch([
			db.insert(posts).values({ id: 40, authorId: 1, title: 'ok' }),
			db.insert(posts).values({ id: 10, authorId: 1, title: 'duplicate' }),
		])).rejects.toThrow();

		expect(await db.select({ n: count() }).from(posts)).toEqual([{ n: 2 }]);
	});
});

describe('sessions', () => {
	beforeEach(seed);

	it('reads its own writes and hands back a bookmark', async () => {
		const db = ormD1(DB);
		const session = db.withSession('first-primary');

		await session.insert(posts).values({ id: 50, authorId: 1, title: 'session' }).run();
		const rows = await session.select({ id: posts.id }).from(posts).where(eq(posts.id, 50));
		expect(rows).toEqual([{ id: 50 }]);

		const bookmark = session.bookmark();
		const resumed = db.withSession(bookmark ?? 'first-unconstrained');
		expect(await resumed.select({ id: posts.id }).from(posts).where(eq(posts.id, 50)))
			.toEqual([{ id: 50 }]);
	});
});

describe('observability and errors', () => {
	beforeEach(seed);

	it('counts real statements against the plan’s per-invocation limit', async () => {
		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));

		try {
			const db = ormD1(DB, { plan: 'free' });
			// 51 statements: one past the free plan's 50. Sent as batches so the
			// test also pins that a batch member counts individually, which is
			// how D1 counts them.
			for (let i = 0; i < 5; i++) {
				await db.batch(Array.from({ length: 10 }, () => db.select({ id: users.id }).from(users)));
			}
			await db.select({ id: users.id }).from(users);
		} finally {
			setDev(false);
		}

		expect(messages.filter((m) => m.includes('queries per Worker invocation'))).toHaveLength(1);
		expect(messages.find((m) => m.includes('queries per Worker invocation')))
			.toMatch(/51 statements, past the free plan's limit of 50/);
	});

	it('says nothing about the plan when none was given', async () => {
		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));

		try {
			const db = ormD1(DB);
			for (let i = 0; i < 6; i++) {
				await db.batch(Array.from({ length: 10 }, () => db.select({ id: users.id }).from(users)));
			}
		} finally {
			setDev(false);
		}

		// Guessing the plan would either cry wolf on paid or stay silent on free.
		expect(messages.filter((m) => m.includes('per Worker invocation'))).toEqual([]);
	});

	it('rejects a plan that is neither free nor paid', () => {
		expect(() => ormD1(DB, { plan: 'enterprise' as never })).toThrow(/plan must be 'free' or 'paid'/);
	});

	it('rejects inherited keys rather than silently disabling the guard', () => {
		// `'constructor' in PLAN_LIMITS` is true, so an `in` check accepted these
		// and handed InvocationBudget a *function* as its limits — every
		// comparison NaN and both warnings dead, while the caller believed the
		// guard was on. TypeScript stops typed callers; this check exists for the
		// untyped ones, which is where a value read from env or a config file
		// arrives.
		for (const key of ['constructor', 'toString', 'valueOf', '__proto__']) {
			expect(() => ormD1(DB, { plan: key as never })).toThrow(/plan must be 'free' or 'paid'/);
		}
	});

	it('names a missing binding instead of throwing on the probe', () => {
		// `drizzle(env.DB)` with no `DB` in wrangler.jsonc is the common way to
		// get here, and it used to be the one path with the unhelpful message:
		// the config-vs-binding probe reads `.prepare` before the check runs.
		expect(() => ormD1(undefined as never)).toThrow(/was given no binding/);
		expect(() => ormD1({ client: undefined as never })).toThrow(/needs a `client`/);
	});

	it('reports D1 billing units to onQuery', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(DB, { onQuery: (event) => events.push(event) });

		await db.select({ id: users.id }).from(users);
		await db.insert(posts).values({ id: 60, authorId: 1, title: 'x' }).run();

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ kind: 'select', tables: ['users'] });
		expect(events[0]!.rowsRead).toBeGreaterThan(0);
		expect(events[1]).toMatchObject({ kind: 'insert', tables: ['posts'] });
		expect(events[1]!.rowsWritten).toBeGreaterThan(0);
	});

	it('emits one event per statement in a batch', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(DB, { onQuery: (event) => events.push(event) });

		await db.batch([
			db.select({ id: users.id }).from(users),
			db.select({ id: posts.id }).from(posts),
		]);

		expect(events.map((e) => e.tables[0])).toEqual(['users', 'posts']);
	});

	it('never leaks parameters outside dev', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(DB, { onQuery: (event) => events.push(event) });
		await db.select({ id: users.id }).from(users).where(eq(users.email, 'secret@b.c'));
		expect(events[0]!.params).toBeUndefined();
	});

	it('attaches the failing SQL to the error', async () => {
		const db = ormD1(DB);
		await expect(db.insert(users).values({ id: 1, email: 'a@b.c' }).run())
			.rejects.toMatchObject({ name: 'OrmD1QueryError', sql: expect.stringContaining('insert into "users"') });
	});

	// [F-064]: error mapping used `parts[0].sql` unconditionally, so a chunked
	// write failing on a later chunk reported the *first* chunk's SQL and no
	// parameters — contradicting the documented "errors carry the SQL that
	// caused them". Fixed by reporting the first and last part (D1's `batch()`
	// gives no indication of which member actually failed) — bounded rather
	// than every part's SQL/params unbounded, which measured 62KB+ for a
	// 3000-row insert failing on its last chunk.
	it('attaches the first and last chunk\'s SQL and params, bounded, on a chunked write', async () => {
		setDev(true);
		try {
			const db = ormD1(DB, { maxParams: 8 });
			// Each row encodes to 6 params (id, email, name, active, score,
			// settings) at maxParams: 8, so one row per chunk — 3 chunks. The
			// third (last) row collides with the seeded user's email.
			const rows = [
				{ id: 100, email: 'x100@b.c', name: 'x', active: true },
				{ id: 101, email: 'x101@b.c', name: 'x', active: true },
				{ id: 102, email: 'a@b.c', name: 'x', active: true }, // duplicates seed's user 1
			];

			await expect(db.insert(users).values(rows).run()).rejects.toMatchObject({
				name: 'OrmD1QueryError',
				// The bug: `query.sql` is always the *first* chunk, which binds
				// none of these values, so the error's params never contained
				// the row that actually caused the failure. The fix always
				// includes the last chunk's params (plus the first's), so the
				// failing row here — the last one sent — is covered.
				params: expect.arrayContaining(['a@b.c', 102]) as unknown as unknown[],
				sql: expect.stringContaining('3 parts') as unknown as string,
			});
		} finally {
			setDev(false);
		}
	});

	it('refuses transaction() with a pointer to batch()', () => {
		expect(() => ormD1(DB).transaction()).toThrow(NoTransactionsError);
		expect(() => ormD1(DB).transaction()).toThrow(/batch/);
	});
});

describe('batch edge cases', () => {
	it('returns nothing for an empty batch instead of erroring', async () => {
		// D1 rejects an empty batch with "No SQL statements detected", which a
		// batch assembled from a filtered array reaches easily.
		await expect(ormD1(DB).batch([])).resolves.toEqual([]);
	});
});
