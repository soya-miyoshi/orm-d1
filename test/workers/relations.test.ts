import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { setDev } from '../../src/dev.js';
import { blob, CompileError, drizzle, eq, integer, primaryKey, ph, sql, sqliteTable, text } from '../../src/index.js';
import { defineRelations } from '../../src/relations/index.js';
import * as schema from '../schema.js';

const DB = (env as { DB: D1Database }).DB;
const db = drizzle({ client: DB, relations: schema.relations });

beforeEach(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(schema.allTables)) await DB.prepare(statement).run();

	await db.insert(schema.users).values([
		{ id: 1, email: 'a@b.c', name: 'Ada', createdAt: new Date(0) },
		{ id: 2, email: 'b@b.c', name: 'Bob', createdAt: new Date(0) },
	]);
	await db.insert(schema.posts).values([
		{ id: 10, authorId: 1, title: 'first', views: 5 },
		{ id: 11, authorId: 1, title: 'second', views: 50 },
		{ id: 12, authorId: 2, title: 'third', views: 1 },
	]);
	await db.insert(schema.postTags).values([
		{ postId: 10, tag: 'sql' },
		{ postId: 10, tag: 'd1' },
	]);
});

describe('db.query', () => {
	it('finds rows with no config at all', async () => {
		const rows = await db.query.users.findMany();
		expect(rows.map((r) => r.email)).toEqual(['a@b.c', 'b@b.c']);
	});

	it('loads a one relation', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true, title: true },
			with: { author: true },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({
			id: 10,
			title: 'first',
			author: {
				id: 1,
				email: 'a@b.c',
				name: 'Ada',
				role: 'member',
				active: true,
				settings: null,
				score: null,
				createdAt: new Date(0),
				// See F-005: `$onUpdate` with no `default` now populates on insert.
				updatedAt: new Date(0),
			},
		});
	});

	it('loads a many relation, including the empty case', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true, title: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, posts: [{ id: 10, title: 'first' }, { id: 11, title: 'second' }] },
			{ id: 2, posts: [{ id: 12, title: 'third' }] },
		]);
	});

	it('returns an empty array for a parent with no children', async () => {
		await db.delete(schema.posts).where(eq(schema.posts.authorId, 2)).run();
		const rows = await db.query.users.findMany({ columns: { id: true }, with: { posts: true } });
		expect(rows[1]).toEqual({ id: 2, posts: [] });
	});

	it('selects zero own columns for `columns: {}`, keeping only the `with` keys', async () => {
		// F-008: `columns: {}` used to fall through to "select every column";
		// it must select none, while join keys the relation needs to stitch
		// children back on are still fetched and dropped, same as any other
		// projection.
		const rows = await db.query.users.findMany({
			columns: {},
			with: { posts: { columns: { id: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ posts: [{ id: 10 }, { id: 11 }] },
			{ posts: [{ id: 12 }] },
		]);
		expect(Object.keys(rows[0]!)).toEqual(['posts']);
	});

	it('nests relations to arbitrary depth', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: {
				posts: {
					columns: { id: true },
					with: { tags: { columns: { tag: true }, orderBy: { tag: 'desc' } } },
				},
			},
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({
			id: 1,
			posts: [
				{ id: 10, tags: [{ tag: 'sql' }, { tag: 'd1' }] },
				{ id: 11, tags: [] },
			],
		});
	});

	it('does not leak the join keys it fetched for stitching', async () => {
		const rows = await db.query.users.findMany({
			columns: { name: true },
			with: { posts: { columns: { title: true } } },
		});

		expect(Object.keys(rows[0]!)).toEqual(['name', 'posts']);
		expect(Object.keys(rows[0]!.posts[0]!)).toEqual(['title']);
	});

	it('excludes columns marked false and keeps the rest', async () => {
		const [row] = await db.query.users.findMany({ columns: { settings: false, updatedAt: false } });
		expect(Object.keys(row!)).toEqual(['id', 'email', 'name', 'role', 'active', 'score', 'createdAt']);
	});

	it('filters, orders, limits and offsets', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			where: { views: { gt: 1 } },
			orderBy: { views: 'desc' },
			limit: 1,
			offset: 1,
		});

		expect(rows).toEqual([{ id: 10 }]);
	});

	it('filters children independently of parents', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, where: { views: { gt: 10 } } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('pages a nested limit per parent, in one query rather than one per parent', async () => {
		const queries: string[] = [];
		const counted = drizzle({ client: DB, relations: schema.relations, onQuery: (e) => queries.push(e.sql) });

		const rows = await counted.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, orderBy: { id: 'desc' }, limit: 1 } },
			orderBy: { id: 'asc' },
		});

		// Each user keeps their own page — the whole point of the window.
		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [{ id: 12 }] }]);
		// Parents, then children. Fanning out per parent key would make this 3.
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain('row_number() over (partition by');
	});

	it('applies a nested offset per parent too', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, orderBy: { id: 'asc' }, offset: 1 } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('computes extras, as a fragment and as a callback', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			extras: {
				upper: sql<string>`upper(${schema.users.email})`,
				lower: (fields, { sql: tag }) => tag<string>`lower(${fields.email})`,
			},
			limit: 1,
		});
		expect(rows[0]).toEqual({ id: 1, upper: 'A@B.C', lower: 'a@b.c' });
	});

	it('decodes a nested extra the same way with and without a limit', async () => {
		// A nested limit routes the child through `row_number()`, so the extra
		// is read back out of a subquery alias. The alias has to carry the
		// expression's own decoder or the same query answers two ways.
		const config = {
			columns: { id: true },
			extras: { when: (fields: any, { max }: any) => max(fields.createdAt) },
		};
		const one = async (extra: object) =>
			(await db.query.posts.findFirst({
				columns: { id: true },
				with: { author: { ...config, ...extra } as never },
				orderBy: { id: 'asc' },
			})) as unknown as { author: { when: unknown } };

		expect((await one({})).author.when).toEqual(new Date(0));
		expect((await one({ limit: 1 })).author.when).toEqual(new Date(0));
	});

	it('does not leak the join key of a one relation past the projection', async () => {
		// `one` hands the parent a copy of the child row, and a copy taken
		// before the join columns are dropped keeps a column nobody asked for.
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			with: { author: { columns: { name: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({ id: 10, author: { name: 'Ada' } });
	});

	it('findFirst returns one row or undefined', async () => {
		expect(await db.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
		expect(await db.query.users.findFirst({ columns: { id: true }, where: { id: 99 } })).toBeUndefined();
	});

	it('is lazy and re-runnable', async () => {
		const q = db.query.users.findMany({ columns: { id: true } });
		expect(await q.execute()).toHaveLength(2);
		await db.delete(schema.users).where(eq(schema.users.id, 2)).run();
		expect(await q.execute()).toHaveLength(1);
	});

	it('names an unknown relation in its error', async () => {
		await expect(db.query.users.findMany({ with: { nope: true } as never }))
			.rejects.toThrow(/no relation named "nope"/);
	});

	it('accepts the binding-first form as well as the config object', async () => {
		const alt = drizzle(DB, { relations: schema.relations });
		expect(await alt.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
	});

	it('keeps db.query and db._ through withSession', async () => {
		// The two headline features have to compose: a relational query served
		// from a read replica is the whole point of sessions. `withSession`
		// builds a fresh database, and used to hand back one with no `query`.
		const session = db.withSession('first-unconstrained');

		expect('query' in session).toBe(true);
		expect(session._.tableNamesMap).toMatchObject({ users: 'users' });
		expect(await session.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
		expect(typeof session.bookmark).toBe('function');
	});

	it('gives each parent its own object for a shared one relation', async () => {
		// Posts 10 and 11 have the same author. Handing both the identical
		// object means mutating one result mutates the other, which Drizzle's
		// executor does not do.
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			with: { author: { columns: { id: true, name: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]!.author).toEqual(rows[1]!.author);
		expect(rows[0]!.author).not.toBe(rows[1]!.author);

		rows[0]!.author.name = 'changed';
		expect(rows[1]!.author.name).toBe('Ada');
	});

	it('exposes drizzle-shaped metadata on db._', () => {
		expect(Object.keys(db._.relations)).toEqual(['users', 'posts', 'postTags']);
		// `schema` is the same object under the name other adapters look for.
		expect(db._.schema).toBe(db._.relations);
		expect(db._.tableNamesMap).toMatchObject({ users: 'users', post_tags: 'postTags' });
		expect(db._.relations['posts']!.relations['author']!.relationType).toBe('one');
		expect(db._.relations['users']!.relations['posts']!.relationType).toBe('many');
		expect(db._.fullSchema['users']).toBe(schema.users);
	});
});

/**
 * The point of `count` is that a page and its total can share one filter value.
 * So every assertion here compares it against the `findMany` it is supposed to
 * total — an implementation that quietly ignored the filter would still return
 * a plausible number, and only the comparison catches that.
 */
describe('db.query.<table>.count', () => {
	it('counts every row when given no filter', async () => {
		expect(await db.query.posts.count()).toBe(3);
		expect(await db.query.users.count()).toBe(2);
	});

	it('totals exactly what findMany returns, for the same filter object', async () => {
		const where = { views: { gte: 5 } } as const;
		const rows = await db.query.posts.findMany({ columns: { id: true }, where });
		expect(await db.query.posts.count({ where })).toBe(rows.length);
		expect(rows.length).toBe(2);
	});

	it('ignores limit and offset, which is the whole reason a page needs it', async () => {
		const where = { authorId: 1 } as const;
		const page = await db.query.posts.findMany({ columns: { id: true }, where, limit: 1 });
		expect(page).toHaveLength(1);
		expect(await db.query.posts.count({ where })).toBe(2);
	});

	it('takes a relation predicate, compiled the same way findMany compiles it', async () => {
		const where = { posts: { title: 'third' } } as const;
		const rows = await db.query.users.findMany({ columns: { id: true }, where });
		expect(rows).toEqual([{ id: 2 }]);
		expect(await db.query.users.count({ where })).toBe(1);
	});

	it('returns 0 rather than undefined when nothing matches', async () => {
		expect(await db.query.posts.count({ where: { id: { in: [] } } })).toBe(0);
	});

	it('binds placeholders through execute(), like the find methods do', async () => {
		const query = db.query.posts.count({ where: { authorId: ph('author') } as never });
		expect(await query.execute({ author: 1 })).toBe(2);
		expect(await query.execute({ author: 2 })).toBe(1);
	});
});

describe('the filter DSL', () => {
	it('reads a bare scalar as eq', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { views: 50 } }))
			.toEqual([{ id: 11 }]);
	});

	it('applies every operator on a column as a conjunction', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			where: { views: { gte: 5, lt: 50 }, title: { like: 'fir%' } },
		});
		expect(rows).toEqual([{ id: 10 }]);
	});

	it('handles in / notIn', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { id: { in: [10, 12] } } }))
			.toEqual([{ id: 10 }, { id: 12 }]);
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { id: { notIn: [10, 12] } } }))
			.toEqual([{ id: 11 }]);
	});

	it('refuses a placeholder to in / notIn rather than binding the array to one slot', async () => {
		// `in (…)` renders one `?` per value, so its arity is part of the SQL
		// text and cannot be filled afterwards. The placeholder used to reach
		// `inArray`, which sees a SQLChunk and renders it as a *subquery* — a
		// single `?` bound to the whole array, which D1 rejects at run time with
		// `Type 'object' not supported`. Nothing about that says which filter
		// produced it, and the type declared it legal.
		const run = (operator: 'in' | 'notIn') =>
			db.query.posts.findMany({ where: { id: { [operator]: ph('ids') } } as never })
				.execute({ ids: [10, 12] });

		await expect(run('in')).rejects.toThrow(CompileError);
		await expect(run('in')).rejects.toThrow(/"in" on column "id" was given a placeholder/);
		await expect(run('notIn')).rejects.toThrow(/"notIn" on column "id" was given a placeholder/);
	});

	it('still takes a subquery on the same operators', async () => {
		// The alternative the message points at has to actually work, or the
		// guard above is just a wall.
		const authors = db.select({ id: schema.posts.authorId }).from(schema.posts)
			.where(eq(schema.posts.views, 50));

		// No cast: the type admits the subquery the thrown message recommends.
		expect(await db.query.users.findMany({ columns: { id: true }, where: { id: { in: authors } } }))
			.toEqual([{ id: 1 }]);
	});

	it('handles isNull, and reads isNull: false as no constraint', async () => {
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNull: true } } }))
			.toHaveLength(2);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNotNull: true } } }))
			.toEqual([]);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNull: false } } }))
			.toHaveLength(2);
	});

	it('combines with AND, OR and NOT at the table level', async () => {
		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { OR: [{ views: 50 }, { title: 'third' }] },
				orderBy: { id: 'asc' },
			}),
		).toEqual([{ id: 11 }, { id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { NOT: { views: { gt: 1 } } },
			}),
		).toEqual([{ id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { AND: [{ views: { gt: 1 } }, { title: { like: 'sec%' } }] },
			}),
		).toEqual([{ id: 11 }]);
	});

	it('contributes nothing for an empty AND/OR, as Drizzle reads them', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { AND: [], OR: [] } }))
			.toHaveLength(3);
	});

	it('combines operators on a single column with NOT and OR', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { views: { NOT: { gt: 1 } } } }))
			.toEqual([{ id: 12 }]);
		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { views: { OR: [{ lt: 2 }, { gt: 40 }] } },
				orderBy: { id: 'asc' },
			}),
		).toEqual([{ id: 11 }, { id: 12 }]);
	});

	it('filters a parent by a relation, as a correlated exists', async () => {
		const queries: string[] = [];
		const counted = drizzle({ client: DB, relations: schema.relations, onQuery: (e) => queries.push(e.sql) });

		const rows = await counted.query.users.findMany({
			columns: { id: true },
			where: { posts: { views: { gt: 40 } } },
		});

		expect(rows).toEqual([{ id: 1 }]);
		// One query, not a pre-fetch of the children.
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain('exists (select 1 from');
	});

	it('reads true on a relation as "has any" and false as "has none"', async () => {
		await db.delete(schema.posts).where(eq(schema.posts.authorId, 2)).run();
		expect(await db.query.users.findMany({ columns: { id: true }, where: { posts: true } }))
			.toEqual([{ id: 1 }]);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { posts: false } }))
			.toEqual([{ id: 2 }]);
	});

	it('nests a relation filter through two levels', async () => {
		expect(
			await db.query.users.findMany({ columns: { id: true }, where: { posts: { tags: { tag: 'sql' } } } }),
		).toEqual([{ id: 1 }]);
	});

	it('accepts a RAW fragment and a RAW callback', async () => {
		expect(
			await db.query.posts.findMany({ columns: { id: true }, where: { RAW: sql`${schema.posts.id} = 12` } }),
		).toEqual([{ id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { RAW: (table, { eq: equals }) => equals((table as typeof schema.posts).id, 11) },
			}),
		).toEqual([{ id: 11 }]);
	});

	it('parenthesises a RAW OR fragment against the column filter it is AND-ed with', async () => {
		// Before the fix: `author_id = 2 and title like 'f%' or title like 'z%'`
		// parses, by SQL's normal AND-over-OR precedence, as
		// `(author_id = 2 and title like 'f%') or title like 'z%'` — so post 10
		// ("first", authorId 1) would wrongly match through the trailing `or`
		// even though `authorId: 2` should have excluded it. Correctly
		// parenthesised, it is `author_id = 2 and (title like 'f%' or title like
		// 'z%')`, and no post matches.
		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: {
					authorId: 2,
					RAW: (table, { sql: rawSql }) => {
						const t = table as typeof schema.posts;
						return rawSql`${t.title} like 'f%' or ${t.title} like 'z%'`;
					},
				},
			}),
		).toEqual([]);
	});

	it('parenthesises a nested RAW OR fragment the same way under both relational strategies', async () => {
		// Same defect as the top-level case above, but in `joined.ts`'s
		// `renderInner`: the correlation predicate, the caller's filter and the
		// relation's declared `where` used to be joined with a bare `' and '`.
		// `compileFilter` returns an unwrapped fragment for a lone predicate, so
		// an unparenthesised `or` inside a nested RAW filter bound looser than
		// intended once joined that way.
		const joinedDb = drizzle({ client: DB, relations: schema.relations, relationalStrategy: 'joined' });

		const query = {
			columns: { id: true },
			with: {
				posts: {
					columns: { id: true },
					where: {
						RAW: (table: unknown, { sql: rawSql }: { sql: typeof sql }) => {
							const t = table as typeof schema.posts;
							return rawSql`${t.title} like 'f%' or ${t.views} = 1`;
						},
					},
				},
			},
			orderBy: { id: 'asc' },
		} as const;

		const splitRows = await db.query.users.findMany(query);
		const joinedRows = await joinedDb.query.users.findMany(query);

		expect(joinedRows).toEqual(splitRows);
	});

	it('threads a placeholder through to execution rather than binding it early', async () => {
		// One query, re-executed with different values: the filter compiler has
		// to leave the slot unencoded rather than baking a value into the SQL.
		const query = db.query.posts.findMany({
			columns: { id: true },
			where: { id: { eq: ph<number>('wanted') } },
		});

		expect(await query.execute({ wanted: 12 })).toEqual([{ id: 12 }]);
		expect(await query.execute({ wanted: 11 })).toEqual([{ id: 11 }]);
	});

	it('supplies a placeholder to a child level as well as the parent', async () => {
		const rows = await db.query.users
			.findMany({
				columns: { id: true },
				with: { posts: { columns: { id: true }, where: { views: { gt: ph<number>('floor') } } } },
				orderBy: { id: 'asc' },
			})
			.execute({ floor: 10 });

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('accepts a placeholder for a top-level limit and offset', async () => {
		const query = db.query.posts.findMany({
			columns: { id: true },
			orderBy: { id: 'asc' },
			limit: ph<number>('n'),
			offset: ph<number>('o'),
		});
		expect(await query.execute({ n: 2, o: 1 })).toEqual([{ id: 11 }, { id: 12 }]);
	});

	it('refuses a placeholder for a nested limit, naming why', async () => {
		// The per-parent page is a row_number() window whose bounds are part of
		// the SQL text, so a deferred value has nowhere to go.
		await expect(
			db.query.users.findMany({ with: { posts: { limit: ph<number>('n') } } }).execute({ n: 1 }),
		).rejects.toThrow(/cannot be a placeholder/);
	});

	it('says which placeholder was left unsupplied', async () => {
		await expect(
			db.query.posts.findMany({ where: { id: { eq: ph<number>('wanted') } } }).execute(),
		).rejects.toThrow(/No value supplied for placeholder "wanted"/);
	});

	it('refuses a Postgres array operator instead of mis-compiling it', async () => {
		await expect(
			db.query.posts.findMany({ where: { title: { arrayContains: ['x'] } } as never }),
		).rejects.toThrow(/Postgres array operator/);
	});

	it('names an unknown filter field', async () => {
		await expect(db.query.posts.findMany({ where: { nope: 1 } as never }))
			.rejects.toThrow(/Unknown filter field "nope"/);
	});
});

/**
 * A composite-key relation, which the main fixture does not have.
 *
 * A single-column key collapses to `inArray` and binds one parameter however
 * many parents there are. A composite one expands to `or(and(eq, eq), …)` —
 * one parameter per key column per parent — so it is the only shape that can
 * overrun D1's bound-parameter cap, and the only one that has to be chunked.
 */
describe('composite-key relations', () => {
	const regions = sqliteTable('regions', {
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
		label: text('label'),
	}, (t) => [primaryKey({ columns: [t.country, t.zone] })]);

	const sites = sqliteTable('sites', {
		id: integer('id').primaryKey(),
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
	});

	const compositeRelations = defineRelations({ regions, sites }, (r) => ({
		regions: { sites: r.many.sites() },
		sites: {
			region: r.one.regions({
				from: [r.sites.country, r.sites.zone],
				to: [r.regions.country, r.regions.zone],
			}),
		},
	}));

	const PARENTS = 24;

	beforeEach(async () => {
		for (const name of ['sites', 'regions']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([regions, sites])) await DB.prepare(statement).run();

		const seed = drizzle({ client: DB, relations: compositeRelations });
		await seed.insert(regions).values(
			Array.from({ length: PARENTS }, (_, i) => ({ country: `c${i}`, zone: i, label: `l${i}` })),
		);
		await seed.insert(sites).values(
			Array.from({ length: PARENTS }, (_, i) => ({ id: i + 1, country: `c${i}`, zone: i })),
		);
	});

	it('chunks the child query instead of overrunning the parameter cap', async () => {
		// 24 parents × 2 key columns = 48 parameters; a cap of 10 stands in for
		// the real ~100 against the 60-parent case that reaches it.
		const queries: string[] = [];
		const counted = drizzle({
			client: DB,
			relations: compositeRelations,
			maxParams: 10,
			onQuery: (event) => queries.push(event.sql),
		});

		const rows = await counted.query.regions.findMany({
			columns: { country: true, zone: true },
			with: { sites: { columns: { id: true } } },
			orderBy: { zone: 'asc' },
		});

		// Every parent still gets its own child, across the chunk boundaries.
		expect(rows).toHaveLength(PARENTS);
		expect(rows.every((r) => r.sites.length === 1)).toBe(true);
		expect(rows[0]).toEqual({ country: 'c0', zone: 0, sites: [{ id: 1 }] });

		// One parent query, then several bounded child queries.
		expect(queries.length).toBeGreaterThan(2);
		expect(queries.slice(1).every((q) => q.includes('"country" = ?'))).toBe(true);
	});

	it('does not overrun $maxParams when a nested orderBy also binds a parameter', async () => {
		// `reserved` used to count only `childFilter`, `declared` and the window
		// bounds, not a nested `orderBy`'s own bound params, so a chunk sized
		// against the rest of the default 100-param budget could still overflow
		// it by however many the `orderBy` bound.
		for (const name of ['sites', 'regions']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([regions, sites])) await DB.prepare(statement).run();

		const PARENTS_50 = 50;
		const seed = drizzle({ client: DB, relations: compositeRelations });
		await seed.insert(regions).values(
			Array.from({ length: PARENTS_50 }, (_, i) => ({ country: `c${i}`, zone: i, label: `l${i}` })),
		);
		await seed.insert(sites).values(
			Array.from({ length: PARENTS_50 }, (_, i) => ({ id: i + 1, country: `c${i}`, zone: i })),
		);

		const paramCounts: number[] = [];
		const withCounter = drizzle({
			client: DB,
			relations: compositeRelations,
			onQuery: (event) => paramCounts.push(event.params?.length ?? 0),
		});

		// `QueryEvent.params` is only populated in dev mode (`src/runtime/result.ts`);
		// without this, every recorded count is 0 and the assertions below measure
		// nothing. The workers project runs with dev off by default.
		setDev(true);
		let rows;
		try {
			rows = await withCounter.query.regions.findMany({
				columns: { country: true, zone: true },
				with: {
					sites: {
						columns: { id: true },
						// A bound value inside the callback form: one extra param per child
						// statement that `reserved` must account for.
						orderBy: (t, { sql }) => sql`${t.id} + ${0}`,
					},
				},
				orderBy: { zone: 'asc' },
			});
		} finally {
			setDev(false);
		}

		expect(rows).toHaveLength(PARENTS_50);
		expect(rows.every((r) => r.sites.length === 1)).toBe(true);
		expect(paramCounts.every((n) => n <= 100)).toBe(true);
		// Confirms this exercise actually needed to chunk (50 parents times 2 key
		// columns is 100, right at the boundary once the orderBy's own param is
		// counted), not that the budget was simply never tight.
		expect(paramCounts.length).toBeGreaterThan(2);
	});

	it('stays a single child query when the budget allows it', async () => {
		const queries: string[] = [];
		const counted = drizzle({
			client: DB,
			relations: compositeRelations,
			onQuery: (event) => queries.push(event.sql),
		});

		await counted.query.regions.findMany({ columns: { zone: true }, with: { sites: true } });
		expect(queries).toHaveLength(2);
	});
});

/**
 * Many-to-many, through a junction table.
 *
 * The target row carries nothing saying which parent it arrived by — the same
 * tag belongs to several articles — so the junction's own key is projected
 * alongside it and dropped once the buckets are built.
 */
describe('a many keyed on a non-unique column', () => {
	// The join key is `customerId`, not a primary key, so two orders by the same
	// customer resolve to the *same* bucket. That is legal and not rare, and it
	// is the only way the sharing shows up.
	const orders = sqliteTable('orders', {
		id: integer('id').primaryKey(),
		customerId: integer('customer_id').notNull(),
	});
	const shipments = sqliteTable('shipments', {
		id: integer('id').primaryKey(),
		customerId: integer('customer_id').notNull(),
	});

	const shipRelations = defineRelations({ orders, shipments }, (r) => ({
		orders: { shipments: r.many.shipments({ from: r.orders.customerId, to: r.shipments.customerId }) },
	}));

	const shipDb = drizzle({ client: DB, relations: shipRelations });

	beforeEach(async () => {
		for (const name of ['shipments', 'orders']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([orders, shipments])) await DB.prepare(statement).run();

		await shipDb.insert(orders).values([{ id: 1, customerId: 7 }, { id: 2, customerId: 7 }]);
		await shipDb.insert(shipments).values([{ id: 10, customerId: 7 }, { id: 11, customerId: 7 }]);
	});

	it('gives each parent its own array rather than sharing one', async () => {
		const rows = await shipDb.query.orders.findMany({ with: { shipments: true }, orderBy: { id: 'asc' } });

		expect(rows[0]!.shipments.map((s) => s.id)).toEqual([10, 11]);
		expect(rows[1]!.shipments.map((s) => s.id)).toEqual([10, 11]);

		// Both parents matched the same key. Sharing the array means appending to
		// one result silently appends to the other.
		expect(rows[0]!.shipments).not.toBe(rows[1]!.shipments);
		rows[0]!.shipments.push({ id: 99, customerId: 7 });
		expect(rows[1]!.shipments).toHaveLength(2);
	});

	it('gives each parent its own child objects too', async () => {
		const rows = await shipDb.query.orders.findMany({ with: { shipments: true }, orderBy: { id: 'asc' } });

		// Same rule one level down, and the same rule `one` already follows:
		// mutating a child of one parent must not mutate it for the other.
		expect(rows[0]!.shipments[0]).not.toBe(rows[1]!.shipments[0]);
		rows[0]!.shipments[0]!.customerId = 0;
		expect(rows[1]!.shipments[0]!.customerId).toBe(7);
	});
});

describe('many-to-many through a junction table', () => {
	const articles = sqliteTable('articles', {
		id: integer('id').primaryKey(),
		title: text('title').notNull(),
	});
	const tags = sqliteTable('tags', {
		id: integer('id').primaryKey(),
		label: text('label').notNull(),
	});
	const articleTags = sqliteTable('article_tags', {
		articleId: integer('article_id').notNull(),
		tagId: integer('tag_id').notNull(),
	}, (t) => [primaryKey({ columns: [t.articleId, t.tagId] })]);

	const m2m = defineRelations({ articles, tags, articleTags }, (r) => ({
		articles: {
			tags: r.many.tags({
				from: r.articles.id.through(r.articleTags.articleId),
				to: r.tags.id.through(r.articleTags.tagId),
			}),
		},
		tags: { articles: r.many.articles() },
	}));

	const m2mDb = drizzle({ client: DB, relations: m2m });
	const m2mJoined = drizzle({ client: DB, relations: m2m, relationalStrategy: 'joined' });

	beforeEach(async () => {
		for (const name of ['article_tags', 'tags', 'articles']) {
			await DB.prepare(`drop table if exists "${name}"`).run();
		}
		for (const statement of createSchema([articles, tags, articleTags])) await DB.prepare(statement).run();

		await m2mDb.insert(articles).values([{ id: 1, title: 'one' }, { id: 2, title: 'two' }]);
		await m2mDb.insert(tags).values([{ id: 100, label: 'sql' }, { id: 200, label: 'd1' }]);
		await m2mDb.insert(articleTags).values([
			{ articleId: 1, tagId: 100 },
			{ articleId: 1, tagId: 200 },
			{ articleId: 2, tagId: 100 },
		]);
	});

	it('loads each parent’s targets, sharing a target across parents', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			with: { tags: { columns: { label: true }, orderBy: { label: 'asc' } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, tags: [{ label: 'd1' }, { label: 'sql' }] },
			{ id: 2, tags: [{ label: 'sql' }] },
		]);
	});

	it('falls back to the split plan for a junction, rather than emitting wrong SQL', async () => {
		// The joined builder does not emit the join a `through` relation needs,
		// so it must degrade to the split plan silently — same rows, more
		// statements. Emitting a correlated subquery without the junction would
		// return plausible-looking but wrong tags, which is the failure this
		// pins.
		const config = {
			columns: { id: true },
			with: { tags: { columns: { label: true }, orderBy: { label: 'asc' } } },
			orderBy: { id: 'asc' },
		} as const;

		const [split, one] = await Promise.all([
			m2mDb.query.articles.findMany(config),
			m2mJoined.query.articles.findMany(config),
		]);

		expect(one).toEqual(split);
		expect(one).toEqual([
			{ id: 1, tags: [{ label: 'd1' }, { label: 'sql' }] },
			{ id: 2, tags: [{ label: 'sql' }] },
		]);
	});

	it('applies a where declared on the junction relation to the target rows', async () => {
		// The `through` path builds its predicate from the *junction's* columns
		// and joins the target in, so a declared `where` has to survive being
		// compiled against the target while the matcher speaks about the
		// junction. Worth its own case: this is the one traversal where the two
		// are different tables.
		const narrowed = defineRelations({ articles, tags, articleTags }, (r) => ({
			articles: {
				sqlTags: r.many.tags({
					from: r.articles.id.through(r.articleTags.articleId),
					to: r.tags.id.through(r.articleTags.tagId),
					where: { label: 'sql' },
				}),
			},
		}));
		const d = drizzle({ client: DB, relations: narrowed });

		const rows = await d.query.articles.findMany({
			columns: { id: true },
			with: { sqlTags: { columns: { label: true } } },
			orderBy: { id: 'asc' },
		});

		// Article 1 has both tags; only `sql` may come back.
		expect(rows).toEqual([
			{ id: 1, sqlTags: [{ label: 'sql' }] },
			{ id: 2, sqlTags: [{ label: 'sql' }] },
		]);
	});

	it('does not leak the junction key it projected for stitching', async () => {
		const rows = await m2mDb.query.articles.findMany({ columns: { id: true }, with: { tags: true } });
		expect(Object.keys(rows[0]!.tags[0]!)).toEqual(['id', 'label']);
	});

	it('traverses in the other direction too', async () => {
		const rows = await m2mDb.query.tags.findMany({
			columns: { label: true },
			with: { articles: { columns: { title: true }, orderBy: { title: 'asc' } } },
			orderBy: { label: 'asc' },
		});

		expect(rows).toEqual([
			{ label: 'd1', articles: [{ title: 'one' }] },
			{ label: 'sql', articles: [{ title: 'one' }, { title: 'two' }] },
		]);
	});

	it('pages a many-to-many per parent', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			with: { tags: { columns: { label: true }, orderBy: { label: 'asc' }, limit: 1 } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, tags: [{ label: 'd1' }] },
			{ id: 2, tags: [{ label: 'sql' }] },
		]);
	});

	it('filters a parent by a many-to-many relation', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			where: { tags: { label: 'd1' } },
		});
		expect(rows).toEqual([{ id: 1 }]);
	});
});

/**
 * The two relational plans must be indistinguishable from the outside.
 *
 * `relationalStrategy: 'joined'` answers a `with` in one statement — correlated
 * subqueries wrapped in `json_group_array` / `json_object` — instead of one
 * query per level stitched in JS. That is a performance choice, so the results
 * have to be *equal*, not merely similar: same keys, same order, and the same
 * decoded values, since a relation's payload arrives as JSON text and never
 * passes through a column's decoder on its own.
 */
/**
 * The two relational plans must be indistinguishable from the outside.
 *
 * `relationalStrategy: 'joined'` answers a `with` in one statement — correlated
 * subqueries wrapped in `json_group_array` / `json_object` — instead of one
 * query per level stitched in JS. That is a performance choice, so the results
 * have to be *equal*, not merely similar.
 *
 * The cases are a table rather than a hand-picked list on purpose: the premise
 * is that the two plans are interchangeable, so any config worth supporting is
 * one row here. Every bug found in review — dropped `extras`, `undefined` where
 * split returns `null`, `offset` without `limit`, blobs, over-wide payloads —
 * is one row too.
 */
describe('joined strategy', () => {
	const joined = drizzle({ client: DB, relations: schema.relations, relationalStrategy: 'joined' });

	const bothAgree = async (run: (d: typeof db) => Promise<unknown>) => {
		const [split, one] = await Promise.all([run(db), run(joined)]);
		expect(one).toEqual(split);
		return one;
	};

	const CASES: { name: string; run: (d: typeof db) => Promise<unknown> }[] = [
		{
			name: 'a many relation',
			run: (d) => d.query.users.findMany({ with: { posts: true }, orderBy: { id: 'asc' } }),
		},
		{
			name: 'a one relation',
			run: (d) => d.query.posts.findMany({ with: { author: true }, orderBy: { id: 'asc' } }),
		},
		{
			name: 'two levels of nesting',
			run: (d) =>
				d.query.users.findMany({
					with: { posts: { with: { author: true }, orderBy: { id: 'asc' } } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'a column selection and a nested where',
			run: (d) =>
				d.query.users.findMany({
					columns: { id: true, name: true },
					with: { posts: { columns: { id: true, views: true }, where: { views: { gt: 4 } } } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'a nested order and limit',
			run: (d) =>
				d.query.users.findMany({
					with: { posts: { orderBy: { views: 'desc' }, limit: 1 } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'a nested offset with a limit',
			run: (d) =>
				d.query.users.findMany({
					with: { posts: { orderBy: { id: 'asc' }, limit: 1, offset: 1 } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			// SQLite parses OFFSET only as a suffix of LIMIT, so this used to be
			// a syntax error under joined while split handled it.
			name: 'a nested offset with no limit',
			run: (d) =>
				d.query.users.findMany({
					with: { posts: { orderBy: { id: 'asc' }, offset: 1 } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			// Dropped silently before: the key simply vanished from the row.
			name: 'extras at the top level',
			run: (d) =>
				d.query.users.findMany({
					columns: { id: true },
					extras: { shout: (t, { sql }) => sql`upper(${t.name})` },
					with: { posts: { columns: { id: true } } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'extras inside a relation',
			run: (d) =>
				d.query.users.findMany({
					columns: { id: true },
					with: {
						posts: {
							columns: { id: true },
							extras: { double: (t, { sql }) => sql`${t.views} * 2` },
							orderBy: { id: 'asc' },
						},
					},
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'a plain one-to-many child table',
			run: (d) => d.query.posts.findMany({ with: { tags: true }, orderBy: { id: 'asc' } }),
		},
		{
			// `columns: {}` on a nested relation with no `with`/`extras` projects
			// zero columns. Under `joined`, `pickColumns` returning `[]` used to
			// reach `renderInner`'s `sql.join([], ', ')`, rendering the invalid
			// `select  from …` — this must fall back to the split plan instead.
			name: 'an empty column selection on a nested relation',
			run: (d) =>
				d.query.users.findMany({
					columns: { id: true },
					with: { posts: { columns: {} } },
					orderBy: { id: 'asc' },
				}),
		},
		{
			name: 'findFirst',
			run: (d) => d.query.users.findFirst({ with: { posts: true }, orderBy: { id: 'asc' } }),
		},
	];

	for (const { name, run } of CASES) {
		it(`agrees with the split plan on ${name}`, async () => {
			await bothAgree(run);
		});
	}

	it('returns [] rather than null for a parent with no children', async () => {
		await db.delete(schema.posts).where(eq(schema.posts.authorId, 2));
		const rows = await bothAgree((d) =>
			d.query.users.findMany({ with: { posts: true }, orderBy: { id: 'asc' } })
		) as { posts: unknown[] }[];

		expect(rows[1]!.posts).toEqual([]);
	});

	it('returns null, not undefined, for an absent one relation', async () => {
		// `undefined` is not merely a different spelling: the declared type is
		// `T | null`, `row.x === null` stops working, and `JSON.stringify` drops
		// the key entirely, so an API response loses the field rather than
		// reporting it empty.
		//
		// This needs a relation that can actually resolve to nothing, and none
		// in the shared fixture can — `posts.author` crosses a non-null foreign
		// key, and everything else is a `many`, whose empty case is `[]` and is
		// asserted above. `postTags.addedBy` is the one column that can point at
		// nothing: nullable, and carrying no foreign key, so it can also name a
		// user that was never there.
		const optional = defineRelations({ users: schema.users, postTags: schema.postTags }, (r) => ({
			postTags: { adder: r.one.users({ from: r.postTags.addedBy, to: r.users.id }) },
		}));
		const optionalSplit = drizzle({ client: DB, relations: optional });
		const optionalJoined = drizzle({ client: DB, relations: optional, relationalStrategy: 'joined' });

		await db.update(schema.postTags).set({ addedBy: 999 }).where(eq(schema.postTags.tag, 'sql'));

		const config = { columns: { tag: true }, with: { adder: true }, orderBy: { tag: 'asc' } } as const;
		const [split, one] = await Promise.all([
			optionalSplit.query.postTags.findMany(config),
			optionalJoined.query.postTags.findMany(config),
		]);

		// Both ways of being absent, since the plans reach them differently: the
		// split plan never binds a null key, and drops a key that matched
		// nothing at stitching time. `d1` is the first, `sql` the second.
		expect(one).toEqual(split);
		expect(one).toEqual([{ tag: 'd1', adder: null }, { tag: 'sql', adder: null }]);
	});

	it('decodes nested values, not just their shape', async () => {
		// `createdAt` is a timestamp column: through JSON it arrives as a number,
		// and only the decoder turns it back into a Date. This is the assertion
		// that catches a plan returning the right keys with the wrong types.
		const rows = await bothAgree((d) =>
			d.query.posts.findMany({ with: { author: true }, orderBy: { id: 'asc' } })
		) as { author: { createdAt: unknown; active: unknown } }[];

		expect(rows[0]!.author.createdAt).toBeInstanceOf(Date);
		expect(typeof rows[0]!.author.active).toBe('boolean');
	});

	it('refuses a placeholder in a nested page under both plans', async () => {
		// The joined plan *could* serve this: a correlated subquery pages per
		// parent naturally. It deliberately does not, because the strategy is a
		// performance switch and must not decide which queries are legal —
		// flipping it for latency must never make working code throw, or
		// broken code start working.
		const run = (d: typeof db) =>
			d.query.users.findMany({
				with: { posts: { orderBy: { id: 'asc' }, limit: ph('n') } },
				orderBy: { id: 'asc' },
			}).execute({ n: 1 });

		await expect(run(db)).rejects.toThrow(/cannot be a placeholder/);
		await expect(run(joined)).rejects.toThrow(/cannot be a placeholder/);
	});
});

describe('joined strategy actually runs one statement', () => {
	/** Count statements by strategy — the check that the tests above are not vacuous. */
	const countStatements = async (
		strategy: 'split' | 'joined',
		run: (d: typeof db) => unknown,
	) => {
		const sqls: string[] = [];
		const d = drizzle({
			client: DB,
			relations: schema.relations,
			relationalStrategy: strategy,
			onQuery: (e) => void sqls.push(e.sql),
		});
		await run(d);
		return sqls;
	};

	it('sends 1 statement where the split plan sends 2', async () => {
		const run = (d: typeof db) => d.query.users.findMany({ with: { posts: true } });

		const split = await countStatements('split', run);
		const one = await countStatements('joined', run);

		expect(split).toHaveLength(2);
		expect(one).toHaveLength(1);
		expect(one[0]).toMatch(/json_group_array/);
	});

	it('sends 1 statement for a two-level nesting, where the split plan sends 3', async () => {
		const run = (d: typeof db) => d.query.users.findMany({ with: { posts: { with: { author: true } } } });

		expect(await countStatements('split', run)).toHaveLength(3);
		expect(await countStatements('joined', run)).toHaveLength(1);
	});

	it('handles a plain one-to-many in one statement too', async () => {
		// `posts.tags` looks like a junction but is not one: `postTags` is a
		// child table, so this is an ordinary one-to-many and the joined plan
		// covers it. The real junction case is asserted in the m2m suite.
		const run = (d: typeof db) => d.query.posts.findMany({ with: { tags: true } });

		expect(await countStatements('joined', run)).toHaveLength(1);
	});
});

/**
 * The two guards that keep `json_object` from being handed something it
 * refuses: a binary value, and more arguments than SQLite will take. They live
 * here rather than with the matrix above because each needs a fixture the
 * shared schema does not have — a child with a blob, and a very wide one.
 *
 * Both fail *open* — the fallback produces no wrong answer, only more
 * statements — which is exactly why they need pinning. A guard that stops
 * firing is invisible in a diff and invisible in a passing suite; it shows up
 * as a query that used to work throwing a D1 error. The statement count is
 * therefore part of each assertion: "it returned the right rows" would stay
 * green if the plan quietly fell back for everything.
 */
describe('joined strategy falls back rather than failing', () => {
	const owners = sqliteTable('joined_owners', {
		id: integer('id').primaryKey(),
		name: text('name').notNull(),
	});
	const files = sqliteTable('joined_files', {
		id: integer('id').primaryKey(),
		ownerId: integer('owner_id').notNull(),
		bytes: blob('bytes', { mode: 'buffer' }),
	});

	/**
	 * Wide enough to overrun `json_object`, which costs two arguments per key
	 * against SQLite's 127 — so 63 keys is the ceiling and 64 is one too many.
	 */
	const wide = sqliteTable('joined_wide', {
		id: integer('id').primaryKey(),
		ownerId: integer('owner_id').notNull(),
		...Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`c${i}`, text(`c${i}`)])),
	});

	const rel = defineRelations({ owners, files, wide }, (r) => ({
		owners: {
			files: r.many.files({ from: r.owners.id, to: r.files.ownerId }),
			wide: r.many.wide({ from: r.owners.id, to: r.wide.ownerId }),
		},
		// Same owner, so a `wide` row can carry a nested relation without a
		// third table — this exists to be counted as a key, not to mean much.
		wide: { files: r.many.files({ from: r.wide.ownerId, to: r.files.ownerId }) },
	}));

	const splitDb = drizzle({ client: DB, relations: rel });
	const joinedDb = drizzle({ client: DB, relations: rel, relationalStrategy: 'joined' });

	/** The statements the joined plan sends: 1 means it did not fall back. */
	const joinedStatements = async (run: (d: typeof joinedDb) => unknown) => {
		const sqls: string[] = [];
		const d = drizzle({
			client: DB,
			relations: rel,
			relationalStrategy: 'joined',
			onQuery: (e) => void sqls.push(e.sql),
		});
		await run(d);
		return sqls;
	};

	/** A `columns` selection naming `count` of the wide table's columns. */
	const wideColumns = (count: number): Record<string, boolean> => {
		const columns: Record<string, boolean> = { id: true };
		for (let i = 0; i < count - 1; i++) columns[`c${i}`] = true;
		return columns;
	};

	const bytes = new Uint8Array([0x00, 0xAA, 0xBB]);

	beforeEach(async () => {
		for (const name of ['joined_files', 'joined_wide', 'joined_owners']) {
			await DB.prepare(`drop table if exists "${name}"`).run();
		}
		for (const statement of createSchema([owners, files, wide])) await DB.prepare(statement).run();

		await splitDb.insert(owners).values({ id: 1, name: 'Ada' });
		await splitDb.insert(files).values({ id: 1, ownerId: 1, bytes });
		// Only the two declared columns: the `c*` ones are built dynamically, so
		// they are wide at runtime but not statically known here. Nothing in
		// this suite needs their values, only their count.
		await splitDb.insert(wide).values({ id: 1, ownerId: 1 });
	});

	it('falls back when a blob column is in a relation payload', async () => {
		// `json_object('bytes', <blob>)` is not a bad value, it is a hard error:
		// `JSON cannot hold BLOB values`. Every `blob()` mode is affected, since
		// `json` and `bigint` are blob-backed too.
		const run = (d: typeof joinedDb) => d.query.owners.findMany({ with: { files: true } });

		expect(await joinedStatements(run)).toHaveLength(2);
		const [split, one] = await Promise.all([run(splitDb), run(joinedDb)]);
		expect(one).toEqual(split);
		expect((one as { files: { bytes: Uint8Array }[] }[])[0]!.files[0]!.bytes).toEqual(bytes);
	});

	it('stays on the joined plan when the blob column is not projected', async () => {
		// The guard reads the projection, not the table. Falling back for any
		// table that merely *has* a blob would cost a round trip on every query
		// against it — silently, and for nothing.
		expect(await joinedStatements((d) =>
			d.query.owners.findMany({ with: { files: { columns: { id: true } } } })
		)).toHaveLength(1);

		expect(await joinedStatements((d) =>
			d.query.owners.findMany({ with: { files: { columns: { bytes: false } } } })
		)).toHaveLength(1);
	});

	it('takes 63 keys in one statement, and falls back at 64', async () => {
		// Measured against D1 rather than reasoned about: 63 passes, 64 is
		// rejected with `too many arguments on function json_object`. This is
		// the limit docs/03 cites as a reason to prefer the split plan.
		expect(await joinedStatements((d) =>
			d.query.owners.findMany({ with: { wide: { columns: wideColumns(63) } } })
		)).toHaveLength(1);

		const run = (d: typeof joinedDb) => d.query.owners.findMany({ with: { wide: { columns: wideColumns(64) } } });
		expect(await joinedStatements(run)).toHaveLength(2);

		// And the fallback answers, rather than merely failing more quietly —
		// all 64 requested keys come back, which is the whole point of taking
		// the slower plan.
		const [split, one] = await Promise.all([run(splitDb), run(joinedDb)]);
		expect(one).toEqual(split);
		expect(Object.keys((one as { wide: Record<string, unknown>[] }[])[0]!.wide[0]!)).toHaveLength(64);
	});

	it('counts extras and nested relations toward the same ceiling', async () => {
		// The cap is on `json_object` arity, not on how many columns a table
		// has: an extra and a nested relation each take a key too. Counting only
		// columns would let a 63-column payload with one extra through, and D1
		// would reject the statement.
		const withExtra = (columns: number) => (d: typeof joinedDb) =>
			d.query.owners.findMany({
				with: { wide: { columns: wideColumns(columns), extras: { n: (t, { sql }) => sql`${t.id} + 1` } } },
			});

		expect(await joinedStatements(withExtra(62))).toHaveLength(1);
		expect(await joinedStatements(withExtra(63))).toHaveLength(2);

		const withRelation = (columns: number) => (d: typeof joinedDb) =>
			d.query.owners.findMany({
				with: { wide: { columns: wideColumns(columns), with: { files: { columns: { id: true } } } } },
			});

		// 3, not 2: falling back costs a statement per *level*, and this query
		// is two deep. That it is the whole query rather than the offending
		// level is deliberate — see `#useJoined`.
		expect(await joinedStatements(withRelation(62))).toHaveLength(1);
		expect(await joinedStatements(withRelation(63))).toHaveLength(3);
	});
});

/**
 * `where` declared on the relation itself, which `define.ts` documents as
 * "applied to the target rows whenever this is traversed".
 *
 * It was honoured in exactly one of the two places a relation is reachable
 * from. As a *filter* — `where: { publishedPosts: true }` — it landed in the
 * `exists (…)` and worked. As a *traversal* — `with: { publishedPosts: true }`
 * — neither plan ever read the field, so the predicate simply was not in the
 * statement and the rows came back unfiltered. No error, and the two spellings
 * of the same declaration disagreed with each other.
 *
 * So the assertions here are triangular rather than a single expected list:
 * split, joined, and the filter path all have to name the same rows. Any one
 * of them alone could be wrong in the same direction.
 */
describe('a relation with its own where', () => {
	/**
	 * Two declarations over the fixture, so the predicate has something to be
	 * dropped from at each end: a `many` narrowed by a column, and a `one` that
	 * can be filtered away entirely.
	 */
	const rel = defineRelations({ users: schema.users, posts: schema.posts }, (r) => ({
		users: {
			popularPosts: r.many.posts({
				from: r.users.id,
				to: r.posts.authorId,
				where: { views: { gte: 50 } },
			}),
			allPosts: r.many.posts({ from: r.users.id, to: r.posts.authorId }),
		},
		posts: {
			activeAuthor: r.one.users({
				from: r.posts.authorId,
				to: r.users.id,
				where: { name: 'Ada' },
			}),
		},
	}));

	const split = drizzle({ client: DB, relations: rel });
	const joined = drizzle({ client: DB, relations: rel, relationalStrategy: 'joined' });

	const bothAgree = async (run: (d: typeof split) => Promise<unknown>) => {
		const [a, b] = await Promise.all([run(split), run(joined)]);
		expect(b).toEqual(a);
		return a;
	};

	it('narrows a traversed many, in both plans', async () => {
		// Ada has posts 10 (5 views) and 11 (50); Bob has 12 (1). Only 11
		// qualifies, so an unfiltered traversal is loudly different rather than
		// coincidentally equal.
		const rows = await bothAgree((d) =>
			d.query.users.findMany({
				columns: { id: true },
				with: { popularPosts: { columns: { id: true } } },
				orderBy: { id: 'asc' },
			})
		);

		expect(rows).toEqual([
			{ id: 1, popularPosts: [{ id: 11 }] },
			{ id: 2, popularPosts: [] },
		]);
	});

	it('leaves an undeclared relation over the same columns alone', async () => {
		// The control. `allPosts` joins identically and has no `where`, so if
		// this narrowed too, the predicate would be coming from the join rather
		// than from the declaration.
		const rows = await bothAgree((d) =>
			d.query.users.findMany({
				columns: { id: true },
				with: { allPosts: { columns: { id: true } } },
				orderBy: { id: 'asc' },
			})
		);

		expect(rows).toEqual([
			{ id: 1, allPosts: [{ id: 10 }, { id: 11 }] },
			{ id: 2, allPosts: [{ id: 12 }] },
		]);
	});

	it('narrows a traversed one all the way to null', async () => {
		const rows = await bothAgree((d) =>
			d.query.posts.findMany({
				columns: { id: true },
				with: { activeAuthor: { columns: { name: true } } },
				orderBy: { id: 'asc' },
			})
		);

		// Post 12 is Bob's, and the declaration only admits Ada — so the `one`
		// resolves to nothing even though the foreign key is intact.
		expect(rows).toEqual([
			{ id: 10, activeAuthor: { name: 'Ada' } },
			{ id: 11, activeAuthor: { name: 'Ada' } },
			{ id: 12, activeAuthor: null },
		]);
	});

	it('conjoins with the caller\'s own where rather than replacing it', async () => {
		// Either predicate winning outright gives a different answer: the
		// declaration alone would keep 11, the caller's alone would keep 10.
		const rows = await bothAgree((d) =>
			d.query.users.findMany({
				columns: { id: true },
				with: { popularPosts: { columns: { id: true }, where: { title: 'first' } } },
				orderBy: { id: 'asc' },
			})
		);

		expect(rows).toEqual([
			{ id: 1, popularPosts: [] },
			{ id: 2, popularPosts: [] },
		]);
	});

	it('agrees with the same relation used as a filter', async () => {
		// The path that was already correct, as the third leg. `users` having a
		// *popular* post is only user 1; having any post is both.
		expect(await split.query.users.findMany({ columns: { id: true }, where: { popularPosts: true } }))
			.toEqual([{ id: 1 }]);
		expect(await split.query.users.findMany({ columns: { id: true }, where: { allPosts: true } }))
			.toEqual([{ id: 1 }, { id: 2 }]);
	});

	it('keeps the joined plan to one statement while doing it', async () => {
		// The predicate has to land *inside* the correlated subquery. Filtering
		// afterwards, or falling back to split, would both satisfy every
		// assertion above.
		const sqls: string[] = [];
		const d = drizzle({
			client: DB,
			relations: rel,
			relationalStrategy: 'joined',
			onQuery: (e) => void sqls.push(e.sql),
		});

		await d.query.users.findMany({ with: { popularPosts: true } });

		expect(sqls).toHaveLength(1);
		expect(sqls[0]).toMatch(/json_group_array/);
	});
});

describe('a reversed relation inherits the where onto the source, not the target', () => {
	/**
	 * `posts.author` states `where` explicitly, on the `one` side. `users.posts`
	 * states no `from`/`to` at all, so it adopts both from the reverse — and,
	 * per Drizzle (`drizzle-orm/relations.js` ~683/~690), the inherited `where`
	 * is compiled against `users`, the *source* of the now-reversed relation,
	 * not `posts`, its target. `posts` has no `active` column at all, so
	 * compiling the predicate against the wrong table wouldn't just disagree —
	 * it would throw "Unknown filter field".
	 */
	const rel = defineRelations({ users: schema.users, posts: schema.posts }, (r) => ({
		posts: {
			author: r.one.users({ from: r.posts.authorId, to: r.users.id, where: { active: true } }),
		},
		users: {
			posts: r.many.posts(), // adopts from/to *and* where from `posts.author`
		},
	}));

	const split = drizzle({ client: DB, relations: rel });
	const joined = drizzle({ client: DB, relations: rel, relationalStrategy: 'joined' });

	beforeEach(async () => {
		await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, 2)).run();
	});

	it('refuses to compute this in the split plan, rather than risk leaking status across a non-unique key', async () => {
		// The split plan has no correlated scope for a `where` compiled against
		// the parent (the source, here): the only query it can group by is
		// "does *any* row sharing this join key match", which would leak a
		// passing user's status onto every other user sharing the key whenever
		// the source column is not unique. Rather than silently compute that
		// wrong answer, it refuses — naming the relation and pointing at the
		// `joined` strategy, which evaluates this correctly per parent row (see
		// the next test).
		await expect(split.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true } } },
			orderBy: { id: 'asc' },
		})).rejects.toThrow(/"posts".*"users".*reversed.*where.*relationalStrategy.*'joined'/s);
	});

	it('narrows children by the source row, in the joined plan too', async () => {
		const rows = await joined.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, posts: [{ id: 10 }, { id: 11 }] },
			{ id: 2, posts: [] },
		]);
	});

	it('narrows the same way through the relational filter DSL', async () => {
		// `posts: true` embeds the relation's declared `where` inside the
		// correlated `exists`, unconditionally — so it excludes user 2 even
		// though the filter itself only asks "has any posts".
		const rows = await split.query.users.findMany({
			columns: { id: true },
			where: { posts: true },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([{ id: 1 }]);
	});

	it('still throws when a genuinely reversed where names a field absent from the correct table', async () => {
		// The correct table for this `where` is `users`, the source — not
		// `posts`. A field that exists on neither must still fail loudly.
		//
		// Run against `joined` — the strategy this shape actually works with.
		// The `split` plan refuses any reversed relation carrying its own
		// `where` outright (see the earlier test in this suite), regardless of
		// whether the `where` itself is valid, so it would not reach this
		// field-name check at all.
		const bogus = defineRelations({ users: schema.users, posts: schema.posts }, (r) => ({
			posts: {
				author: r.one.users({ from: r.posts.authorId, to: r.users.id, where: { nope: true } as never }),
			},
			users: {
				posts: r.many.posts(),
			},
		}));
		const d = drizzle({ client: DB, relations: bogus, relationalStrategy: 'joined' });

		await expect(d.query.users.findMany({ with: { posts: true } })).rejects.toThrow(
			/Unknown filter field "nope"/,
		);
	});
});

describe('a many() relation with its own where, reversed onto it from nothing, still applies own where', () => {
	/**
	 * `users.posts` states its own `where` here (unlike the suite above, where
	 * it inherited one from `posts.author`) — so per Gap 1, `isReversed` must
	 * come out `false`: the `where` names `posts`' own columns (`views`), the
	 * *target* of this relation, not `users`, the source it was reversed onto
	 * for its join columns alone. Compiling it as if reversed would try to
	 * find a `views` column on `users` and throw "Unknown filter field".
	 */
	const rel = defineRelations({ users: schema.users, posts: schema.posts }, (r) => ({
		posts: {
			author: r.one.users({ from: r.posts.authorId, to: r.users.id }),
		},
		users: {
			// No from/to: adopts the join from `posts.author`. Its own `where`
			// is declared here, though, so it must NOT come out isReversed.
			posts: r.many.posts({ where: { views: { gt: 10 } } }),
		},
	}));

	const split = drizzle({ client: DB, relations: rel });
	const joined = drizzle({ client: DB, relations: rel, relationalStrategy: 'joined' });

	const expected = [
		{ id: 1, posts: [{ id: 11 }] },
		{ id: 2, posts: [] },
	];

	it('applies it against posts, its own table, in the split plan', async () => {
		const rows = await split.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true } } },
			orderBy: { id: 'asc' },
		});
		expect(rows).toEqual(expected);
	});

	it('applies it against posts, its own table, in the joined plan', async () => {
		const rows = await joined.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true } } },
			orderBy: { id: 'asc' },
		});
		expect(rows).toEqual(expected);
	});

	it('applies it against posts, its own table, through the relational filter DSL', async () => {
		// `posts: true` embeds the declared `where` inside the correlated
		// `exists`; only user 1 has a post with more than 10 views.
		const rows = await split.query.users.findMany({
			columns: { id: true },
			where: { posts: true },
			orderBy: { id: 'asc' },
		});
		expect(rows).toEqual([{ id: 1 }]);
	});
});
