/**
 * `usage` and `budget` (`docs/08-observability.md` §1–§3), against a stubbed D1.
 *
 * Everything here is the counting and the ceilings, which are pure: the stub
 * hands back whatever `meta` the test chose, so totals and boundaries can be
 * pinned exactly. That real D1 fills `rows_read` in, and that a batch and a
 * chunked write are counted member by member, is asserted in the workers suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setDev, setWarn } from '../../src/dev.js';
import type { BatchStatement, OrmD1Options } from '../../src/index.js';
import {
	D1BudgetExceededError,
	eq,
	MissingPlaceholderError,
	ormD1,
	OrmD1QueryError,
	ph,
	query,
} from '../../src/index.js';
import { posts, users } from '../schema.js';

interface Stub {
	readonly client: D1Database;
	/**
	 * The SQL of every statement that was *sent* — run, read or batched. Not
	 * `prepare()`: D1 prepares locally, and a refused statement may be prepared.
	 */
	readonly sent: string[];
	/** How many reads went through `.all()` vs `.raw()`. */
	readonly calls: { all: number; raw: number };
}

/** Each statement reports `rows_read: read`, `rows_written: written`. */
const stub = (read = 0, written = 0): Stub => {
	const sent: string[] = [];
	const calls = { all: 0, raw: 0 };
	const meta = { rows_read: read, rows_written: written };
	const statementFor = (sql: string) => {
		const statement = {
			sql,
			bind: () => statement,
			raw: async () => {
				calls.raw += 1;
				sent.push(sql);
				return [];
			},
			all: async () => {
				calls.all += 1;
				sent.push(sql);
				return { success: true, results: [], meta };
			},
			run: async () => {
				sent.push(sql);
				return { success: true, results: [], meta };
			},
		};
		return statement;
	};
	const client = {
		prepare: statementFor,
		batch: async (statements: { sql: string }[]) => {
			for (const statement of statements) sent.push(statement.sql);
			return statements.map(() => ({ success: true, results: [], meta }));
		},
	} as unknown as D1Database;
	return { client, sent, calls };
};

const capture = (): string[] => {
	const messages: string[] = [];
	setWarn((message) => messages.push(message));
	return messages;
};

afterEach(() => {
	setDev(false);
	setWarn((message) => console.warn(`[ormD1] ${message}`));
});

describe('usage()', () => {
	it('totals statements, rows and wall clock across every path', async () => {
		const { client } = stub(7, 2);
		const db = ormD1(client, { usage: true });

		await db.select().from(users).where(eq(users.id, 1));
		await db.insert(users).values({ id: 1, email: 'a@e.com' }).run();
		await db.execute('select 1');

		const usage = db.usage();
		expect(usage.statements).toBe(3);
		expect(usage.rowsRead).toBe(21);
		expect(usage.rowsWritten).toBe(6);
		expect(usage.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('counts reads even with no onQuery — the select must not take the meta-less raw path', async () => {
		// `.raw()` returns no `meta`, so a meter that let selects through it
		// would report rowsRead 0 for every read: the headline number, gone.
		const { client, calls } = stub(40);
		const db = ormD1(client, { usage: true });
		await db.select().from(users);

		expect(calls).toEqual({ all: 1, raw: 0 });
		expect(db.usage().rowsRead).toBe(40);
	});

	it('breaks totals down by kind, with every kind present', async () => {
		const { client } = stub();
		const db = ormD1(client, { usage: true });

		await db.select().from(users);
		await db.select().from(posts);
		await db.update(users).set({ name: 'x' }).run();
		await db.execute('select 1');

		expect(db.usage().byKind).toEqual({ select: 2, insert: 0, update: 1, delete: 0, raw: 1 });
	});

	it('breaks totals down by table, charging a join to each table it reads', async () => {
		const { client } = stub(5, 1);
		const db = ormD1(client, { usage: true });

		await db.select().from(users);
		await db.select().from(posts).innerJoin(users, eq(posts.authorId, users.id));
		await db.delete(posts).run();

		const { byTable, rowsRead } = db.usage();
		expect(byTable['users']).toEqual({ statements: 2, rowsRead: 10, rowsWritten: 2 });
		expect(byTable['posts']).toEqual({ statements: 2, rowsRead: 10, rowsWritten: 2 });
		// The join's 5 rows land on both tables, so the per-table sums exceed it.
		expect(rowsRead).toBe(15);
		// `db.execute()` has no plan, so it names no table.
		await db.execute('select 1');
		expect(Object.keys(db.usage().byTable).sort()).toEqual(['posts', 'users']);
	});

	it('reports repeated shapes, most repeated first, and only those seen more than once', async () => {
		const { client } = stub();
		const db = ormD1(client, { usage: true });

		// Same text, different bound values: one shape.
		for (const id of [1, 2, 3]) await db.select().from(users).where(eq(users.id, id));
		for (const id of [1, 2]) await db.select().from(posts).where(eq(posts.id, id));
		await db.select().from(posts);

		const { repeats } = db.usage();
		expect(repeats.map((r) => r.count)).toEqual([3, 2]);
		expect(repeats[0]!.sql).toMatch(/from "users"/);
		expect(repeats[1]!.sql).toMatch(/from "posts"/);
	});

	it('returns a copy: mutating it or reading it again changes nothing', async () => {
		const { client } = stub(3);
		const db = ormD1(client, { usage: true });
		await db.select().from(users);
		await db.select().from(users);

		const first = db.usage();
		(first.byTable['users'] as { statements: number }).statements = 99;
		(first.byKind as { select: number }).select = 99;
		(first.repeats[0] as { count: number }).count = 99;

		const second = db.usage();
		expect(second.byTable['users']!.statements).toBe(2);
		expect(second.byKind.select).toBe(2);
		expect(second.repeats[0]!.count).toBe(2);

		// Reading does not stop the counting.
		await db.select().from(users);
		expect(db.usage().statements).toBe(3);
		expect(first.statements).toBe(2);
	});

	it('is independent of onQuery in both directions', async () => {
		const events: unknown[] = [];
		const { client } = stub();
		const db = ormD1(client, { usage: true, onQuery: (e) => events.push(e) });
		await db.select().from(users);
		expect(events).toHaveLength(1);
		expect(db.usage().statements).toBe(1);

		const listening = ormD1(stub().client, { onQuery: () => {} });
		await listening.select().from(users);
		expect(() => listening.usage()).toThrow(/needs `usage: true`/);
	});

	it('is shared with a withSession() database', async () => {
		const { client } = stub(1);
		const sessionable = Object.assign(client, { withSession: () => ({ ...client, getBookmark: () => null }) });
		const db = ormD1(sessionable, { usage: true });

		await db.select().from(users);
		await db.withSession('first-unconstrained').select().from(users);

		expect(db.usage().statements).toBe(2);
	});
});

describe('with neither option', () => {
	it('throws from usage() rather than reporting zeros that read as "nothing ran"', async () => {
		const db = ormD1(stub().client);
		await db.select().from(users);
		expect(() => db.usage()).toThrow(/needs `usage: true`/);
	});

	it('keeps selects on the raw path, so no meta is read and no event is built', async () => {
		const { client, calls } = stub();
		const db = ormD1(client);
		await db.select().from(users);
		expect(calls).toEqual({ all: 0, raw: 1 });
	});

	it('creates no meter', () => {
		expect(ormD1(stub().client).options.meter).toBeUndefined();
		expect(ormD1(stub().client, { usage: false }).options.meter).toBeUndefined();
		expect(ormD1(stub().client, { usage: true }).options.meter).toBeDefined();
		expect(ormD1(stub().client, { budget: {} }).options.meter).toBeDefined();
	});
});

describe('budget', () => {
	const run = async (options: OrmD1Options, n: number, read = 0): Promise<Stub & { error: unknown }> => {
		const s = stub(read);
		const db = ormD1(s.client, options);
		let error: unknown;
		try {
			for (let i = 0; i < n; i++) await db.select().from(users).where(eq(users.id, i));
		} catch (e) {
			error = e;
		}
		return { ...s, error };
	};

	it('maxStatements: sends exactly the limit, refuses the next before it reaches D1', async () => {
		const { sent, error } = await run({ budget: { maxStatements: 3, onExceeded: 'throw' } }, 10);

		expect(sent).toHaveLength(3);
		expect(error).toBeInstanceOf(D1BudgetExceededError);
		expect(error).not.toBeInstanceOf(OrmD1QueryError);
		expect(error).toMatchObject({ reason: 'statements', limit: 3, observed: 4, sql: undefined });
		expect((error as Error).message).toMatch(/budget\.maxStatements of 3/);
	});

	it('maxRowsRead: refuses once the total so far is past the limit, not at it', async () => {
		// 10 rows a statement against a ceiling of 30: the third statement brings
		// the total to 30 (at, not past), the fourth to 40, and the fifth is
		// refused. Sent one after another, the overshoot is one statement's worth.
		const { sent, error } = await run({ budget: { maxRowsRead: 30, onExceeded: 'throw' } }, 10, 10);

		expect(sent).toHaveLength(4);
		expect(error).toMatchObject({ reason: 'rowsRead', limit: 30, observed: 40 });
	});

	it('repeatsPerShape: allows the shape that many times and refuses the next, naming its SQL', async () => {
		const { sent, error } = await run({ budget: { repeatsPerShape: 2, onExceeded: 'throw' } }, 10);

		expect(sent).toHaveLength(2);
		expect(error).toMatchObject({ reason: 'repeats', limit: 2, observed: 3, sql: sent[0] });
		expect((error as Error).message).toMatch(/inArray\(\)/);
	});

	it('repeatsPerShape counts per shape, so distinct statements do not add up', async () => {
		const s = stub();
		const db = ormD1(s.client, { budget: { repeatsPerShape: 1, onExceeded: 'throw' } });
		await db.select().from(users);
		await db.select().from(posts);
		await db.delete(posts).run();
		await expect(db.select().from(users)).rejects.toBeInstanceOf(D1BudgetExceededError);
		expect(s.sent).toHaveLength(3);
	});

	it('refuses a batch whole when its members would cross the line, and counts none of it', async () => {
		// Members are all prepared before any is sent, so counting on the
		// response would have let all five through — and counting member by
		// member left the three ahead of the refusal counted, never sent.
		const s = stub();
		const logged: string[] = [];
		const db = ormD1(s.client, {
			usage: true,
			logger: { logQuery: (sql) => logged.push(sql) },
			budget: { maxStatements: 3, onExceeded: 'throw' },
		});
		const members: BatchStatement[] = Array.from({ length: 5 }, () => db.select().from(users));

		const error = await db.batch(members).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(D1BudgetExceededError);
		expect(error).toMatchObject({ reason: 'statements', limit: 3, observed: 5 });
		expect(s.sent).toEqual([]);
		expect(logged).toEqual([]);
		expect(db.usage().statements).toBe(0);
		expect(db.usage().repeats).toEqual([]);

		// Nothing was spent, so a batch that fits still goes out.
		await db.batch(members.slice(0, 3));
		expect(s.sent).toHaveLength(3);
		expect(db.usage().statements).toBe(3);
	});

	it('counts none of a batch whose later member fails to bind', async () => {
		const s = stub();
		const db = ormD1(s.client, { usage: true, budget: { maxStatements: 2, onExceeded: 'throw' } });
		const missing = query.select().from(users).where(eq(users.id, ph('id')));

		await expect(db.batch([db.select().from(users), db.select().from(posts), missing]))
			.rejects.toBeInstanceOf(MissingPlaceholderError);
		expect(db.usage().statements).toBe(0);
		// The budget is untouched: two statements still fit.
		await db.batch([db.select().from(users), db.select().from(posts)]);
		expect(s.sent).toHaveLength(2);
	});

	it('repeatsPerShape counts one shape repeated inside a single batch', async () => {
		const s = stub();
		const db = ormD1(s.client, { budget: { repeatsPerShape: 2, onExceeded: 'throw' } });
		const error = await db.batch([
			db.insert(users).values({ id: 1, email: 'a@e.com' }),
			db.insert(users).values({ id: 2, email: 'b@e.com' }),
			db.insert(users).values({ id: 3, email: 'c@e.com' }),
		]).catch((e: unknown) => e);

		expect(error).toMatchObject({ reason: 'repeats', limit: 2, observed: 3 });
		expect(s.sent).toEqual([]);
		// Write advice for a write, not the read advice.
		expect((error as Error).message).toMatch(/one insert with every row/);
		expect((error as Error).message).not.toMatch(/lookup per key/);
	});

	it('throws through db.execute() unwrapped too', async () => {
		const db = ormD1(stub().client, { budget: { maxStatements: 0, onExceeded: 'throw' } });
		const error = await db.execute('select 1').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(D1BudgetExceededError);
		expect(error).not.toBeInstanceOf(OrmD1QueryError);
	});

	it('warns by default, once per reason, and keeps sending', async () => {
		const messages = capture();
		const { sent, error } = await run({
			budget: { maxStatements: 2, repeatsPerShape: 2, maxRowsRead: 5 },
		}, 10, 3);

		expect(error).toBeUndefined();
		expect(sent).toHaveLength(10);
		expect(messages).toHaveLength(3);
		expect(messages.filter((m) => m.includes('budget.maxStatements'))).toHaveLength(1);
		expect(messages.filter((m) => m.includes('budget.maxRowsRead'))).toHaveLength(1);
		expect(messages.filter((m) => m.includes('budget.repeatsPerShape'))).toHaveLength(1);
	});

	it('warns outside dev as well, unlike the plan warnings', async () => {
		// A ceiling the caller set is not a dev diagnostic: dropping it with
		// `__DEV__` would make the default `'warn'` a no-op in production.
		setDev(false);
		const messages = capture();
		await run({ budget: { maxStatements: 1 } }, 3);
		expect(messages).toHaveLength(1);
	});

	it('warns once per database object, not once per process', async () => {
		const messages = capture();
		await run({ budget: { maxStatements: 1 } }, 3);
		await run({ budget: { maxStatements: 1 } }, 3);
		expect(messages).toHaveLength(2);
	});

	it('shares its counts with a withSession() database', async () => {
		const s = stub();
		const sessionable = Object.assign(s.client, { withSession: () => ({ ...s.client, getBookmark: () => null }) });
		const db = ormD1(sessionable, { budget: { maxStatements: 1, onExceeded: 'throw' } });

		await db.select().from(users);
		await expect(db.withSession('first-unconstrained').select().from(users))
			.rejects.toBeInstanceOf(D1BudgetExceededError);
	});

	it('does not log a statement it refused to send', async () => {
		const logged: string[] = [];
		const db = ormD1(stub().client, {
			logger: { logQuery: (sql) => logged.push(sql) },
			budget: { maxStatements: 1, onExceeded: 'throw' },
		});
		await db.select().from(users);
		await expect(db.select().from(users)).rejects.toThrow();
		expect(logged).toHaveLength(1);
	});

	it('counts a chunked write as one execution of its shape, and each chunk as a statement', async () => {
		// The reviewer's case: with the doc's own `repeatsPerShape: 25`, a wide
		// insert was refused because every chunk counted as a repeat.
		const s = stub();
		const db = ormD1(s.client, {
			usage: true,
			maxParams: 10,
			budget: { repeatsPerShape: 1, onExceeded: 'throw' },
		});
		const rows = (from: number) =>
			Array.from({ length: 20 }, (_, i) => ({ id: from + i, email: `${from + i}@e.com` }));

		await db.insert(users).values(rows(0)).run();
		expect(s.sent.length).toBeGreaterThan(2);
		expect(db.usage().statements).toBe(s.sent.length);
		expect(db.usage().repeats).toEqual([]);

		// The same wide insert again *is* a second execution of the shape.
		const before = s.sent.length;
		await expect(db.insert(users).values(rows(100)).run()).rejects.toBeInstanceOf(D1BudgetExceededError);
		expect(s.sent).toHaveLength(before);
	});

	it('counts a chunked member of a batch as one shape too', async () => {
		const s = stub();
		const db = ormD1(s.client, { usage: true, maxParams: 10 });
		const wide = Array.from({ length: 20 }, (_, i) => ({ id: i, email: `${i}@e.com` }));
		await db.batch([db.insert(users).values(wide), db.select().from(users)]);

		expect(db.usage().statements).toBe(s.sent.length);
		expect(db.usage().repeats).toEqual([]);
	});

	it('keeps refusing on a database that is never replaced, as a hoisted one is', async () => {
		// No reset: past the line, every later statement on this object throws.
		const db = ormD1(stub().client, { budget: { maxStatements: 1, onExceeded: 'throw' } });
		await db.select().from(users);
		for (let i = 0; i < 3; i++) {
			await expect(db.select().from(posts)).rejects.toBeInstanceOf(D1BudgetExceededError);
		}
	});
});

describe('budget validation', () => {
	// The guard has to be on when the caller believes it is: a NaN limit
	// compares false against everything, and an unknown mode meant 'warn'.
	it.each([
		['maxStatements', Number.NaN],
		['maxStatements', -1],
		['maxRowsRead', Number.POSITIVE_INFINITY],
		['repeatsPerShape', '25'],
	])('rejects budget.%s = %s at construction', (key, value) => {
		expect(() => ormD1(stub().client, { budget: { [key]: value } as never }))
			.toThrow(new RegExp(`budget\\.${key} must be a finite number >= 0`));
	});

	it('rejects an onExceeded it does not know', () => {
		expect(() => ormD1(stub().client, { budget: { onExceeded: 'Throw' as never } }))
			.toThrow(/budget\.onExceeded must be 'warn' or 'throw'; received "Throw"/);
	});

	it('accepts zero and both modes', () => {
		expect(() => ormD1(stub().client, { budget: { maxStatements: 0, onExceeded: 'throw' } })).not.toThrow();
		expect(() => ormD1(stub().client, { budget: { maxRowsRead: 1.5, onExceeded: 'warn' } })).not.toThrow();
	});
});
