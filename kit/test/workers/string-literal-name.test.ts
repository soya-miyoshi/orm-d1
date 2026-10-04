/**
 * [F-126] A `'…'`-quoted column name in a UNIQUE constraint member was
 * unmatchable after `blankLiterals` erased the literal's contents.
 *
 * [F-127] The same hole in the PK clause: `primary key ('a' autoincrement)`
 * — the blanked name never matched the real column, so `autoincrement` was
 * silently dropped.
 *
 * Both are exercised here against a real D1 to confirm SQLite actually
 * accepts the spelling and the introspection round-trips correctly.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { createTableFromSnapshot } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sqlText: string) => (await DB.prepare(sqlText).all<T>()).results as T[],
	batch: async (statements) => {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

describe('[F-126] unique constraint with a string-literal member name', () => {
	const TABLE = 'f126_uniq_lit_t';

	beforeEach(async () => {
		await DB.prepare(`drop table if exists "${TABLE}"`).run();
		await DB.prepare(
			`create table "${TABLE}" ("id" integer primary key, "email" text not null, `
				+ `unique ('email' collate nocase))`,
		).run();
		await DB.prepare(`insert into "${TABLE}" ("id", "email") values (1, 'x@example.com')`).run();
	});

	it('introspects the member name and collation correctly', async () => {
		const snapshot = await introspect(runner);
		const uc = Object.values(snapshot.tables[TABLE]?.uniqueConstraints ?? {})[0];
		expect(uc?.columns).toEqual([{ name: 'email', collate: 'nocase' }]);
	});

	it('round-trips: the rebuilt table still enforces NOCASE uniqueness', async () => {
		const snapshot = await introspect(runner);
		const table = snapshot.tables[TABLE]!;
		const rebuiltName = `${TABLE}_rebuilt`;
		await DB.prepare(`drop table if exists "${rebuiltName}"`).run();
		const ddl = createTableFromSnapshot({ ...table, name: rebuiltName });
		await DB.prepare(ddl).run();
		await DB.prepare(`insert into "${rebuiltName}" ("id", "email") values (1, 'x@example.com')`).run();
		await expect(
			DB.prepare(`insert into "${rebuiltName}" ("id", "email") values (2, 'X@EXAMPLE.COM')`).run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});
});

describe('[F-127] primary key clause with a string-literal member name and autoincrement', () => {
	const TABLE = 'f127_pk_lit_t';

	beforeEach(async () => {
		await DB.prepare(`drop table if exists "${TABLE}"`).run();
		await DB.prepare(
			`create table "${TABLE}" ("a" integer, "v" text, primary key ('a' autoincrement))`,
		).run();
	});

	it('introspects autoincrement correctly', async () => {
		const snapshot = await introspect(runner);
		const col = snapshot.tables[TABLE]?.columns['a'];
		expect(col?.autoincrement).toBe(true);
	});

	it('round-trips: the rebuilt table still has autoincrement', async () => {
		const snapshot = await introspect(runner);
		const table = snapshot.tables[TABLE]!;
		const rebuiltName = `${TABLE}_rebuilt`;
		await DB.prepare(`drop table if exists "${rebuiltName}"`).run();
		const ddl = createTableFromSnapshot({ ...table, name: rebuiltName });
		await DB.prepare(ddl).run();
		// AUTOINCREMENT prevents reuse of rowids — inserting then deleting,
		// then inserting again must yield a *higher* rowid, not the recycled one.
		await DB.prepare(`insert into "${rebuiltName}" ("v") values ('x')`).run();
		const first = await runner.all<{ a: number }>(`select "a" from "${rebuiltName}"`);
		await DB.prepare(`delete from "${rebuiltName}"`).run();
		await DB.prepare(`insert into "${rebuiltName}" ("v") values ('y')`).run();
		const second = await runner.all<{ a: number }>(`select "a" from "${rebuiltName}"`);
		expect(second[0]!.a).toBeGreaterThan(first[0]!.a);
	});
});
