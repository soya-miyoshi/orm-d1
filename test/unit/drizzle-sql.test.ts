/**
 * The Drizzle `SQL` bridge.
 *
 * These fragments are built with Drizzle's *own* `sql`/`eq`/`and`/`inArray`
 * over orm-d1 columns — the exact thing Pothos' drizzle plugin does when it
 * assembles `where: { RAW: (table) => … }`. The assertion is that they render
 * the same operands and bind the same values as the equivalent orm-d1
 * expression, Drizzle's extra parenthesisation aside.
 */
import { and as dAnd, eq as dEq, inArray as dInArray, sql as dSql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { asDrizzleTable } from '../../src/drizzle.js';
import { compileSelect } from '../../src/plan/compile.js';
import { and, eq, inArray } from '../../src/sql/expressions.js';
import type { SQLChunk } from '../../src/sql/sql.js';
import { defaultRenderContext, isDrizzleSQL, isForeignSQL, isSQLChunk, render } from '../../src/sql/sql.js';
import { posts, users } from '../schema.js';

/**
 * The same objects, twice.
 *
 * Drizzle's builders are typed against its own `Column`, which declares a
 * `protected config` — a protected member is only ever compatible with itself,
 * so no independent class can be assignable to it. `asDrizzleTable` is the
 * documented way across (see `src/drizzle.ts`) and is identity at runtime, so
 * `dUsers.id` and `users.id` are one column with two spellings. That is the
 * whole point: a fragment built through the Drizzle-typed view still renders
 * through ours.
 */
const dUsers = asDrizzleTable(users);
const dPosts = asDrizzleTable(posts);

const rendered = (chunk: SQLChunk) => render(chunk, defaultRenderContext);

describe('recognising a foreign fragment', () => {
	it('identifies a Drizzle SQL by its entityKind chain, with no import of `is`', () => {
		expect(isDrizzleSQL(dSql`1 = 1`)).toBe(true);
		expect(isDrizzleSQL(eq(users.id, 1))).toBe(false);
	});

	it('treats a Drizzle SQLWrapper as foreign but leaves our own columns alone', () => {
		// An orm-d1 column is a `SQLWrapper` too — `getSQL()` returns itself — and
		// must keep rendering through our own path.
		expect(isForeignSQL(users.id)).toBe(false);
		expect(isForeignSQL(dSql`1`)).toBe(true);
	});

	it('accepts a Drizzle fragment as a chunk, so it is not mistaken for a selection object', () => {
		expect(isSQLChunk(dSql`1 = 1`)).toBe(true);
	});
});

describe('rendering matches the equivalent orm-d1 expression', () => {
	it('renders a comparison identically', () => {
		expect(rendered(dEq(dUsers.id, 42) as never)).toEqual(rendered(eq(users.id, 42)));
	});

	it('renders a conjunction with the same operands and bindings', () => {
		const theirs = rendered(dAnd(dEq(dUsers.id, 1), dEq(dUsers.email, 'a@b.c'))! as never);
		const ours = and(eq(users.id, 1), eq(users.email, 'a@b.c'))!.toQuery(defaultRenderContext);
		// Drizzle parenthesises each operand and we do not. The grouping differs,
		// the meaning does not — so this pins the spelling Drizzle actually
		// produces rather than pretending the two are byte-identical.
		expect(theirs.sql).toBe('(("users"."id" = ?) and ("users"."email" = ?))');
		expect(theirs.sql.replaceAll('(', '').replaceAll(')', ''))
			.toBe(ours.sql.replaceAll('(', '').replaceAll(')', ''));
		expect(theirs.params).toEqual(ours.params);
	});

	it('qualifies columns with their table', () => {
		expect(rendered(dEq(dPosts.authorId, 7) as never).sql).toBe('"posts"."author_id" = ?');
	});

	it('binds values through the column encoder, as Drizzle does', () => {
		// `active` is `mode: 'boolean'`, so `true` has to reach D1 as `1`.
		expect(rendered(dEq(dUsers.active, true) as never).params).toEqual([{ k: 'const', v: 1 }]);
	});

	it('renders inArray over an orm-d1 column', () => {
		const theirs = rendered(dInArray(dUsers.id, [1, 2, 3]) as never);
		expect(theirs.sql).toBe('"users"."id" in (?, ?, ?)');
		expect(theirs.params).toEqual([1, 2, 3].map((v) => ({ k: 'const', v })));
		expect(theirs.sql).toBe(rendered(inArray(users.id, [1, 2, 3])).sql);
	});

	it('renders the tuple form the Pothos loader builds for a composite key', () => {
		const fragment = dSql`(${dSql.join([dUsers.id, dUsers.email], dSql`, `)})`;
		expect(rendered(fragment as never).sql).toBe('("users"."id", "users"."email")');
	});

	it('defers a Drizzle placeholder to execution time rather than binding a value', () => {
		const { params } = rendered(dEq(dUsers.id, dSql.placeholder('wanted')) as never);
		expect(params).toEqual([{ k: 'ph', name: 'wanted' }]);
	});
});

describe('a foreign fragment inside a compiled statement', () => {
	it('composes into a where clause and numbers its parameters in order', () => {
		const compiled = compileSelect(
			{
				kind: 'select',
				selection: { id: users.id },
				from: users,
				joins: [],
				where: and(eq(users.active, true), dEq(dUsers.id, 42) as never),
				orderBy: [],
				groupBy: [],
				distinct: false,
			} as never,
			defaultRenderContext,
		);
		expect(compiled.sql).toContain('"users"."id" = ?');
		expect(compiled.params).toEqual([{ k: 'const', v: 1 }, { k: 'const', v: 42 }]);
	});

	it('interpolates into our own template tag', () => {
		const fragment = dSql`coalesce(${dUsers.name}, 'anon')`;
		expect(rendered(eq(fragment as never, 'x')).sql).toBe(`coalesce("users"."name", 'anon') = ?`);
	});
});

describe('the DDL empty-array-predicate refusal also covers Drizzle fragments', () => {
	// [F-087]: `src/sql/sql.ts`'s own template tag refuses an empty array
	// interpolated into a DDL predicate via `ctx.onEmptyArrayPredicate` — but a
	// check() or partial-index where() written with Drizzle's *own* `sql` tag
	// renders through `fromDrizzleSQL`, which never consulted that hook, so
	// `check("role" not in ())` sailed through silently. This closes that gap
	// at the one place `fromDrizzleSQL` structurally sees Drizzle's own
	// `queryChunks` — no text/string heuristics.
	const ddlCtx = { ...defaultRenderContext, bareColumns: true, onEmptyArrayPredicate: () => {
		throw new Error('empty array refused');
	} };

	it('invokes onEmptyArrayPredicate for a bare Drizzle sql fragment with an empty array', () => {
		const roles: string[] = [];
		const fragment = dSql`${dUsers.role} not in ${roles}`;
		expect(() => render(fragment as never, ddlCtx)).toThrow(/empty array refused/);
	});

	it('invokes it for an empty array nested inside and()/eq() composition', () => {
		const roles: string[] = [];
		const fragment = dAnd(dEq(dUsers.id, 1), dSql`${dUsers.role} not in ${roles}`)!;
		expect(() => render(fragment as never, ddlCtx)).toThrow(/empty array refused/);
	});

	it('does not invoke it for a non-empty array', () => {
		const fragment = dSql`${dUsers.role} not in ${['admin', 'member']}`;
		expect(() => render(fragment as never, ddlCtx)).not.toThrow();
	});

	it('does not invoke it outside a DDL context (bareColumns unset)', () => {
		const roles: string[] = [];
		const fragment = dSql`${dUsers.role} not in ${roles}`;
		expect(() => render(fragment as never, defaultRenderContext)).not.toThrow();
		expect(rendered(fragment as never).sql).toBe('"users"."role" not in ()');
	});
});
