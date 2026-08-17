/**
 * `introspect()` must not walk tables (or, within a table, indexes)
 * sequentially: that is O(tables + indexes) round trips, each a real network
 * hop on remote D1. Wrapping the runner to record how many `all()` calls are
 * in flight at once — sampled at every call's start and end — turns "ran
 * concurrently" into a number: the peak concurrency should be close to the
 * table/index count, not 1.
 */
import { env } from 'cloudflare:test';
import { createSchema } from 'orm-d1/ddl';
import { index, integer, sqliteTable, text } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';

const DB = (env as { DB: D1Database }).DB;

const TABLE_COUNT = 8;

describe('introspect concurrency', () => {
	beforeEach(async () => {
		const existing = await DB.prepare(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
				+ "and name not like '\\_cf\\_%' escape '\\'",
		).all<{ name: string }>();
		for (const t of existing.results) await DB.prepare(`drop table if exists "${t.name}"`).run();

		const tables = Array.from({ length: TABLE_COUNT }, (_, i) =>
			sqliteTable(`t${i}`, {
				id: integer('id').primaryKey(),
				a: text('a').notNull(),
				b: text('b').notNull(),
			}, (t) => [index(`t${i}_a_idx`).on(t.a), index(`t${i}_b_idx`).on(t.b)]));

		for (const statement of createSchema(tables)) await DB.prepare(statement).run();
	});

	it('runs pragma queries in O(1) sequential waves rather than one per table', async () => {
		let inFlight = 0;
		let peak = 0;
		let sequentialCalls = 0;

		const runner: SqlRunner = {
			all: async <T>(sql: string) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				// A call that starts while nothing else is in flight is a
				// sequential wave boundary — counting those bounds how many
				// round trips are strictly serialised, independent of exact
				// timing.
				if (inFlight === 1) sequentialCalls++;
				try {
					return (await DB.prepare(sql).all<T>()).results as T[];
				} finally {
					inFlight--;
				}
			},
			batch: async (statements) => {
				await DB.batch(statements.map((sql) => DB.prepare(sql)));
			},
		};

		await introspect(runner);

		// Sequential-only code would open a new wave for every table's three
		// pragmas plus every one of its two indexes' `index_info` — comfortably
		// more than `TABLE_COUNT`. Two dependent waves per table (the three
		// table-level pragmas, then that table's index_info pragmas) is the
		// most this should ever need, plus the one `sqlite_master` read.
		expect(sequentialCalls).toBeLessThan(TABLE_COUNT + 2);
		// And the concurrency actually reached is more than "one at a time"...
		expect(peak).toBeGreaterThan(1);
		// ...but never exceeds the shared cap `introspect()` enforces, even
		// though this schema's 8 tables x 3 table-level pragmas comfortably
		// exceed it — the whole point of the gate is that a large schema on
		// `--remote` never bursts past a bounded number of simultaneous calls.
		expect(peak).toBeLessThanOrEqual(12);
	});
});
