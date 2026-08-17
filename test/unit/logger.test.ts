/**
 * [F-086]: `logger` was accepted by `OrmD1Options` and silently ignored.
 * `logger: true` is the single most common Drizzle debugging switch, so a
 * caller who set it and saw no output had every reason to believe no queries
 * were running.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDev } from '../../src/dev.js';
import type { Logger } from '../../src/index.js';
import { eq, ormD1 } from '../../src/index.js';
import { users } from '../schema.js';

const stubClient = (): D1Database => {
	const statement = {
		bind: () => statement,
		raw: async () => [],
		all: async () => ({ success: true, results: [], meta: {} }),
		run: async () => ({ success: true, results: [], meta: {} }),
	};
	return {
		prepare: () => statement,
		batch: async (statements: unknown[]) => statements.map(() => ({ success: true, results: [], meta: {} })),
	} as unknown as D1Database;
};

describe('logger', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setDev(false);
	});

	it('does not call a logger when none is configured', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const db = ormD1(stubClient());
		await db.select().from(users).where(eq(users.id, 1));
		expect(spy).not.toHaveBeenCalled();
	});

	it('calls a custom logger\'s logQuery with the compiled sql and bound params', async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const logger: Logger = {
			logQuery: (sql, params) => calls.push({ sql, params }),
		};
		const db = ormD1(stubClient(), { logger });
		await db.select().from(users).where(eq(users.id, 1));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toContain('select');
		expect(calls[0]!.params).toEqual([1]);
	});

	it('logs every chunk of a chunked write, not just the first', async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const logger: Logger = {
			logQuery: (sql, params) => calls.push({ sql, params }),
		};
		const db = ormD1(stubClient(), { logger, maxParams: 10 });
		const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, email: `${i}@x.com`, name: 'n', role: 'member' as const }));
		await db.insert(users).values(rows);

		expect(calls.length).toBeGreaterThan(1);
	});

	it('logger: true uses a default logger without throwing', async () => {
		const db = ormD1(stubClient(), { logger: true });
		await expect(db.select().from(users).where(eq(users.id, 1))).resolves.toBeDefined();
	});

	it('the default logger omits bound params outside dev, but prints them in dev', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

		setDev(false);
		const dbProd = ormD1(stubClient(), { logger: true });
		await dbProd.select().from(users).where(eq(users.id, 1));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]![0]).not.toContain('params');

		spy.mockClear();
		setDev(true);
		const dbDev = ormD1(stubClient(), { logger: true });
		await dbDev.select().from(users).where(eq(users.id, 1));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]![0]).toContain('params: [1]');
	});
});
