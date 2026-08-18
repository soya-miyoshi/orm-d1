/**
 * [F-4] `snapshotFromSchema` renders a `check()` constraint's value with a
 * bare `renderInline(extra.meta.value)` call — not through `checkDDL`, which
 * is what normally wires up `withDDLContext` and attaches the table/
 * constraint name to a thrown error. Snapshot generation runs *before* the
 * diff engine's own `checkDDL` call would, so a schema with a `check()` that
 * triggers the empty-array DDL refusal (an interpolated empty array in a
 * `not in`/`in` predicate — see `src/ddl.ts`) used to throw an anonymous
 * error the moment `orm-d1-kit generate` scanned the schema, long before the
 * diff step that would otherwise have named it.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { check, index, integer, sql, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

describe('snapshotting a schema with a failing check constraint', () => {
	it('names the table and constraint, not an anonymous error', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', sql`${c.role} not in ${roles}`),
		]);

		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
		expect(() => snapshotFromSchema({ users })).toThrow(/table "users"/);
		expect(() => snapshotFromSchema({ users })).toThrow(/constraint "users_role_check"/);
	});

	// `snapshotFromSchema` is the only place in the kit where a check's chunk
	// becomes text — `generate`/`check`/`push` all render tables from the
	// snapshot — so a refusal that fires only in `createTable` never sees a
	// migration. Drizzle collapses `inArray(c, [])` to `sql`false`` and
	// `notInArray(c, [])` to `sql`true`` *before* orm-d1 sees any array chunk,
	// so these spellings are only caught by the bare-boolean check, and only
	// when this call site asks for it.
	it('refuses a Drizzle notInArray over an empty array, which collapses to `true`', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', notInArray(c.role as never, roles) as never),
		]);

		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
		expect(() => snapshotFromSchema({ users })).toThrow(/constraint "users_role_check"/);
	});

	it('refuses a Drizzle inArray over an empty array, which collapses to `false`', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', inArray(c.role as never, roles) as never),
		]);

		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
	});

	it('refuses one nested inside a Drizzle and()', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', and(eq(c.id as never, 1), notInArray(c.role as never, roles)) as never),
		]);

		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
	});

	it('refuses one in a partial index predicate, naming the table and index', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			index('users_role_idx').on(c.role).where(notInArray(c.role as never, roles) as never),
		]);

		// The bare `/empty array/` assertion alone does not catch a regression
		// that drops the `(table "…", constraint "…")` context suffix — a
		// refactor removed the `withDDLContext` wrapper around this exact
		// `renderInline` call while leaving the message's own "empty array"
		// text untouched, so only asserting on the context suffix as well
		// actually exercises the fix.
		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
		expect(() => snapshotFromSchema({ users })).toThrow(/\(table "users", constraint "users_role_idx"\)/);
	});

	it('refuses one in an index EXPRESSION COLUMN, naming the table and index', () => {
		// Same shape as the previous test, but the empty-array refusal comes
		// from the column expression itself (`.on(sql\`... in ${roles}\`)`)
		// rather than from `.where(...)` — a sibling of the `[F-028]` fix that
		// the `withDDLContext` restoration missed: `snapshot.ts` re-wrapped the
		// `where` render but left the `columns` render bare, so this exact
		// shape still threw an anonymous error. (Drizzle's `inArray()` helper
		// itself short-circuits an empty array to `sql\`false\`` before any of
		// this code sees an array chunk — see the block comment on
		// `hasEmptyArrayChunk` in `src/ddl.ts` — so, unlike the earlier check()
		// tests, this has to use a raw `sql` template to actually reach the
		// array-chunk detection on a non-predicate render path.)
		const roles: string[] = [];
		const users2 = sqliteTable('users2', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			index('users2_role_idx').on(sql`${c.role} in ${roles}` as never),
		]);

		expect(() => snapshotFromSchema({ users2 })).toThrow(/empty array/);
		expect(() => snapshotFromSchema({ users2 })).toThrow(/\(table "users2", constraint "users2_role_idx"\)/);
	});

	it('still snapshots a legitimate check and a legitimate partial index', () => {
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', notInArray(c.role as never, ['banned']) as never),
			index('users_role_idx').on(c.role).where(eq(c.id as never, 1) as never),
		]);

		const snapshot = snapshotFromSchema({ users });
		expect(snapshot.tables.users!.checkConstraints!.users_role_check!.value).toContain('not in');
		expect(snapshot.tables.users!.indexes!.users_role_idx!.where).toBe('"id" = 1');
	});
});
