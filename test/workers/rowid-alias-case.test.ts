/**
 * F-022: SQLite's rowid-alias matching is case-insensitive for the type
 * keyword `INTEGER` itself — `INTEGER PRIMARY KEY` and `integer primary key`
 * (any case, any surrounding whitespace) are the same rowid alias. This is
 * narrower than "any case of any abbreviation": SQLite requires the declared
 * type to be exactly the word `INTEGER` (case-insensitively) — `INT PRIMARY
 * KEY`, `int primary key`, and other abbreviations are NOT recognized as the
 * rowid alias, and such a column stores an ordinary (possibly NULL) value
 * rather than aliasing the rowid. `Column.config.hasDefault` used to compare
 * with a case-sensitive `=== 'integer'`, so a `customType` declaring the type
 * as `'INTEGER'` (uppercase) was reported as *not* defaultable even though
 * real SQLite auto-assigns it on insert. The fix is `.toLowerCase() ===
 * 'integer'` — case-insensitive equality against the exact word `integer`,
 * never a prefix/abbreviation match — so a future reader must not "fix" this
 * to also accept `int`: that would report a column as defaultable when
 * SQLite does not treat it as the rowid alias, and `db.insert()` omitting a
 * value for it would get NULL instead of an auto-assigned id. This is
 * exactly the shape only a real D1 can confirm — the defect is entirely
 * about what SQLite itself accepts.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { customType, drizzle, sqliteTable, text } from '../../src/index.js';

const DB = (env as { DB: D1Database }).DB;

const upperInt = customType<number>({ dataType: () => 'INTEGER' });

const t = sqliteTable('rowid_alias_case', {
	id: upperInt('id').primaryKey(),
	name: text('name'),
});

const db = drizzle(DB);

beforeEach(async () => {
	await DB.prepare('drop table if exists "rowid_alias_case"').run();
	for (const statement of createSchema([t])) await DB.prepare(statement).run();
});

describe('rowid-alias detection is case-insensitive, matching real SQLite', () => {
	it('reports an "INTEGER"-declared primary key as defaultable', () => {
		expect(t.id.config.hasDefault).toBe(true);
	});

	it('lets SQLite auto-assign the id on insert, with no id supplied', async () => {
		// A raw D1 insert, not the typed `db.insert(t)` builder: the *type*-level
		// half of "is this column defaultable" is a separate, broader gap
		// (`[F-020]`'s customType-primary-key hole, still open) that this
		// finding does not touch — only the runtime `hasDefault` value above.
		// This proves what real SQLite does when the column is omitted, which
		// is the behaviour `[F-022]` is actually about.
		await DB.prepare('insert into "rowid_alias_case" ("name") values (?)').bind('x').run();
		const rows = await db.select().from(t);
		expect(rows).toHaveLength(1);
		expect(typeof rows[0]!.id).toBe('number');
	});
});
