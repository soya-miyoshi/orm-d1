import { and as dAnd, eq as dEq, gt as dGt, inArray as dInArray, notInArray as dNotInArray, sql as dSql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { asDrizzleTable } from '../../src/drizzle.js';
import { createIndexes, createSchema, createTable, dropTable, literal } from '../../src/ddl.js';
import { blob, check, customType, integer, numeric, real, sql, sqliteTable, text, uniqueIndex } from '../../src/index.js';
import { inArray, notInArray } from '../../src/sql/expressions.js';
import type { SQLChunk } from '../../src/sql/sql.js';
import { allTables, postTags, posts, users } from '../schema.js';

describe('ddl generation', () => {
	it('creates a table with inline constraints', () => {
		expect(createTable(users)).toBe(
			'create table "users" (\n'
				+ '\t"id" integer primary key autoincrement not null,\n'
				+ '\t"email" text not null unique,\n'
				+ '\t"name" text,\n'
				+ '\t"role" text not null default \'member\',\n'
				+ '\t"active" integer not null default 1,\n'
				+ '\t"settings" text,\n'
				+ '\t"score" real,\n'
				+ '\t"created_at" integer not null,\n'
				+ '\t"updated_at" integer,\n'
				+ '\tconstraint "users_score_check" check ("score" >= 0)\n'
				+ ')',
		);
	});

	it('renders text(name, { length }) as bare "text", never a decorated spelling', () => {
		// `[F-012]` in `AUDIT.md`: an earlier version of this rendered
		// `text(5)` here to match drizzle-kit's type string, but real SQLite's
		// STRICT mode rejects any decorated type name ("unknown datatype") —
		// `TEXT(5)` is no more acceptable than `NUMERIC`. That would have made
		// `createSchema` emit DDL D1 refuses to run for a STRICT table with a
		// `text({length})` column, so it was reverted. `length`/`isLengthExact`
		// stay readable on the column (Drizzle-compat getters) — they're just
		// not folded into the DDL.
		const t = sqliteTable('t', { n: text('n', { length: 5 }) });
		expect(createTable(t)).toContain('"n" text');
		expect(createTable(t)).not.toContain('text(');
	});

	it('leaves plain text() with no length as bare "text"', () => {
		const t = sqliteTable('t', { n: text('n') });
		expect(createTable(t)).toContain('"n" text');
		expect(createTable(t)).not.toContain('text(');
	});

	it('emits a column-level foreign key with its actions', () => {
		expect(createTable(posts)).toContain(
			'"author_id" integer not null references "users"("id") on delete cascade',
		);
	});

	it('emits composite primary keys, table-level FKs and uniques', () => {
		const ddl = createTable(postTags);
		expect(ddl).toContain('constraint "post_tags_pk" primary key ("post_id", "tag")');
		expect(ddl).toContain(
			'constraint "post_tags_post_id_fk" foreign key ("post_id") references "posts"("id") on delete cascade',
		);
		expect(ddl).toContain('constraint "post_tags_tag_unique" unique ("tag")');
		// A composite primary key must not also be declared inline.
		expect(ddl).not.toContain('"post_id" integer not null primary key');
	});

	it('never qualifies column names inside checks or index predicates', () => {
		expect(createTable(users)).not.toContain('"users"."score"');
		expect(createIndexes(users)[1]).toBe(
			'create unique index "users_email_active_idx" on "users" ("email", "active") where "active" = 1',
		);
	});

	it('inlines an interpolated value without padding it', () => {
		// The token stands where a `?` would, so the literal replaces it exactly.
		// Padding it produced `"active" =  1 ` — which introspection reads back
		// trimmed and single-spaced, so the index drifted against itself forever.
		const t = sqliteTable('t', {
			active: integer('active').notNull(),
			score: real('score'),
		}, (c) => [
			uniqueIndex('t_active_idx').on(c.active).where(sql`${c.active} = ${1}`),
			check('t_score_check', sql`${c.score} >= ${0}`),
		]);

		expect(createIndexes(t)[0]).toBe(
			'create unique index "t_active_idx" on "t" ("active") where "active" = 1',
		);
		expect(createTable(t)).toContain('check ("score" >= 0)');
	});

	it('elides an interpolated undefined instead of binding/inlining it as null', () => {
		const t = sqliteTable('t', {
			score: real('score'),
		}, (c) => [
			check('t_score_check', sql`${c.score} >= ${undefined}`),
		]);

		const ddl = createTable(t);
		expect(ddl).not.toContain('>= null');
		expect(ddl).toContain('check ("score" >= )');
	});

	it('expands an interpolated array into a parenthesized list in a check', () => {
		const t = sqliteTable('t', {
			role: text('role'),
		}, (c) => [
			check('t_role_check', sql`${c.role} in ${['admin', 'member']}`),
		]);

		expect(createTable(t)).toContain('check ("role" in (\'admin\', \'member\'))');
	});

	it('elides an undefined element inside an interpolated array check instead of inlining null', () => {
		// A missing constant must not silently produce `in (..., null, ...)` —
		// `x in (..., null)` is NULL (neither true nor false) for any x not in the
		// list, so the CHECK passes on exactly the rows it was meant to reject.
		const ROLES = ['admin', undefined as unknown as string, 'member'];
		const t = sqliteTable('t', {
			role: text('role').notNull(),
		}, (c) => [
			check('t_role_check', sql`${c.role} in ${ROLES}`),
		]);

		const ddl = createTable(t);
		expect(ddl).toContain('check ("role" in (\'admin\', , \'member\'))');
	});

	// [F-087]: an empty interpolated array in a DDL predicate renders `()`,
	// which SQLite accepts — `not in ()` is unconditionally true, `in ()` is
	// unconditionally false, so the constraint goes permanently inert with no
	// error. Matching `drizzle-orm`'s own `()` rendering is correct (the
	// `docs/04` reverse-alias invariant), so `createTable` refuses outright
	// rather than silently emitting an inert constraint — DDL generation runs
	// in Node (via `orm-d1-kit`), so it is free to throw.
	it('refuses to generate DDL for a check built from an empty interpolated array', () => {
		const ROLES: string[] = [];
		const t = sqliteTable('t', {
			role: text('role'),
		}, (c) => [
			check('t_role_check', sql`${c.role} not in ${ROLES}`),
		]);

		expect(() => createTable(t)).toThrow(/empty array/);
	});

	it('does not refuse a non-empty interpolated array in a check', () => {
		const t = sqliteTable('t', {
			role: text('role'),
		}, (c) => [
			check('t_role_check', sql`${c.role} in ${['admin', 'member']}`),
		]);

		expect(() => createTable(t)).not.toThrow();
	});

	// The `RenderContext` hook that throws has no access to which table or
	// constraint it is rendering for — the raw error was anonymous. The DDL
	// call sites (`checkDDL`, `createIndex`, `columnDDL`) all have that
	// context, so it is attached on the way back out.
	it('names the table and constraint in the empty-array refusal', () => {
		const ROLES: string[] = [];
		const t = sqliteTable('t', {
			role: text('role'),
		}, (c) => [
			check('t_role_check', sql`${c.role} not in ${ROLES}`),
		]);

		expect(() => createTable(t)).toThrow(/table "t"/);
		expect(() => createTable(t)).toThrow(/constraint "t_role_check"/);
	});

	it('also refuses a check built with a Drizzle sql fragment interpolating an empty array', () => {
		// Closes the gap `fromDrizzleSQL` left: a check() written with
		// Drizzle's own `sql` tag rendered `not in ()` silently because
		// `ctx.onEmptyArrayPredicate` was only ever consulted from orm-d1's
		// own template tag.
		const roles: string[] = [];
		const t = sqliteTable('t', { role: text('role') });
		const dRole = asDrizzleTable(t).role;
		const withCheck = sqliteTable('t', {
			role: text('role'),
		}, () => [
			check('t_role_check', dSql`${dRole} not in ${roles}` as unknown as SQLChunk),
		]);

		expect(() => createTable(withCheck)).toThrow(/empty array/);
	});

	// [F-1] orm-d1's own `inArray()`/`notInArray()` (src/sql/expressions.ts)
	// short-circuit an empty array to a bare `'1 = 1'`/`'1 = 0'` string for
	// query correctness/performance — but that short-circuit used to bypass
	// the DDL empty-array refusal entirely, since it never went through
	// `sql.ts`'s own array-interpolation path that `ctx.onEmptyArrayPredicate`
	// hooks into. A `check()`/partial-index `where()` built with `inArray`/
	// `notInArray` over an empty array therefore rendered a permanently
	// true/false constraint with no error, the exact hazard [F-087] closed for
	// a hand-written `sql` template and for Drizzle's own fragments.
	it('refuses a check built with notInArray() over an empty array', () => {
		const t = sqliteTable('t1', {
			role: text('role'),
		}, (c) => [
			check('t1_role_check', notInArray(c.role, [])),
		]);

		expect(() => createTable(t)).toThrow(/empty array/);
		expect(() => createTable(t)).toThrow(/table "t1"/);
		expect(() => createTable(t)).toThrow(/constraint "t1_role_check"/);
	});

	it('refuses a partial index built with inArray() over an empty array', () => {
		const t = sqliteTable('t2', {
			role: text('role'),
		}, (c) => [
			uniqueIndex('t2_role_idx').on(c.role).where(inArray(c.role, [])),
		]);

		expect(() => createIndexes(t)).toThrow(/empty array/);
	});

	it('does not refuse inArray()/notInArray() with a non-empty array in a check', () => {
		const t = sqliteTable('t3', {
			role: text('role'),
		}, (c) => [
			check('t3_role_check', notInArray(c.role, ['admin', 'member'])),
		]);

		expect(() => createTable(t)).not.toThrow();
	});

	// Drizzle's own `inArray`/`notInArray` (as opposed to orm-d1's) short-circuit
	// an empty array *before* building any array chunk at all —
	// `drizzle-orm/sql/expressions/conditions.js` returns `sql\`false\`` /
	// `sql\`true\`` outright. That is a whole fragment whose `queryChunks` is one
	// bare `StringChunk`, a shape distinct from — and, before this fix, invisible
	// to — the bare-`[]` scan that already caught a hand-written `sql` template
	// and orm-d1's own `InArray`. Verified for both the bare form and nested
	// inside `and()`/`eq()`, since `and()` wraps the collapsed fragment as a
	// nested `SQL` rather than flattening it.
	it('refuses a check built with Drizzle\'s own inArray() over an empty array', () => {
		const t = sqliteTable('t4', { role: text('role') });
		const dRole = asDrizzleTable(t).role;
		const withCheck = sqliteTable('t4', {
			role: text('role'),
		}, () => [
			check('t4_role_check', dInArray(dRole, []) as unknown as SQLChunk),
		]);

		expect(() => createTable(withCheck)).toThrow(/empty array/);
	});

	it('refuses a check built with Drizzle\'s own notInArray() over an empty array', () => {
		const t = sqliteTable('t5', { role: text('role') });
		const dRole = asDrizzleTable(t).role;
		const withCheck = sqliteTable('t5', {
			role: text('role'),
		}, () => [
			check('t5_role_check', dNotInArray(dRole, []) as unknown as SQLChunk),
		]);

		expect(() => createTable(withCheck)).toThrow(/empty array/);
	});

	it('refuses Drizzle\'s own inArray() over an empty array nested inside and()/eq()', () => {
		const t = sqliteTable('t6', { id: integer('id'), role: text('role') });
		const dt = asDrizzleTable(t);
		const withCheck = sqliteTable('t6', {
			id: integer('id'),
			role: text('role'),
		}, () => [
			check('t6_role_check', dAnd(dEq(dt.id, 1), dInArray(dt.role, [])) as unknown as SQLChunk),
		]);

		expect(() => createTable(withCheck)).toThrow(/empty array/);
	});

	it('refuses a partial index built with Drizzle\'s own notInArray() over an empty array', () => {
		const bare = sqliteTable('t7', { role: text('role') });
		const dRole = asDrizzleTable(bare).role;
		const t7 = sqliteTable('t7', {
			role: text('role'),
		}, (c) => [
			uniqueIndex('t7_role_idx').on(c.role).where(dNotInArray(dRole, []) as unknown as SQLChunk),
		]);

		expect(() => createIndexes(t7)).toThrow(/empty array/);
	});

	// Regression: `isBareBooleanFragment` is only meaningful for a predicate
	// (`check()`/partial-index `where()`) — it must NOT be consulted from
	// `ddlContext`, which every `renderInline` call shares, including
	// `defaultClause` and the generated-column expression in `columnDDL`. A
	// Drizzle-tagged `default(sql\`true\`)` collapses to the exact same
	// one-`StringChunk` shape as Drizzle's own `inArray([])`/`notInArray([])`
	// short-circuit, but it is an ordinary, meaningful default — not an
	// empty-array predicate — and must render, not throw.
	it('does not refuse a Drizzle-tagged default(sql`true`)', () => {
		const t = sqliteTable('members', {
			active: integer('active', { mode: 'boolean' }).notNull().default(dSql`true` as unknown as SQLChunk),
		});

		let ddl = '';
		expect(() => (ddl = createTable(t))).not.toThrow();
		expect(ddl).toContain('"active" integer not null default true');
	});

	it('does not refuse a Drizzle-tagged generatedAlwaysAs(sql`true`)', () => {
		const t = sqliteTable('t11', {
			flag: integer('flag', { mode: 'boolean' }).generatedAlwaysAs(dSql`true` as unknown as SQLChunk),
		});

		let ddl = '';
		expect(() => (ddl = createTable(t))).not.toThrow();
		expect(ddl).toContain('generated always as (true)');
	});

	// The predicate positions must still refuse a bare `sql\`true\`` — this is
	// the accepted false positive the long comment on `isBareBooleanFragment`
	// documents: structurally indistinguishable from Drizzle's own
	// `inArray([])`/`notInArray([])` collapse, and a `check` that is
	// unconditionally satisfied has no reason to exist.
	it('still refuses a check() built directly with Drizzle\'s sql`true`', () => {
		const t = sqliteTable('t12', {
			role: text('role'),
		}, () => [
			check('t12_always_check', dSql`true` as unknown as SQLChunk),
		]);

		expect(() => createTable(t)).toThrow(/empty array/);
	});

	// DDL binds nothing — every value is inlined as a literal (`renderInline`)
	// — so the real D1 bound-parameter limits (`jsonEachThreshold: 30`,
	// `maxParams: 100`) do not apply here. Left at their query-path defaults, a
	// `check()`/partial-index built from a long `inArray()` would either
	// render a `json_each(...)` subquery — which D1 rejects outright inside a
	// CHECK constraint — or throw the bound-parameter `CompileError` even
	// though nothing is bound.
	it('renders inArray() with >= 30 values in a check as a literal list, not json_each', () => {
		const roles = Array.from({ length: 30 }, (_, i) => `role${i}`);
		const t = sqliteTable('t8', {
			role: text('role'),
		}, (c) => [
			check('t8_role_check', inArray(c.role, roles)),
		]);

		const ddl = createTable(t);
		expect(ddl).not.toContain('json_each');
		expect(ddl).toContain(`in ('role0', 'role1'`);
	});

	it('renders inArray() with > 100 values in a check without throwing, as a literal list', () => {
		const roles = Array.from({ length: 150 }, (_, i) => `role${i}`);
		const t = sqliteTable('t9', {
			role: text('role'),
		}, (c) => [
			check('t9_role_check', inArray(c.role, roles)),
		]);

		let ddl = '';
		expect(() => (ddl = createTable(t))).not.toThrow();
		expect(ddl).not.toContain('json_each');
		expect(ddl).toContain(`in ('role0', 'role1'`);
		expect(ddl).toContain(`'role149'`);
	});

	it('renders inArray() with >= 30 values in a partial index where as a literal list, not json_each', () => {
		const roles = Array.from({ length: 30 }, (_, i) => `role${i}`);
		const t = sqliteTable('t10', {
			role: text('role'),
		}, (c) => [
			uniqueIndex('t10_role_idx').on(c.role).where(inArray(c.role, roles)),
		]);

		const [ddl] = createIndexes(t);
		expect(ddl).not.toContain('json_each');
		expect(ddl).toContain(`in ('role0', 'role1'`);
	});

	it('renders sql defaults inline and value defaults as literals', () => {
		const t = sqliteTable('t', {
			at: integer('at').notNull().default(sql`(unixepoch())`),
			label: text('label').default("o'clock"),
			ratio: real('ratio').default(0.5),
			amount: numeric('amount').default('1.00'),
			payload: blob('payload', { mode: 'json' }).default({ a: 1 }),
		});

		expect(createTable(t)).toBe(
			'create table "t" (\n'
				+ '\t"at" integer not null default (unixepoch()),\n'
				+ '\t"label" text default \'o\'\'clock\',\n'
				+ '\t"ratio" real default 0.5,\n'
				+ '\t"amount" numeric default \'1.00\',\n'
				+ '\t"payload" blob default \'{"a":1}\'\n'
				+ ')',
		);
	});

	it('parenthesises a bare expression default, and leaves a literal alone', () => {
		// `create table … default unixepoch()` is a syntax error, and the bare
		// spelling is exactly what `pragma table_info` reports — so it reaches
		// a schema module by way of `pull` and has to be normalised on emission.
		const t = sqliteTable('t', {
			made: integer('made').default(sql`unixepoch()`),
			seen: numeric('seen').default(sql`CURRENT_TIMESTAMP`),
			note: text('note').default(sql`'hi'`),
			rank: integer('rank').default(sql`-1`),
		});

		const ddl = createTable(t);
		expect(ddl).toContain('"made" integer default (unixepoch())');
		expect(ddl).toContain('"seen" numeric default CURRENT_TIMESTAMP');
		expect(ddl).toContain(`"note" text default 'hi'`);
		expect(ddl).toContain('"rank" integer default -1');
	});

	it('supports if-not-exists and strict', () => {
		expect(createTable(posts, { ifNotExists: true, strict: true }))
			.toMatch(/^create table if not exists "posts" \(/);
		expect(createTable(posts, { strict: true })).toMatch(/\) strict$/);
		expect(dropTable(posts, { ifNotExists: true })).toBe('drop table if exists "posts"');
	});

	it('orders a whole schema: tables first, then indexes', () => {
		const statements = createSchema(allTables);
		expect(statements).toHaveLength(6);
		expect(statements.slice(0, 3).every((s) => s.startsWith('create table'))).toBe(true);
		expect(statements.slice(3).every((s) => s.includes('index'))).toBe(true);
	});

	it('derives an index name when none is given', () => {
		const t = sqliteTable('t', { a: integer('a') }, (c) => [
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			indexOn(c.a),
		]);
		expect(createIndexes(t)[0]).toContain('"t_a_index"');
	});
});

// Declared here rather than in the fixture: an unnamed index is unusual enough
// that it belongs next to the test that cares about it.
import { index } from '../../src/index.js';
import type { Column } from '../../src/index.js';
const indexOn = (column: Column<any>) => index().on(column);

describe('customType', () => {
	it('passes each column its own config to dataType', () => {
		// `dataType()` used to be called once, eagerly, with no argument — so a
		// dataType reading `config.length` threw at module scope, on import.
		const varchar = customType<string, string, { length: number }>({
			dataType: (config) => `text(${config!.length})`,
		});

		const t = sqliteTable('t', { short: varchar('short', { length: 10 }) });
		// An equality-shaped assertion, not `toContain('"short" text')` — that
		// substring is also a prefix of `"short" text(10)`, so it would keep
		// passing silently if `createTable` ever started folding the length in
		// (see the `[F-012]`/`[F-023]` history of this exact column type).
		expect(createTable(t)).toContain('"short" text(10)');
	});

	it('preserves the declared type verbatim, instead of guessing one of the five storage classes', () => {
		// Old behaviour: only whichever of integer|text|real|blob|numeric the
		// declared string happened to contain as a substring survived, so 'int'
		// rendered as a bare 'text' guess-miss and 'varchar(10)' lost its length.
		const intType = customType({ dataType: () => 'int' });
		const t1 = sqliteTable('t', { n: intType('n') });
		expect(createTable(t1)).toContain('"n" int');
		expect(createTable(t1)).not.toContain('"n" text');
		expect(t1.n.getSQLType()).toBe('int');

		const varchar = customType<string, string, { length: number }>({
			dataType: (config) => `varchar(${config!.length})`,
		});
		const t2 = sqliteTable('t', { name: varchar('name', { length: 10 }) });
		expect(createTable(t2)).toContain('varchar(10)');
	});

	it('does not treat a customType declared "int" as the INTEGER PRIMARY KEY rowid alias', () => {
		// `hasDefault` on `primaryKey()` means "optional on insert" — true for
		// SQLite's actual `INTEGER PRIMARY KEY` rowid alias. A customType whose
		// declared spelling is `int` has affinity `integer` (same as a plain
		// `integer()` column) but the DDL emits the literal `int primary key`,
		// not `integer primary key`, which SQLite does *not* treat as the rowid
		// alias — so the column stays required on insert.
		const intType = customType({ dataType: () => 'int' });
		const t = sqliteTable('t', { id: intType('id').primaryKey() });
		expect(t.id.hasDefault).toBe(false);

		const plain = sqliteTable('t2', { id: integer('id').primaryKey() });
		expect(plain.id.hasDefault).toBe(true);
	});

	it('applies toDriver and fromDriver as the column encoder and decoder', () => {
		const upper = customType<string, string>({
			dataType: () => 'text',
			toDriver: (value) => value.toUpperCase(),
			fromDriver: (value) => value.toLowerCase(),
		});

		const t = sqliteTable('t', { tag: upper('tag').default('abc') });
		expect(createTable(t)).toContain(`"tag" text default 'ABC'`);
	});
});

/**
 * A blob default has to reach the DDL as `x'…'`.
 *
 * `literal()` fell through to `'${String(value)}'` for anything it did not
 * recognise, and `String(new Uint8Array([0xde, 0xad]))` is `"222,173"` — so
 * `blob().default(bytes)` emitted a *text* literal into `create table`. What
 * makes this bug class #1 rather than a cosmetic slip is that
 * `snapshotFromSchema` calls the same `literal()`: the snapshot recorded the
 * same wrong text, the database was built from the same wrong DDL, and
 * introspection read it back equal. Every artifact agreed with every other and
 * `check`/`verify` stayed green over a permanently corrupt default.
 */
describe('blob defaults', () => {
	it('renders raw bytes as a SQLite blob literal', () => {
		const t = sqliteTable('t', {
			id: integer('id').primaryKey(),
			payload: blob('payload', { mode: 'buffer' }).default(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
		});

		expect(createTable(t)).toContain(`"payload" blob default x'deadbeef'`);
		// The precise old output, asserted so a regression cannot pass by
		// merely being "some string".
		expect(createTable(t)).not.toContain(`'222,173,190,239'`);
	});

	it('zero-pads each byte, so a leading nibble is never dropped', () => {
		// `0x0a.toString(16)` is `'a'`; unpadded, four bytes would render as
		// three hex digits and SQLite would reject the literal outright.
		const t = sqliteTable('t', {
			payload: blob('payload', { mode: 'buffer' }).default(new Uint8Array([0x00, 0x0a, 0xff, 0x01])),
		});
		expect(createTable(t)).toContain(`x'000aff01'`);
	});

	it('hexes the byte range of a view, not its elements', () => {
		// A view onto a slice of a larger buffer: anything reading `.buffer`
		// whole, or iterating elements of a wider typed array, gets this wrong.
		const buffer = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]).buffer;
		const t = sqliteTable('t', {
			payload: blob('payload', { mode: 'buffer' }).default(new Uint8Array(buffer, 1, 3)),
		});
		expect(createTable(t)).toContain(`x'223344'`);
	});

	/**
	 * `.default()` on a buffer blob is typed to `Uint8Array`, so an
	 * `ArrayBuffer` cannot arrive that way. It still reaches `literal()`
	 * through an interpolated `sql` fragment — `D1Param` admits it, and
	 * `renderInline` inlines whatever a check or a partial-index predicate
	 * bound — which is the path this covers.
	 */
	it('renders an ArrayBuffer reached through an interpolated fragment', () => {
		expect(literal(new Uint8Array([0xca, 0xfe]).buffer)).toBe(`x'cafe'`);

		const t = sqliteTable('t', {
			payload: blob('payload', { mode: 'buffer' }),
		}, (table) => [check('payload_check', sql`${table.payload} <> ${new Uint8Array([0x00, 0xff])}`)]);

		expect(createTable(t)).toContain(`check ("payload" <> x'00ff')`);
	});

	// [F-067]: a Drizzle fragment inside DDL ignored `ctx.bareColumns`, so
	// `check('c', drizzleSql\`${col} > 0\`)` rendered a table-qualified column.
	// A table-qualified column is actually fine inside a CHECK constraint on
	// D1 — the restriction SQLite enforces is narrower, and applies only to a
	// *generated* column's expression (`the "." operator prohibited in
	// generated columns`). This assertion is kept because bare-columns
	// rendering is still the intended, more natural spelling for `check`/
	// `where` — not because the qualified form would otherwise fail.
	it('renders a Drizzle fragment in a check constraint with a bare column, not table-qualified', () => {
		const t = sqliteTable('t', {
			score: integer('score'),
		});
		const dt = asDrizzleTable(t);
		const withCheck = sqliteTable('t', {
			score: integer('score'),
		}, () => [check('t_score_check', dGt(dt.score, 0) as unknown as SQLChunk)]);

		const ddl = createTable(withCheck);
		expect(ddl).toContain('check ("score" > 0)');
		expect(ddl).not.toContain('"t"."score"');
	});
});
