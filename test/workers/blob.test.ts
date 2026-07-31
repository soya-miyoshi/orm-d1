/**
 * Blob round trips against real D1.
 *
 * D1 returns a blob as a plain `number[]`, which is the shape that has to
 * survive `decode`. Asserting on the value rather than the row count is the
 * whole point here: the failure mode was silent re-encoding, not an error.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { blob, drizzle, eq, integer, sqliteTable } from '../../src/index.js';

const DB = (env as { DB: D1Database }).DB;

const blobs = sqliteTable('blob_round_trip', {
	id: integer('id').primaryKey(),
	bytes: blob('bytes', { mode: 'buffer' }).notNull(),
	payload: blob('payload', { mode: 'json' }).$type<{ a: number }>(),
	big: blob('big', { mode: 'bigint' }),
});

const db = drizzle(DB);

const bytes = new Uint8Array([0, 0, 0xaa, 0xbb]);

beforeEach(async () => {
	await DB.prepare('drop table if exists "blob_round_trip"').run();
	for (const statement of createSchema([blobs])) await DB.prepare(statement).run();
});

describe('blob columns', () => {
	it('returns the bytes that were written, not their string form', async () => {
		await db.insert(blobs).values({ id: 1, bytes });

		const [row] = await db.select().from(blobs);

		expect(row!.bytes).toBeInstanceOf(Uint8Array);
		expect([...row!.bytes]).toEqual([0, 0, 0xaa, 0xbb]);
		// The old failure: 4 bytes of data read back as 11 bytes of ASCII.
		expect(row!.bytes.byteLength).toBe(4);
	});

	it('stores them as a blob, not as text', async () => {
		await db.insert(blobs).values({ id: 1, bytes });

		const raw = await DB.prepare('select typeof("bytes") as t, hex("bytes") as h from "blob_round_trip"').all();

		expect(raw.results[0]).toEqual({ t: 'blob', h: '0000AABB' });
	});

	it('matches a blob against itself after a round trip', async () => {
		await db.insert(blobs).values({ id: 1, bytes });

		const [row] = await db.select().from(blobs);
		const found = await db.select().from(blobs).where(eq(blobs.bytes, row!.bytes));

		expect(found).toHaveLength(1);
	});

	it('round trips json and bigint modes, which decode through the same path', async () => {
		await db.insert(blobs).values({ id: 1, bytes, payload: { a: 1 }, big: 9007199254740993n });

		const [row] = await db.select().from(blobs);

		expect(row!.payload).toEqual({ a: 1 });
		expect(row!.big).toBe(9007199254740993n);
	});
});

/**
 * A blob **default**, against real SQLite.
 *
 * The unit test asserts the DDL text; this asserts what the database actually
 * stores, which is the claim that matters. The old rendering
 * (`default '222,173,190,239'`) is *accepted* by SQLite — it is a perfectly
 * legal text default on a blob-affinity column — so nothing failed loudly. The
 * row simply came back as a 15-byte ASCII string instead of the 4 bytes the
 * schema declared, and because `snapshotFromSchema` shares `literal()`, every
 * generated artifact agreed with every other one.
 */
describe('blob defaults against D1', () => {
	const defaulted = sqliteTable('blob_default', {
		id: integer('id').primaryKey(),
		payload: blob('payload', { mode: 'buffer' }).notNull().default(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
	});

	beforeEach(async () => {
		await DB.prepare('drop table if exists "blob_default"').run();
		for (const statement of createSchema([defaulted])) await DB.prepare(statement).run();
	});

	it('stores the declared bytes when the column is omitted', async () => {
		await DB.prepare('insert into "blob_default" ("id") values (1)').run();

		const [row] = await drizzle(DB).select().from(defaulted);

		expect(Array.from(row!.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
		// What the old literal produced: the *text* "222,173,190,239", which is
		// 15 bytes rather than 4.
		expect(row!.payload.byteLength).toBe(4);
	});

	it('reports the blob literal back through introspection', async () => {
		const [row] = await DB.prepare(
			`select "dflt_value" as v from pragma_table_info('blob_default') where "name" = 'payload'`,
		).all<{ v: string }>().then((r) => r.results);

		expect(row!.v.toLowerCase()).toBe(`x'deadbeef'`);
	});
});
