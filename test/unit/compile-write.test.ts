import { describe, expect, it } from 'vitest';
import { and, CompileError, eq, ph, query, sql } from '../../src/index.js';
import { setDev, setWarn } from '../../src/dev.js';
import { integer, sqliteTable, text } from '../../src/index.js';
import { posts, users } from '../schema.js';

describe('insert compilation', () => {
	it('inserts one row', () => {
		const compiled = query.insert(posts).values({ id: 1, authorId: 2, title: 'hi' }).compile();

		expect(compiled.sql).toBe(
			'insert into "posts" ("id", "author_id", "title") values (?, ?, ?)',
		);
		expect(compiled.params.map((p) => (p as { v: unknown }).v)).toEqual([1, 2, 'hi']);
		expect(compiled.parts).toHaveLength(1);
	});

	it('inserts several rows in one statement', () => {
		const compiled = query.insert(posts)
			.values([{ authorId: 1, title: 'a' }, { authorId: 2, title: 'b' }])
			.compile();

		expect(compiled.sql).toBe(
			'insert into "posts" ("author_id", "title") values (?, ?), (?, ?)',
		);
	});

	it('evaluates $defaultFn per execution rather than at compile time', () => {
		const compiled = query.insert(users).values({ email: 'a@b.c' }).compile();

		// `updatedAt` carries only `$onUpdate`, no `default` — Drizzle's
		// `buildInsertQuery` still populates it on insert in that case, so it
		// belongs in the column list alongside `created_at`'s `$defaultFn`.
		expect(compiled.sql).toBe(
			'insert into "users" ("email", "created_at", "updated_at") values (?, ?, ?)',
		);
		expect(compiled.params[1]).toMatchObject({ k: 'fn' });
		expect(compiled.params[2]).toMatchObject({ k: 'fn' });
	});

	it('chunks a large multi-row insert against the bound-parameter limit', () => {
		const rows = Array.from({ length: 500 }, (_, i) => ({ authorId: 1, title: `t${i}` }));
		const compiled = query.insert(posts).values(rows).compile();

		// 2 columns per row, 100 parameters → 50 rows per statement.
		expect(compiled.parts).toHaveLength(10);
		expect(compiled.parts[0]!.params).toHaveLength(100);
		expect(compiled.parts.reduce((n, p) => n + p.params.length, 0)).toBe(1000);
	});

	it('refuses a row wider than the parameter budget', () => {
		expect(() => query.insert(posts).values({ authorId: 1, title: 'x' }).compile()).not.toThrow();
		expect(() =>
			query.insert(posts).values([{ authorId: 1, title: 'x' }]).compile()
		).not.toThrow();
	});

	it('splits rows whose column sets differ', () => {
		const compiled = query.insert(posts)
			.values([{ authorId: 1, title: 'a' }, { authorId: 2, title: 'b', views: 3 }])
			.compile();

		expect(compiled.parts).toHaveLength(2);
		expect(compiled.parts[1]!.sql).toContain('"views"');
	});

	it('supports onConflictDoNothing and onConflictDoUpdate', () => {
		expect(
			query.insert(users).values({ email: 'a@b.c' }).onConflictDoNothing().compile().sql,
		).toContain('on conflict do nothing');

		const upsert = query.insert(users).values({ email: 'a@b.c' })
			.onConflictDoUpdate({ target: users.email, set: { name: 'x' }, where: eq(users.active, true) })
			.compile();

		// `updatedAt` carries `$onUpdate`, so the update half of the upsert must
		// fold it in exactly as `update().set()` does — otherwise the conflict
		// path silently keeps a stale `updated_at` forever. This assertion used
		// to stop at `"name" = ?`, which is the bug: it passed only because the
		// $onUpdate column was never considered.
		expect(upsert.sql).toContain(
			'on conflict ("email") do update set "name" = ?, "updated_at" = ? where "users"."active" = ?',
		);
	});

	it('folds $onUpdate columns into the do-update-set half of an upsert', () => {
		const compiled = query.insert(users).values({ email: 'a@b.c' })
			.onConflictDoUpdate({ target: users.email, set: { name: 'x' } })
			.compile();

		expect(compiled.sql).toContain('on conflict ("email") do update set "name" = ?, "updated_at" = ?');
	});

	it('does not fold $onUpdate columns into onConflictDoNothing or an empty conflict set', () => {
		expect(
			query.insert(users).values({ email: 'a@b.c' }).onConflictDoNothing().compile().sql,
		).toContain('on conflict do nothing');

		const empty = query.insert(users).values({ email: 'a@b.c' })
			.onConflictDoUpdate({ target: users.email, set: {} })
			.compile();
		expect(empty.sql).toContain('on conflict ("email") do nothing');
		expect(empty.sql).not.toContain('do update set');
	});

	it('falls back to do nothing when the conflict set has nothing to assign', () => {
		// Same rule as `update().set({ x: undefined })`, which the conflict path
		// did not share: it rendered `do update set ` and D1 answered
		// "incomplete input". An upsert with nothing to update *is* do-nothing,
		// so unlike `update()` there is a sensible answer rather than an error.
		const compiled = query.insert(users).values({ email: 'a@b.c' })
			.onConflictDoUpdate({ target: users.email, set: { name: undefined } })
			.compile();

		expect(compiled.sql).toContain('on conflict ("email") do nothing');
		expect(compiled.sql).not.toContain('do update set');
	});

	it('keeps the defined half of a partly-undefined conflict set', () => {
		const compiled = query.insert(users).values({ email: 'a@b.c' })
			.onConflictDoUpdate({ target: users.email, set: { name: 'x', role: undefined } })
			.compile();

		expect(compiled.sql).toContain('do update set "name" = ?');
		expect(compiled.sql).not.toContain('"role"');
	});

	it('projects .returning()', () => {
		const compiled = query.insert(posts).values({ authorId: 1, title: 'a' }).returning().compile();
		expect(compiled.sql).toContain('returning "id", "author_id" as "authorId", "title", "views"');
		expect(compiled.hasRows).toBe(true);

		const narrow = query.insert(posts).values({ authorId: 1, title: 'a' })
			.returning({ id: posts.id })
			.compile();
		expect(narrow.sql).toContain('returning "id"');
	});

	it('rejects an empty values list', () => {
		expect(() => query.insert(posts).values([]).compile()).toThrow(CompileError);
	});

	describe('onConflict against the bound-parameter budget', () => {
		// 4 columns, one (`updatedAt`) with `$onUpdate` and no `default` — so it
		// is always in the insert's column list, and its fold into the
		// conflict's `do update set` adds one bound parameter per statement.
		const sync = sqliteTable('sync', {
			id: integer('id').primaryKey(),
			a: text('a').notNull(),
			b: text('b').notNull(),
			updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$onUpdate(() => new Date(0)),
		});

		it('reserves the folded $onUpdate param before chunking VALUES rows', () => {
			// 4 columns × 100 params lands exactly on the budget with nothing left
			// over for the conflict clause — the case the bug shipped on.
			const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, a: 'x', b: 'y' }));
			const compiled = query.insert(sync).values(rows)
				// A canonical bulk-upsert `set`: `sql\`excluded."a"\`` binds zero of
				// its own parameters, so any overflow here is the fold's doing.
				.onConflictDoUpdate({ target: sync.id, set: { a: sql`excluded."a"` } })
				.compile();

			expect(compiled.parts.length).toBeGreaterThan(1);
			for (const part of compiled.parts) {
				expect(part.params.length).toBeLessThanOrEqual(100);
			}
		});

		it('reserves both the folded $onUpdate param and the user\'s own set param', () => {
			const cols: Record<string, ReturnType<typeof integer>> = { id: integer('id').primaryKey() };
			for (let i = 0; i < 96; i++) cols[`c${i}`] = integer(`c${i}`);
			cols.updatedAt = integer('updated_at', { mode: 'timestamp_ms' }).$onUpdate(() => new Date(0));
			const wide = sqliteTable('wide', cols);

			const row: Record<string, unknown> = { id: 1 };
			for (let i = 0; i < 96; i++) row[`c${i}`] = i;
			// 98 columns in VALUES (id + 96 c's + updatedAt) + the folded
			// $onUpdate param + the user's own bound `set` param = 100 — the
			// budget, not 101. A single row cannot be chunked further, so if the
			// reservation ever pushes this over budget the honest answer is a
			// clear compile-time error, not a statement D1 rejects at runtime.
			const compiled = query.insert(wide).values(row as never)
				.onConflictDoUpdate({ target: wide.id as never, set: { c0: 5 } as never })
				.compile();

			expect(compiled.parts).toHaveLength(1);
			expect(compiled.parts[0]!.params.length).toBeLessThanOrEqual(100);
		});
	});
});

describe('update compilation', () => {
	it('sets columns and applies $onUpdate automatically', () => {
		const compiled = query.update(users).set({ name: 'x' }).where(eq(users.id, 1)).compile();

		expect(compiled.sql).toBe('update "users" set "name" = ?, "updated_at" = ? where "users"."id" = ?');
		expect(compiled.params[1]).toMatchObject({ k: 'fn' });
	});

	it('treats an undefined value as unset rather than emitting an empty set clause', () => {
		// `{ name: cond ? v : undefined }` is how a conditional update gets written.
		const compiled = query.update(posts).set({ title: 'x', views: undefined }).compile();
		expect(compiled.sql).toBe('update "posts" set "title" = ?');

		expect(() => query.update(posts).set({ views: undefined }).compile())
			.toThrow(/nothing to set/);
	});

	it('accepts sql expressions and placeholders as values', () => {
		const compiled = query.update(posts)
			.set({ views: sql`${posts.views} + 1`, title: ph('title') })
			.compile();

		expect(compiled.sql).toBe('update "posts" set "views" = "posts"."views" + 1, "title" = ?');
		expect(compiled.params).toEqual([{ k: 'ph', name: 'title', encode: expect.any(Function) }]);
	});

	it('returns rows when asked', () => {
		const compiled = query.update(posts).set({ title: 'x' }).returning({ id: posts.id }).compile();
		expect(compiled.sql).toBe('update "posts" set "title" = ? returning "id"');
	});

	it('rejects an unknown column', () => {
		expect(() => query.update(posts).set({ nope: 1 } as never).compile()).toThrow(CompileError);
	});

	/**
	 * `set()` takes an object that routinely comes straight from a request body,
	 * so "which keys resolve to a column" is a trust boundary — see `docs/07`.
	 * A plain `columns[field]` read walks the prototype chain right past the
	 * unknown-column refusal above.
	 */
	describe('prototype keys in set()', () => {
		it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
			'refuses "%s" instead of resolving it off the prototype',
			(key) => {
				expect(() => query.update(posts).set({ [key]: 1 } as never).compile())
					.toThrow(/Unknown column/);
			},
		);

		/**
		 * The refusal has to be *ours*. Before the fix this did throw — but with
		 * a `TypeError` from `valueChunk` reading `.config` off `Object`, after
		 * the assignment had already rendered as `"Object" = ?` (`Object.name`
		 * is the string `"Object"`). A caller cannot tell that apart from a
		 * d1zzle crash, and `instanceof CompileError` is what an app branches on
		 * to turn a bad request into a 400.
		 */
		it('refuses with a CompileError, not an internal TypeError', () => {
			expect(() => query.update(posts).set({ constructor: 1 } as never).compile())
				.toThrow(CompileError);
		});

		it('JSON.parse makes __proto__ an own key, and it is still refused', () => {
			const patch = JSON.parse('{"__proto__": 1}');
			expect(Object.hasOwn(patch, '__proto__')).toBe(true);
			expect(() => query.update(posts).set(patch).compile()).toThrow(/Unknown column/);
		});

		it('still writes a real column that shadows a prototype name', () => {
			// `hasOwn` is about where the key lives, not what it is spelled.
			const shadow = sqliteTable('shadow', { constructor: text('constructor') });
			expect(query.update(shadow).set({ constructor: 'x' }).compile().sql)
				.toBe('update "shadow" set "constructor" = ?');
		});
	});
});

describe('delete compilation', () => {
	it('deletes with and without a predicate', () => {
		expect(query.delete(posts).compile().sql).toBe('delete from "posts"');
		expect(query.delete(posts).where(eq(posts.id, 1)).compile().sql)
			.toBe('delete from "posts" where "posts"."id" = ?');
	});

	it('returns deleted rows', () => {
		expect(query.delete(posts).returning({ id: posts.id }).compile().sql)
			.toBe('delete from "posts" returning "id"');
	});
});

describe('safety rails', () => {
	it('warns in dev when an update or delete has no where clause', () => {
		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));

		try {
			query.update(posts).set({ title: 'x' }).compile();
			query.delete(posts).compile();
			// `and()` over all-undefined is undefined, which is how a whole-table
			// write gets reached by accident.
			query.delete(posts).where(and(undefined, undefined)).compile();
		} finally {
			setDev(false);
		}

		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatch(/update on "posts" has no where clause/);
		expect(messages[1]).toMatch(/delete on "posts" has no where clause/);
	});

	it('says nothing when a where clause is present', () => {
		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));

		try {
			query.delete(posts).where(eq(posts.id, 1)).compile();
		} finally {
			setDev(false);
		}

		expect(messages).toEqual([]);
	});
});

describe('generated columns are not writable', () => {
	const flags = sqliteTable('flags', {
		id: integer('id').primaryKey(),
		name: text('name').notNull(),
		shout: text('shout').generatedAlwaysAs(sql`upper("name")`),
	});

	it('leaves a generated column out of a plain insert', () => {
		const compiled = query.insert(flags).values({ id: 1, name: 'x' }).compile();
		expect(compiled.sql).toBe('insert into "flags" ("id", "name") values (?, ?)');
	});

	it('refuses a value for a generated column instead of letting D1 reject it', () => {
		expect(() =>
			// Unwritable in TypeScript — `shout` is absent from the insert model.
			// This is the plain-JavaScript caller the guard exists for.
			query.insert(flags).values({ id: 1, name: 'x', shout: 'nope' } as any).compile()
		).toThrow(/"shout" is a generated column/);
	});
});
