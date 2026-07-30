import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	alias,
	and,
	asc,
	count,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNull,
	like,
	not,
	notInArray,
	or,
	ph,
	query,
	sql,
} from '../../src/index.js';
import type { InferSelect } from '../../src/index.js';
import { posts, users } from '../schema.js';

describe('select compilation', () => {
	it('projects every column of the table by default', () => {
		const compiled = query.select().from(users).where(eq(users.id, 1)).compile();

		expect(compiled.sql).toBe(
			'select "users"."id", "users"."email", "users"."name", "users"."role", "users"."active", '
				+ '"users"."settings", "users"."score", "users"."created_at" as "createdAt", '
				+ '"users"."updated_at" as "updatedAt" from "users" where "users"."id" = ?',
		);
		expect(compiled.params).toEqual([{ k: 'const', v: 1 }]);
		expect(compiled.tables).toEqual(['users']);
	});

	it('projects an explicit selection', () => {
		const compiled = query.select({ id: users.id, email: users.email }).from(users).compile();
		expect(compiled.sql).toBe('select "users"."id", "users"."email" from "users"');
	});

	it('aliases a projected column whose key differs from its database name', () => {
		const compiled = query.select({ who: users.email }).from(users).compile();
		expect(compiled.sql).toBe('select "users"."email" as "who" from "users"');
	});

	it('encodes values with the column encoder', () => {
		const compiled = query.select().from(users).where(eq(users.active, true)).compile();
		expect(compiled.params).toEqual([{ k: 'const', v: 1 }]);

		const timestamped = query.select().from(users)
			.where(gt(users.createdAt, new Date(1000)))
			.compile();
		expect(timestamped.params).toEqual([{ k: 'const', v: 1 }]);
	});

	it('composes and/or/not, and drops undefined conditions', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(and(eq(users.id, 1), undefined, or(isNull(users.name), not(like(users.email, '%@b.c')))))
			.compile();

		expect(compiled.sql).toBe(
			'select "users"."id" from "users" where (("users"."id" = ?) and ((("users"."name" is null) '
				+ 'or (not ("users"."email" like ?)))))',
		);
		expect(compiled.params).toEqual([{ k: 'const', v: 1 }, { k: 'const', v: '%@b.c' }]);
	});

	it('parenthesises each operand of and()/or(), so a raw fragment with its own or/and cannot leak precedence', () => {
		const combined = and(sql`a = 1 or b = 2`, eq(posts.views, 0))!;
		expect(combined.toQuery().sql).toBe('((a = 1 or b = 2) and ("posts"."views" = ?))');
	});

	it('renders a short inArray as bound parameters', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(inArray(users.id, [1, 2, 3]))
			.compile();

		expect(compiled.sql).toBe('select "users"."id" from "users" where "users"."id" in (?, ?, ?)');
		expect(compiled.params).toHaveLength(3);
	});

	it('collapses a long inArray into one json_each parameter', () => {
		const ids = Array.from({ length: 200 }, (_, i) => i);
		const compiled = query.select({ id: users.id }).from(users)
			.where(inArray(users.id, ids))
			.compile();

		expect(compiled.sql).toBe(
			'select "users"."id" from "users" where "users"."id" in (select "value" from json_each(?))',
		);
		expect(compiled.params).toHaveLength(1);
		expect(JSON.parse(String((compiled.params[0] as { v: string }).v))).toHaveLength(200);
	});

	it('handles an empty inArray without emitting invalid SQL', () => {
		expect(query.select({ id: users.id }).from(users).where(inArray(users.id, [])).compile().sql)
			.toBe('select "users"."id" from "users" where 1 = 0');
		expect(query.select({ id: users.id }).from(users).where(notInArray(users.id, [])).compile().sql)
			.toBe('select "users"."id" from "users" where 1 = 1');
	});

	it('supports groupBy / having / orderBy / limit / offset / distinct', () => {
		const compiled = query.selectDistinct({ author: posts.authorId, n: count() })
			.from(posts)
			.groupBy(posts.authorId)
			.having(gt(count(), 1))
			.orderBy(desc(posts.authorId), asc(posts.title))
			.limit(10)
			.offset(20)
			.compile();

		expect(compiled.sql).toBe(
			'select distinct "posts"."author_id" as "author", count(*) as "n" from "posts" '
				+ 'group by "posts"."author_id" having count(*) > ? '
				+ 'order by "posts"."author_id" desc, "posts"."title" asc limit 10 offset 20',
		);
	});

	it('emits a limit before a bare offset, as SQLite requires', () => {
		const compiled = query.select({ id: users.id }).from(users).offset(5).compile();
		expect(compiled.sql).toBe('select "users"."id" from "users" limit -1 offset 5');
	});

	it('accepts placeholders, including for limit and offset', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(eq(users.email, ph('email')))
			.limit(ph('limit'))
			.compile();

		expect(compiled.sql).toBe(
			'select "users"."id" from "users" where "users"."email" = ? limit ?',
		);
		expect(compiled.params).toEqual([
			{ k: 'ph', name: 'email', encode: expect.any(Function) },
			{ k: 'ph', name: 'limit' },
		]);
	});

	it('nests one group per table when a join has no explicit selection', () => {
		const compiled = query.select().from(users)
			.leftJoin(posts, eq(posts.authorId, users.id))
			.compile();

		expect(compiled.sql).toContain('from "users" left join "posts" on "posts"."author_id" = "users"."id"');
		// "id" appears on both tables, so the whole projection is aliased.
		expect(compiled.columnNames.slice(0, 3)).toEqual(['c0', 'c1', 'c2']);
	});

	it('types the base row as nullable for a right or full join', () => {
		// Checked by `tsgo`, not at runtime. The runtime already returns
		// `users: null` here — `implicitSelection` marks the base table nullable
		// for a right or full join — so a type that promised it was present was
		// a null dereference the compiler had no reason to flag.
		const on = eq(posts.authorId, users.id);
		type RowOf<T> = Awaited<T> extends readonly (infer R)[] ? R : never;

		type Right = RowOf<typeof rightJoined>;
		const rightJoined = query.select().from(users).rightJoin(posts, on);
		expectTypeOf<Right['users']>().toEqualTypeOf<InferSelect<typeof users> | null>();
		expectTypeOf<Right['posts']>().toEqualTypeOf<InferSelect<typeof posts>>();

		type Full = RowOf<typeof fullJoined>;
		const fullJoined = query.select().from(users).fullJoin(posts, on);
		expectTypeOf<Full['users']>().toEqualTypeOf<InferSelect<typeof users> | null>();
		expectTypeOf<Full['posts']>().toEqualTypeOf<InferSelect<typeof posts> | null>();

		// A left join still leaves the base row alone.
		type Left = RowOf<typeof leftJoined>;
		const leftJoined = query.select().from(users).leftJoin(posts, on);
		expectTypeOf<Left['users']>().toEqualTypeOf<InferSelect<typeof users>>();
	});

	it('keeps natural names when no two collide', () => {
		const compiled = query.select({ u: { id: users.id }, p: { title: posts.title } })
			.from(users)
			.innerJoin(posts, eq(posts.authorId, users.id))
			.compile();

		expect(compiled.columnNames).toEqual(['id', 'title']);
	});

	it('aliases tables for self-joins', () => {
		const author = alias(users, 'author');
		const compiled = query.select({ id: posts.id, author: author.email })
			.from(posts)
			.innerJoin(author, eq(author.id, posts.authorId))
			.compile();

		expect(compiled.sql).toBe(
			'select "posts"."id", "author"."email" as "author" from "posts" '
				+ 'inner join "users" "author" on "author"."id" = "posts"."author_id"',
		);
		expect(compiled.tables).toEqual(['posts', 'users']);
	});

	it('selects from a subquery', () => {
		const recent = query.select({ id: posts.id, views: posts.views }).from(posts).limit(10).as('recent');
		const compiled = query.select({ id: recent.id }).from(recent).where(gt(recent.views, 5)).compile();

		expect(compiled.sql).toBe(
			'select "recent"."id" from (select "posts"."id", "posts"."views" from "posts" limit 10) "recent" '
				+ 'where "recent"."views" > ?',
		);
	});

	/**
	 * A subquery's declared columns have to name what the statement inside it
	 * actually emits.
	 *
	 * `assignKeys` renames the whole projection to `c0…cN` the moment two leaves
	 * share a name, which every nested selection and every implicit join
	 * produces. The subquery surface was derived from `plan.selection` instead —
	 * or, with no explicit selection, from the `from` table's columns, which
	 * drops the joined tables entirely — so it named columns that were not
	 * there. Both spellings compiled cleanly and failed at D1 with `no such
	 * column`, which is why these assert on the emitted text.
	 */
	describe('a subquery over a renamed projection', () => {
		it('references an implicit join by the name the inner statement emits', () => {
			const s = query.select().from(posts)
				.innerJoin(users, eq(users.id, posts.authorId))
				.as('s');

			const compiled = query.select({ id: s.posts.id, who: s.users.email }).from(s).compile();

			// `posts.id` is leaf 0 and `users.email` is leaf 5 of the flattened
			// projection — the outer select has to use those, not "id"/"email".
			expect(compiled.sql).toContain('select "s"."c0" as "id", "s"."c5" as "who" from (');
			expect(compiled.sql).toContain('"posts"."id" as "c0"');
			expect(compiled.sql).toContain('"users"."email" as "c5"');
		});

		it('exposes every joined table, not just the one in `from`', () => {
			const s = query.select().from(posts)
				.innerJoin(users, eq(users.id, posts.authorId))
				.as('s');

			// The whole `users` group used to be missing from the surface.
			expect(Object.keys(s.users)).toEqual([
				'id',
				'email',
				'name',
				'role',
				'active',
				'settings',
				'score',
				'createdAt',
				'updatedAt',
			]);
			expect(Object.keys(s.posts)).toEqual(['id', 'authorId', 'title', 'views']);
		});

		it('does the same for a nested explicit selection', () => {
			const s = query.select({ u: { id: users.id }, p: { id: posts.id } })
				.from(posts)
				.innerJoin(users, eq(users.id, posts.authorId))
				.as('s');

			const compiled = query.select({ a: s.u.id, b: s.p.id }).from(s).compile();

			expect(compiled.sql).toBe(
				'select "s"."c0" as "a", "s"."c1" as "b" from (select "users"."id" as "c0", "posts"."id" as "c1" '
					+ 'from "posts" inner join "users" on "users"."id" = "posts"."author_id") "s"',
			);
		});

		it('leaves a flat projection naming its own columns', () => {
			// Nothing collides, so nothing is renamed and the surface is the
			// selection's own keys — the case that always worked, pinned so the
			// fix cannot regress it into `c0`.
			const s = query.select({ id: posts.id, views: posts.views }).from(posts).as('s');
			const compiled = query.select({ id: s.id }).from(s).compile();

			expect(compiled.sql).toBe('select "s"."id" from (select "posts"."id", "posts"."views" from "posts") "s"');
		});
	});

	it('uses a select as an inArray operand', () => {
		const authors = query.select({ id: posts.authorId }).from(posts);
		const compiled = query.select({ id: users.id }).from(users)
			.where(inArray(users.id, authors))
			.compile();

		expect(compiled.sql).toBe(
			'select "users"."id" from "users" where "users"."id" in '
				+ '(select "posts"."author_id" as "id" from "posts")',
		);
	});

	it('accepts raw sql fragments in the projection', () => {
		const compiled = query.select({ id: users.id, upper: sql<string>`upper(${users.email})` })
			.from(users)
			.compile();
		expect(compiled.sql).toBe('select "users"."id", upper("users"."email") as "upper" from "users"');
	});

	it('memoizes compilation per builder instance', () => {
		const builder = query.select().from(users);
		expect(builder.compile()).toBe(builder.compile());
	});
});

describe('the surface a subquery exposes', () => {
	type RowOf<T> = Awaited<T> extends readonly (infer R)[] ? R : never;

	const on = eq(posts.authorId, users.id);

	it('types a group of columns as the group it reads back as', () => {
		// The runtime has nested since the joined strategy landed, but `Out<>`
		// only had a `Column` branch, so every group inferred as `never` — a
		// type error on `rows[0].posts.title`, for a value the query returns.
		const s = query.select().from(users).innerJoin(posts, on).as('s');
		type Row = RowOf<ReturnType<typeof plain.all>>;
		const plain = query.select().from(s);

		expectTypeOf<Row['users']>().toEqualTypeOf<InferSelect<typeof users>>();
		expectTypeOf<Row['posts']>().toEqualTypeOf<InferSelect<typeof posts>>();
	});

	it('keeps a left-joined group nullable through .as()', () => {
		const s = query.select().from(users).leftJoin(posts, on).as('s');
		type Row = RowOf<ReturnType<typeof plain.all>>;
		const plain = query.select().from(s);

		expectTypeOf<Row['users']>().toEqualTypeOf<InferSelect<typeof users>>();
		expectTypeOf<Row['posts']>().toEqualTypeOf<InferSelect<typeof posts> | null>();
	});

	it('returns null for that group rather than an object of nulls', () => {
		// The type above is only half of it: `implicitSelection` derives
		// nullability from `plan.joins`, and the outer plan over a subquery has
		// none — so the same query gave `posts: null` read directly and
		// `posts: { id: null, … }` read through `.as()`.
		const s = query.select().from(users).leftJoin(posts, on).as('s');
		const compiled = query.select().from(s).compile();

		const userColumns = Object.keys(getTableColumns(users)).length;
		const row = compiled.columnNames.map((_, i) => (i < userColumns ? 1 : null));
		const [mapped] = compiled.map([row]);

		expect(mapped!.posts).toBeNull();
		expect(mapped!.users).not.toBeNull();
	});

	it('treats an untyped sql fragment as one column, not a group', () => {
		// `SubqueryLeaf` enumerates scalars, so `unknown` — what a bare
		// `sql\`…\`` produces — fell to the group branch and expanded the
		// `Column` class structurally at `x.n`.
		const x = query.select({ n: sql`unixepoch()`, m: sql<number>`1` }).from(users).as('x');
		type Row = RowOf<ReturnType<typeof selected.all>>;
		const selected = query.select({ n: x.n, m: x.m }).from(x);

		expectTypeOf<Row['n']>().toEqualTypeOf<unknown>();
		expectTypeOf<Row['m']>().toEqualTypeOf<number>();
		expect(selected.compile().sql).toBe(
			'select "x"."n", "x"."m" from (select unixepoch() as "n", 1 as "m" from "users") "x"',
		);
	});
});

describe('inArray strategy', () => {
	it('binds blob values instead of routing them through json_each', () => {
		// `JSON.stringify(new Uint8Array([1]))` is `{"0":1}`, which matches
		// nothing — and below the threshold the same values bind correctly, so
		// the strategy switch would silently change the answer.
		const blobs = Array.from({ length: 40 }, (_, i) => new Uint8Array([i]));
		const compiled = query.select({ id: users.id }).from(users)
			.where(inArray(users.settings as never, blobs as never))
			.compile();

		expect(compiled.sql).not.toContain('json_each');
		expect(compiled.params).toHaveLength(40);
	});

	it('still uses json_each for ordinary values above the threshold', () => {
		const ids = Array.from({ length: 40 }, (_, i) => i);
		const compiled = query.select({ id: users.id }).from(users)
			.where(inArray(users.id, ids))
			.compile();

		expect(compiled.sql).toContain('json_each');
	});
});
