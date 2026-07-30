/**
 * F-006: a `customType`'s declared SQL type is preserved verbatim in DDL, and
 * reduced to a SQLite storage-class affinity only where the runtime actually
 * needs one — binding/decoding a value. This is the affinity half, which only
 * a real SQLite can confirm: a declared type of `'int'` has to sort and type
 * as an integer, not as text.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { customType, drizzle, integer, sqliteTable } from '../../src/index.js';

const DB = (env as { DB: D1Database }).DB;

const intType = customType<number>({ dataType: () => 'int' });

const t = sqliteTable('custom_affinity', {
	id: integer('id').primaryKey(),
	n: intType('n'),
});

const db = drizzle(DB);

beforeEach(async () => {
	await DB.prepare('drop table if exists "custom_affinity"').run();
	for (const statement of createSchema([t])) await DB.prepare(statement).run();
});

describe('customType affinity', () => {
	it('sorts and types a declared "int" column as an integer, not text', async () => {
		await db.insert(t).values([{ id: 1, n: 10 }, { id: 2, n: 9 }]);

		const ordered = await db.select({ n: t.n }).from(t).orderBy(t.n);
		expect(ordered.map((r) => r.n)).toEqual([9, 10]);

		const raw = await DB.prepare('select typeof("n") as ty from "custom_affinity" where "n" = 9').all();
		expect(raw.results[0]).toEqual({ ty: 'integer' });
	});
});
