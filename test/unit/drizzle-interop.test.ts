/**
 * The promise this suite protects: an orm-d1 schema is indistinguishable from a
 * Drizzle schema to Drizzle's *own* code. Everything imported below comes from
 * the real `drizzle-orm` package (a devDependency — never a runtime one), and
 * is handed objects built by orm-d1.
 */
import { getTableColumns as drizzleGetTableColumns, getTableName as drizzleGetTableName, is } from 'drizzle-orm';
import { Column as DrizzleColumn, Table as DrizzleTable } from 'drizzle-orm';
import * as dz from 'drizzle-orm/sqlite-core';
import { SQLiteColumn, SQLiteInteger, SQLiteTable, SQLiteText } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-orm/zod';
import { describe, expect, it } from 'vitest';
import { alias, blob, integer, query, real, numeric, sql, sqliteTable, text } from '../../src/index.js';
import { postTags, posts, users } from '../schema.js';

describe('drizzle entity recognition', () => {
	it('recognises our tables as SQLite tables', () => {
		expect(is(users, SQLiteTable)).toBe(true);
		expect(is(users, DrizzleTable)).toBe(true);
		expect(is(posts, SQLiteTable)).toBe(true);
		expect(is(postTags, SQLiteTable)).toBe(true);
	});

	it('recognises our columns, down to the concrete column class', () => {
		expect(is(users.id, DrizzleColumn)).toBe(true);
		expect(is(users.id, SQLiteColumn)).toBe(true);
		expect(is(users.id, SQLiteInteger)).toBe(true);
		expect(is(users.email, SQLiteText)).toBe(true);
		// drizzle-graphql uses exactly this check to decide whether a primary
		// key is auto-generated and can be omitted from insert mutations.
		expect(is(users.email, SQLiteInteger)).toBe(false);
	});

	it('does not claim to be something it is not', () => {
		expect(is({}, SQLiteTable)).toBe(false);
		expect(is(users.id, SQLiteTable)).toBe(false);
	});

	it('answers drizzle-orm’s own accessors', () => {
		expect(drizzleGetTableName(users as never)).toBe('users');
		expect(Object.keys(drizzleGetTableColumns(users as never))).toEqual([
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
	});

	it('gives a subquery’s columns the same concrete classes as a table’s', () => {
		// A subquery is a table everywhere except the `from` clause, so an
		// adapter branching on `is(col, SQLiteInteger)` has to get the same
		// answer from one. These were built from the base `Column` class, which
		// fails that walk for every type — the exact check this whole module
		// exists to satisfy, skipped in the one place the column is synthesised
		// rather than declared.
		const s = query.select({ id: users.id, who: users.email }).from(users).as('s');

		expect(is(s.id, SQLiteInteger)).toBe(true);
		expect(is(s.who, SQLiteText)).toBe(true);
		expect(is(s.id, SQLiteColumn)).toBe(true);
		expect(is(s.id, SQLiteText)).toBe(false);
	});

	it('types a projected expression as text, since nothing better is known', () => {
		// The fallback path: an arbitrary fragment has no column to copy a class
		// from, so it gets `SQLiteText` — and must still be *a* SQLite column
		// rather than the bare base class.
		const s = query.select({ n: sql<number>`count(*)` }).from(users).as('s');

		expect(is(s.n, SQLiteColumn)).toBe(true);
		expect(is(s.n, SQLiteText)).toBe(true);
	});

	it('reports an alias the way drizzle does', () => {
		const author = alias(users, 'author');
		expect(drizzleGetTableName(author as never)).toBe('author');
		expect(is(author, SQLiteTable)).toBe(true);
	});
});

describe('the column surface adapters read', () => {
	/**
	 * `dataType` must match Drizzle 1.0.0-rc.4's `"<type> <constraint>"` pair
	 * spelling exactly — table-driven against the real `drizzle-orm/sqlite-core`
	 * builders, so a version bump on either side shows up here rather than as a
	 * silently wrong string a hand-written expectation would not catch.
	 */
	const dataTypeCases: [string, () => { d1: { dataType: string }; dz: { dataType: string } }][] = [
		['integer()', () => ({
			d1: sqliteTable('a', { c: integer() }).c,
			dz: dz.sqliteTable('a', { c: dz.integer() }).c,
		})],
		['integer({ mode: "timestamp" })', () => ({
			d1: sqliteTable('a', { c: integer({ mode: 'timestamp' }) }).c,
			dz: dz.sqliteTable('a', { c: dz.integer({ mode: 'timestamp' }) }).c,
		})],
		['text({ enum: [...] })', () => ({
			d1: sqliteTable('a', { c: text({ enum: ['x', 'y'] }) }).c,
			dz: dz.sqliteTable('a', { c: dz.text({ enum: ['x', 'y'] }) }).c,
		})],
		['text()', () => ({
			d1: sqliteTable('a', { c: text() }).c,
			dz: dz.sqliteTable('a', { c: dz.text() }).c,
		})],
		["text('c')", () => ({
			d1: sqliteTable('a', { c: text('c') }).c,
			dz: dz.sqliteTable('a', { c: dz.text('c') }).c,
		})],
		["text('c', { length: 5 })", () => ({
			d1: sqliteTable('a', { c: text('c', { length: 5 }) }).c,
			dz: dz.sqliteTable('a', { c: dz.text('c', { length: 5 }) }).c,
		})],
		['text({ mode: "json" })', () => ({
			d1: sqliteTable('a', { c: text({ mode: 'json' }) }).c,
			dz: dz.sqliteTable('a', { c: dz.text({ mode: 'json' }) }).c,
		})],
		['real()', () => ({
			d1: sqliteTable('a', { c: real() }).c,
			dz: dz.sqliteTable('a', { c: dz.real() }).c,
		})],
		['numeric()', () => ({
			d1: sqliteTable('a', { c: numeric() }).c,
			dz: dz.sqliteTable('a', { c: dz.numeric() }).c,
		})],
		['blob({ mode: "buffer" })', () => ({
			d1: sqliteTable('a', { c: blob({ mode: 'buffer' }) }).c,
			dz: dz.sqliteTable('a', { c: dz.blob({ mode: 'buffer' }) }).c,
		})],
		['blob({ mode: "bigint" })', () => ({
			d1: sqliteTable('a', { c: blob({ mode: 'bigint' }) }).c,
			dz: dz.sqliteTable('a', { c: dz.blob({ mode: 'bigint' }) }).c,
		})],
	];

	it.each(dataTypeCases)('matches drizzle-orm\'s dataType for %s', (_label, build) => {
		const { d1, dz: dzCol } = build();
		expect(d1.dataType).toBe(dzCol.dataType);
	});

	it('infers `text(name, { enum: [...] })` as an enum at the type level without `as const`', () => {
		// Runtime already gets this right (see the table above); this is the
		// type-level half of the same guarantee. `drizzle-orm/sqlite-core`'s
		// `text()` constrains its `enum` option with a tuple generic
		// (`T extends Readonly<[U, ...U[]]>`), which is what lets a plain array
		// literal infer as a tuple with no `as const` — a looser
		// `TEnum extends readonly string[]` widens the literal to `string[]`
		// and silently falls back to the "no enum" branch at compile time even
		// though the value is a real enum at runtime.
		type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 0) extends (<T>() => T extends B ? 1 : 0) ? true : false;

		const roleColumn = sqliteTable('role_no_as_const', {
			role: text('role', { enum: ['admin', 'member'] }),
		}).role;

		// `.dataType` itself is typed as the widened `DrizzleDataType` union
		// (it has to be — adapters read it off `Column<M>` generically); the
		// phantom, still-narrow type lives on `._`, Drizzle's own inference
		// surface (`DrizzleColumnShape`, mirrored in src/schema/columns.ts).
		type RoleDataType = (typeof roleColumn)['_']['dataType'];
		const assertion: AssertEqual<RoleDataType, 'string enum'> = true;
		void assertion;

		// And the runtime value agrees, as it always did.
		expect(roleColumn.dataType).toBe('string enum');

		// `._['data']` narrows to the enum union, not the widened `string`.
		type RoleData = (typeof roleColumn)['_']['data'];
		const dataAssertion: AssertEqual<RoleData, 'admin' | 'member'> = true;
		void dataAssertion;
	});

	it('infers a plain text() column as `string`, not an enum', () => {
		// Regression: `DataTypeOf` used to compare `TEnum` (instantiated with
		// `Writable<T>`, which strips `readonly`) against the *readonly* enum
		// tuple, so the `Equal` check never matched and every plain `text()`
		// column was misreported as an enum. Fixed by comparing against the
		// mutable `[string, ...string[]]`, matching drizzle-orm's own
		// `text.d.ts`.
		type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 0) extends (<T>() => T extends B ? 1 : 0) ? true : false;

		const plainColumn = sqliteTable('plain_text', { c: text('c') }).c;
		type PlainDataType = (typeof plainColumn)['_']['dataType'];
		const assertion: AssertEqual<PlainDataType, 'string'> = true;
		void assertion;

		expect(plainColumn.dataType).toBe('string');
	});

	it('exposes dataType, columnType and the SQL type, matching a real drizzle-orm build of the same columns', () => {
		// Built the same way `users` is (`test/schema.ts`), against the real
		// `drizzle-orm/sqlite-core`, so this fails the moment orm-d1's dataType
		// or columnType strings diverge from an actual Drizzle build — not just
		// from a literal read off orm-d1's own implementation. See `[F-014]`.
		const dzUsers = dz.sqliteTable('users_dz', {
			id: dz.integer('id').primaryKey({ autoIncrement: true }),
			email: dz.text('email').notNull().unique(),
			active: dz.integer('active', { mode: 'boolean' }).notNull().default(true),
			createdAt: dz.integer('created_at', { mode: 'timestamp' }).notNull(),
			settings: dz.text('settings', { mode: 'json' }),
		});

		for (const key of ['id', 'email', 'active', 'createdAt', 'settings'] as const) {
			expect(users[key].dataType).toBe(dzUsers[key].dataType);
			expect(users[key].columnType).toBe(dzUsers[key].columnType);
			expect(users[key].getSQLType()).toBe(dzUsers[key].getSQLType());
		}
		expect(users.id.primary).toBe(dzUsers.id.primary);
		expect(users.email.notNull).toBe(dzUsers.email.notNull);
	});

	it('changes zod behaviour: a timestamp column now rejects a non-date value', () => {
		// Before the fix, `createdAt.dataType` was the flat `'date'`, which the
		// v1 zod adapter's `columnToSchema` does not recognise as its `"date"`
		// branch — it fell through to a permissive default. The pair spelling
		// `'object date'` is what makes the adapter emit `z.date()` and this
		// actually reject something.
		const schema = createSelectSchema(users as never);
		const shape = (schema as unknown as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> })
			.shape;
		expect(shape.createdAt!.safeParse('not a date').success).toBe(false);
	});

	it('classifies every blob mode, matching a real drizzle-orm build of the same columns', () => {
		const t = sqliteTable('t', {
			bytes: blob('bytes', { mode: 'buffer' }),
			payload: blob('payload'),
			big: blob('big', { mode: 'bigint' }),
		});
		const dzT = dz.sqliteTable('t_dz', {
			bytes: dz.blob('bytes', { mode: 'buffer' }),
			payload: dz.blob('payload'),
			big: dz.blob('big', { mode: 'bigint' }),
		});

		for (const key of ['bytes', 'payload', 'big'] as const) {
			expect(t[key].dataType).toBe(dzT[key].dataType);
			expect(t[key].columnType).toBe(dzT[key].columnType);
		}
	});

	it('defaults blob() to json mode, not buffer', () => {
		expect(blob('x').build('x').columnType).toBe('SQLiteBlobJson');
	});

	it('round trips a json blob through encode/decode', () => {
		const column = blob('x').build('x');
		const bytes = column.mapToDriverValue({ a: 1 });
		expect(column.mapFromDriverValue(bytes)).toEqual({ a: 1 });
	});

	it('exposes length and isLengthExact like drizzle-orm does', () => {
		const d1 = sqliteTable('a', { short: text('short', { length: 5 }) }).short;
		const dzCol = dz.sqliteTable('a', { short: dz.text('short', { length: 5 }) }).short;
		expect(d1.length).toBe(5);
		expect(d1.length).toBe(dzCol.length);
		expect(d1.isLengthExact).toBe(dzCol.isLengthExact);
	});

	// `[F-012]`: getSQLType() is Drizzle-faithful and includes the length —
	// DDL/snapshot rendering reads `declaredType ?? type` separately and is
	// unaffected (see `test/unit/ddl.test.ts` and `kit/test/unit/`).
	it('folds text length into getSQLType(), matching drizzle-orm exactly', () => {
		const d1 = sqliteTable('a', { long: text('long', { length: 255 }) }).long;
		const dzCol = dz.sqliteTable('a', { long: dz.text('long', { length: 255 }) }).long;
		expect(d1.getSQLType()).toBe('text(255)');
		expect(d1.getSQLType()).toBe(dzCol.getSQLType());
	});

	it('drops length from getSQLType() for a json-mode text column, matching drizzle-orm', () => {
		const d1 = sqliteTable('a', { j: text('j', { mode: 'json' }) }).j;
		const dzCol = dz.sqliteTable('a', { j: dz.text('j', { mode: 'json' }) }).j;
		expect(d1.getSQLType()).toBe('text');
		expect(d1.getSQLType()).toBe(dzCol.getSQLType());
	});

	it('exposes enum values, defaults and uniqueness', () => {
		expect(users.role.enumValues).toEqual(['admin', 'member']);
		expect(users.role.hasDefault).toBe(true);
		expect(users.role.default).toBe('member');
		expect(users.email.isUnique).toBe(true);
		expect(users.name.hasDefault).toBe(false);
	});

	it('maps values in both directions', () => {
		expect(users.active.mapToDriverValue(true)).toBe(1);
		expect(users.active.mapFromDriverValue(1)).toBe(true);
		expect(users.createdAt.mapToDriverValue(new Date(2000))).toBe(2);
		expect(users.createdAt.mapFromDriverValue(2)).toEqual(new Date(2000));
		expect(users.email.mapFromDriverValue(null)).toBeNull();
	});

	it('links each column back to its table', () => {
		expect(drizzleGetTableName(users.id.table as never)).toBe('users');
	});

	it('keeps the property key when no database name is given', () => {
		const t = sqliteTable('t', { camelCase: text(), named: integer('explicit_name') });
		expect(t.camelCase.name).toBe('camelCase');
		expect(t.camelCase.keyAsName).toBe(true);
		expect(t.named.name).toBe('explicit_name');
		expect(t.named.keyAsName).toBe(false);
	});
});
