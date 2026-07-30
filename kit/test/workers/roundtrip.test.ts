/**
 * The joint property the two snapshot builders have to satisfy.
 *
 * `snapshotFromSchema` and `snapshotFromIntrospection` describe the same
 * database from opposite directions, and nothing forced them to agree — so
 * they didn't. Building the fixture schema and diffing the introspected result
 * against the schema-derived one produced 18 statements, three of them
 * `drop table`, which meant `check` exited non-zero on a perfectly in-sync
 * database and `push` rebuilt every table on every run.
 *
 * This asserts the property directly: build from the schema, read it back,
 * expect no work to do. It is the one test that covers both builders and the
 * differ's notion of equality at once.
 */
import { env } from 'cloudflare:test';
import { createSchema, tableOptions } from 'd1zzle/ddl';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import { allTables } from '../../../test/schema.js';
import { check, index, integer, primaryKey, sql, sqliteTable, text, uniqueIndex } from 'd1zzle';

/**
 * Declared here rather than in the shared fixture, which misses this by one
 * character: its predicate is `sql\`${t.active} = 1\``, where the `1` is
 * template text and no parameter slot is created. Interpolating the value
 * instead — `${1}` — is what exercised the padding in `renderInline`.
 */
const flags = sqliteTable('flags', {
	id: integer('id').primaryKey(),
	name: text('name').notNull(),
	// `pragma table_info` cannot see these at all, so a schema using one
	// drifted against itself on every check and push. The expression has
	// parentheses on purpose: the CREATE TABLE parser used to stop at the
	// first `)` and miss the `stored` that follows.
	shout: text('shout').generatedAlwaysAs(sql`upper("name")`, { mode: 'stored' }),
	slug: text('slug').generatedAlwaysAs(sql`lower(trim("name"))`, { mode: 'virtual' }),
	active: integer('active').notNull().default(0),
	weight: integer('weight'),
}, (t) => [
	uniqueIndex('flags_active_idx').on(t.name).where(sql`${t.active} = ${1}`),
	check('flags_weight_check', sql`${t.weight} >= ${0}`),
	// An expression index: `pragma index_info` reports this member as
	// `{ cid: -2, name: null }`, and the `CREATE INDEX` text has to be parsed
	// to recover `lower("name")` — see `parseIndexColumns`.
	index('flags_lower_name_idx').on(sql`lower(${t.name})`),
]);

const schemaTables = [...allTables, flags];

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sql: string) => (await DB.prepare(sql).all<T>()).results as T[],
	batch: async (statements) => {
		await DB.batch(statements.map((sql) => DB.prepare(sql)));
	},
};

beforeEach(async () => {
	const existing = await runner.all<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
			+ "and name not like '\\_cf\\_%' escape '\\'",
	);
	for (const table of existing) await DB.prepare(`drop table if exists "${table.name}"`).run();
	for (const statement of createSchema(schemaTables)) await DB.prepare(statement).run();
});

describe('schema ↔ introspection round trip', () => {
	it('reports no drift for a database built from the schema it is compared to', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		// The fixture is deliberately awkward: a column-level `.unique()`, a
		// column-level `.references()`, a table-level `unique('…')` whose name
		// SQLite discards, a composite primary key, a table-level foreign key,
		// a check constraint and a partial unique index.
		expect(diffSnapshots(live, expected).statements).toEqual([]);
	});

	it('is symmetric — neither direction invents work', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		expect(diffSnapshots(expected, live).statements).toEqual([]);
	});

	it('does not report constraint renames across an introspected snapshot', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		// SQLite never returns the declared name, so every constraint would look
		// renamed on `push` and `check` — `"users"` would be reported as renamed
		// from `sqlite_autoindex_users_1` on every run.
		expect(live.origin).toBe('introspection');
		expect(expected.origin).toBe('schema');
		expect(diffSnapshots(live, expected).warnings).toEqual([]);
		expect(diffSnapshots(expected, live).warnings).toEqual([]);
	});
});

/**
 * The same property, for the three things a schema module cannot say.
 *
 * `STRICT`, `WITHOUT ROWID` and the append-only trigger live in a sidecar
 * `tableOptions()` map rather than on `table()`, because none of them has a
 * spelling in `drizzle-orm/sqlite-core` and doc 08 keeps the schema DSL a
 * strict subset of it. That means two *separate* sources have to agree with
 * one live database, so the round trip matters more here than anywhere else:
 * if introspection cannot read an option back, `check` reports drift forever
 * and `push` rebuilds every hardened table on every run.
 */
describe('table options against a real D1 database', () => {
	const ledger = sqliteTable('ledger', {
		id: text('id').primaryKey(),
		amount: integer('amount').notNull(),
	});
	// The composite key is required, not incidental: WITHOUT ROWID needs a
	// primary key, and D1 rejects the CREATE TABLE outright without one.
	const pairs = sqliteTable('pairs', {
		a: text('a').notNull(),
		b: text('b').notNull(),
	}, (t) => [primaryKey({ columns: [t.a, t.b] })]);

	const options = tableOptions([
		[ledger, { strict: true, appendOnly: true }],
		[pairs, { strict: true, withoutRowid: true }],
	]);
	const tables = [ledger, pairs];

	beforeEach(async () => {
		for (const name of ['ledger', 'pairs']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema(tables, {}, options)) await DB.prepare(statement).run();
	});

	it('D1 actually applies the options the generator emits', async () => {
		const rows = await runner.all<{ name: string; sql: string }>(
			"select name, sql from sqlite_master where type = 'table' and name in ('ledger', 'pairs')",
		);
		const byName = new Map(rows.map((r) => [r.name, r.sql.toLowerCase()]));
		expect(byName.get('ledger')).toContain('strict');
		expect(byName.get('pairs')).toContain('without rowid');
	});

	it('enforces STRICT — the point of asking for it', async () => {
		await expect(
			DB.prepare(`insert into "ledger" ("id", "amount") values ('a', 'not-an-integer')`).run(),
		).rejects.toThrow();
	});

	it('enforces the append-only guard on UPDATE but still allows DELETE', async () => {
		await DB.prepare(`insert into "ledger" ("id", "amount") values ('a', 1)`).run();

		await expect(DB.prepare(`update "ledger" set "amount" = 2 where "id" = 'a'`).run()).rejects.toThrow();

		// DELETE stays allowed on purpose: what append-only protects is that a
		// recorded fact is never rewritten, not that rows live forever.
		await DB.prepare(`delete from "ledger" where "id" = 'a'`).run();
		const left = await runner.all<{ n: number }>('select count(*) as n from "ledger"');
		expect(left[0]!.n).toBe(0);
	});

	it('reports no drift in either direction', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(tables, '', options);

		// Only the two tables this block owns — the fixture schema from the
		// outer beforeEach is gone by now, so compare like with like.
		const only = (s: typeof live) => ({
			...s,
			tables: Object.fromEntries(Object.entries(s.tables).filter(([n]) => n === 'ledger' || n === 'pairs')),
		});

		expect(diffSnapshots(only(live), only(expected)).statements).toEqual([]);
		expect(diffSnapshots(only(expected), only(live)).statements).toEqual([]);
	});

	it('reads all three options back out of the live database', async () => {
		const live = await introspect(runner);
		expect(live.tables.ledger).toMatchObject({ strict: true, withoutRowid: false, appendOnly: true });
		expect(live.tables.pairs).toMatchObject({ strict: true, withoutRowid: true, appendOnly: false });
	});
});

describe('an expression unique index actually indexes the expression', () => {
	beforeEach(async () => {
		await DB.prepare('drop table if exists "expr_unique"').run();
		for (
			const statement of createSchema([
				sqliteTable('expr_unique', {
					id: integer('id').primaryKey(),
					name: text('name').notNull(),
				}, (t) => [uniqueIndex('expr_unique_lower_name_idx').on(sql`lower(${t.name})`)]),
			])
		) {
			await DB.prepare(statement).run();
		}
	});

	it('lets two rows with distinct expression values both insert', async () => {
		// If `columns` were quoted unconditionally (the bug this guards
		// against), the unique index would bind to the constant string
		// `"lower(""name"")"` instead of the expression, so *every* row would
		// collide on the same value and only one insert in the whole table
		// would ever succeed.
		await DB.prepare(`insert into "expr_unique" ("id", "name") values (1, 'Alice')`).run();
		await DB.prepare(`insert into "expr_unique" ("id", "name") values (2, 'Bob')`).run();

		const rows = await runner.all<{ n: number }>('select count(*) as n from "expr_unique"');
		expect(rows[0]!.n).toBe(2);
	});

	it('still enforces uniqueness on the expression itself', async () => {
		await DB.prepare(`insert into "expr_unique" ("id", "name") values (1, 'Alice')`).run();
		await expect(
			DB.prepare(`insert into "expr_unique" ("id", "name") values (2, 'ALICE')`).run(),
		).rejects.toThrow();
	});
});
