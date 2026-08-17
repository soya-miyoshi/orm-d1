/**
 * `backfill` against a real D1.
 *
 * The property worth testing is not "the UPDATE lands" — it is what the table
 * looks like when the UPDATE *does not*. D1's `batch()` is one transaction, so
 * a failing statement has to take the drop back out with it and leave the
 * guard standing. Asserting that against a Node SQLite would be asserting
 * against different transaction semantics than the ones this runs on.
 */
import { env } from 'cloudflare:test';
import { appendOnlyTrigger, createSchema, tableOptions } from 'orm-d1/ddl';
import { integer, sqliteTable, text } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfill } from '../../src/core/backfill.js';
import type { SqlRunner } from '../../src/core/apply.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sql: string) => (await DB.prepare(sql).all<T>()).results,
	batch: async (statements) => {
		await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

// `amount` is the recorded fact; `fee` arrives later, from the processor.
const charges = sqliteTable('bf_charges', {
	id: text('id').primaryKey(),
	amount: integer('amount').notNull(),
	fee: integer('fee'),
});
// Whole-table guard, to show the two shapes behave the same.
const ledger = sqliteTable('bf_ledger', {
	id: text('id').primaryKey(),
	amount: integer('amount').notNull(),
});
const plain = sqliteTable('bf_plain', {
	id: text('id').primaryKey(),
	note: text('note'),
});

const options = tableOptions([
	[charges, { strict: true, appendOnly: ['amount'] }],
	[ledger, { strict: true, appendOnly: true }],
	[plain, { strict: true }],
]);

const triggersOn = async (table: string): Promise<string[]> => {
	const rows = await runner.all<{ sql: string }>(
		`select sql from sqlite_master where type = 'trigger' and tbl_name = '${table}'`,
	);
	return rows.map((r) => r.sql);
};

beforeEach(async () => {
	for (const name of ['bf_charges', 'bf_ledger', 'bf_plain']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema([charges, ledger, plain], {}, options)) {
		await DB.prepare(statement).run();
	}
	await DB.prepare(`insert into "bf_charges" ("id", "amount") values ('a', 1000)`).run();
	await DB.prepare(`insert into "bf_ledger" ("id", "amount") values ('a', 1000)`).run();
});

describe('backfill on real D1', () => {
	it('writes a guarded column and puts the guard back', async () => {
		const result = await backfill(runner, {
			tables: ['bf_ledger'],
			statements: [`update "bf_ledger" set "amount" = 2000 where "id" = 'a'`],
		});

		expect(result.suspended).toEqual({ bf_ledger: true });
		const [row] = await runner.all<{ amount: number }>(`select "amount" from "bf_ledger"`);
		expect(row!.amount).toBe(2000);

		// Guarded again straight after.
		await expect(DB.prepare(`update "bf_ledger" set "amount" = 3 where "id" = 'a'`).run())
			.rejects.toThrow();
	});

	it('restores the guard verbatim, column list and all', async () => {
		const before = await triggersOn('bf_charges');
		await backfill(runner, {
			tables: ['bf_charges'],
			statements: [`update "bf_charges" set "amount" = 5 where "id" = 'a'`],
		});
		expect(await triggersOn('bf_charges')).toEqual(before);
		// Still scoped to `amount`, so `fee` is still writable without a backfill.
		await DB.prepare(`update "bf_charges" set "fee" = 36 where "id" = 'a'`).run();
		await expect(DB.prepare(`update "bf_charges" set "amount" = 6 where "id" = 'a'`).run())
			.rejects.toThrow();
	});

	it('reports which columns the suspended guard covered', async () => {
		const result = await backfill(runner, {
			tables: ['bf_charges'],
			statements: [`update "bf_charges" set "amount" = 5 where "id" = 'a'`],
		});
		expect(result.suspended).toEqual({ bf_charges: ['amount'] });
	});

	// The reason this goes through `batch()` rather than three awaits.
	it('leaves the guard standing when a statement fails', async () => {
		const before = await triggersOn('bf_ledger');

		await expect(
			backfill(runner, {
				tables: ['bf_ledger'],
				statements: [
					`update "bf_ledger" set "amount" = 2000 where "id" = 'a'`,
					`update "bf_ledger" set "amount" = 'not-an-integer' where "id" = 'a'`,
				],
			}),
		).rejects.toThrow();

		// Guard back in place, and the first UPDATE rolled back with it.
		expect(await triggersOn('bf_ledger')).toEqual(before);
		const [row] = await runner.all<{ amount: number }>(`select "amount" from "bf_ledger"`);
		expect(row!.amount).toBe(1000);
		await expect(DB.prepare(`update "bf_ledger" set "amount" = 3 where "id" = 'a'`).run())
			.rejects.toThrow();
	});

	it('suspends several tables in one batch', async () => {
		const result = await backfill(runner, {
			tables: ['bf_ledger', 'bf_charges'],
			statements: [
				`update "bf_ledger" set "amount" = 11 where "id" = 'a'`,
				`update "bf_charges" set "amount" = 22 where "id" = 'a'`,
			],
		});
		expect(Object.keys(result.suspended).sort()).toEqual(['bf_charges', 'bf_ledger']);
		expect((await triggersOn('bf_ledger')).length).toBe(1);
		expect((await triggersOn('bf_charges')).length).toBe(1);
	});

	it('refuses a table that has no guard, naming the ones that do', async () => {
		await expect(
			backfill(runner, { tables: ['bf_plain'], statements: [`update "bf_plain" set "note" = 'x'`] }),
		).rejects.toThrow(/no append-only guard found on "bf_plain"[\s\S]*bf_charges, bf_ledger/);
	});

	it('refuses an empty statement list rather than cycling the guard for nothing', async () => {
		await expect(backfill(runner, { tables: ['bf_ledger'], statements: [] }))
			.rejects.toThrow(/no statements/);
		await expect(backfill(runner, { tables: [], statements: ['select 1'] }))
			.rejects.toThrow(/no tables named/);
	});

	// A guard this tool did not author is still a guard: it is read back out of
	// sqlite_master and re-created from its own text, not regenerated.
	it('restores a hand-written guard it did not generate', async () => {
		await DB.prepare(`drop trigger "bf_ledger_no_update"`).run();
		const handWritten = 'create trigger "hand_rolled" before update on "bf_ledger" '
			+ "begin select raise(abort, 'mine'); end";
		await DB.prepare(handWritten).run();

		await backfill(runner, {
			tables: ['bf_ledger'],
			statements: [`update "bf_ledger" set "amount" = 7 where "id" = 'a'`],
		});

		const after = await triggersOn('bf_ledger');
		expect(after).toHaveLength(1);
		expect(after[0]).toContain('hand_rolled');
		// And it still guards.
		await expect(DB.prepare(`update "bf_ledger" set "amount" = 8 where "id" = 'a'`).run())
			.rejects.toThrow();
	});

	it('does not touch tables it was not asked about', async () => {
		const before = await triggersOn('bf_charges');
		await backfill(runner, {
			tables: ['bf_ledger'],
			statements: [`update "bf_ledger" set "amount" = 9 where "id" = 'a'`],
		});
		expect(await triggersOn('bf_charges')).toEqual(before);
		await expect(DB.prepare(`update "bf_charges" set "amount" = 1 where "id" = 'a'`).run())
			.rejects.toThrow();
		// Sanity: the generator's own guard is what was there all along.
		//
		// Compared case-insensitively because `sqlite_master.sql` is not the text
		// that was sent: SQLite re-spells the leading keywords it parsed, so
		// `create trigger` comes back as `CREATE TRIGGER` while the body stays
		// verbatim. Another reason `backfill` replays the stored text instead of
		// re-rendering: the stored text is what SQLite itself calls the
		// definition, so replaying it cannot drift from it.
		expect(before[0]!.toLowerCase()).toBe(appendOnlyTrigger('bf_charges', ['amount']).toLowerCase());
	});
});
