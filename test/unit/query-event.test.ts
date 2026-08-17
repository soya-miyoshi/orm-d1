/**
 * What `onQuery` reports about timing.
 *
 * The two numbers come from different clocks and mean different things, so the
 * only way to tell them apart in a test is to make them disagree — a stubbed
 * D1 whose `meta.duration` is a value no real elapsed time could be. That is
 * what these do: without it, "durationMs is a number" passes whichever source
 * it came from, which is precisely how the field came to be documented as wall
 * clock while carrying D1's server-side figure on every real response.
 */
import { describe, expect, it } from 'vitest';
import type { QueryEvent } from '../../src/index.js';
import { ormD1, eq } from '../../src/index.js';
import { setDev, setWarn } from '../../src/dev.js';
import { users } from '../schema.js';

/** A sentinel: large enough that no real statement in this suite can match it. */
const D1_DURATION = 987_654;

/** The narrowest D1 stub that satisfies the execution path. */
const stubClient = (meta: Record<string, unknown>): D1Database => {
	const statement = {
		bind: () => statement,
		raw: async () => [],
		all: async () => ({ success: true, results: [], meta }),
		run: async () => ({ success: true, results: [], meta }),
	};
	return { prepare: () => statement, batch: async () => [] } as unknown as D1Database;
};

const eventFrom = async (meta: Record<string, unknown>): Promise<QueryEvent> => {
	let event: QueryEvent | undefined;
	const db = ormD1(stubClient(meta), { onQuery: (e) => void (event = e) });
	await db.select().from(users).where(eq(users.id, 1));
	return event!;
};

describe('QueryEvent timing', () => {
	it('reports the measured wall clock, not D1’s server-side duration', async () => {
		const event = await eventFrom({ duration: D1_DURATION, rows_read: 0, rows_written: 0 });

		// The bug: `meta.duration ?? durationMs` preferred D1's, which is present
		// on every real response — so the measurement was computed and then
		// discarded on exactly the path the field is documented for.
		expect(event.durationMs).not.toBe(D1_DURATION);
		expect(event.durationMs).toBeGreaterThanOrEqual(0);
		expect(event.durationMs).toBeLessThan(D1_DURATION);
	});

	it('keeps D1’s figure under its own key rather than dropping it', async () => {
		const event = await eventFrom({ duration: D1_DURATION, rows_read: 0, rows_written: 0 });
		expect(event.d1DurationMs).toBe(D1_DURATION);
	});

	it('omits d1DurationMs when the response carries no duration', async () => {
		const event = await eventFrom({ rows_read: 0, rows_written: 0 });

		expect(event).not.toHaveProperty('d1DurationMs');
		// The wall clock is always available, since we measure it ourselves.
		expect(typeof event.durationMs).toBe('number');
	});

	it('leaves sqlDurationMs subtractable from durationMs', async () => {
		// The documented relationship — `durationMs - sqlDurationMs` is the
		// network share — only holds if the two come from different clocks. With
		// both taken from D1 it was two server-side numbers being subtracted.
		const event = await eventFrom({
			duration: D1_DURATION,
			rows_read: 0,
			rows_written: 0,
			timings: { sql_duration_ms: 0.25 },
		});

		expect(event.sqlDurationMs).toBe(0.25);
		expect(event.durationMs - event.sqlDurationMs!).toBeLessThan(D1_DURATION);
	});
});

/**
 * `#emit` skips building a `QueryEvent` when nobody is listening.
 *
 * `executeRows` already gated its keyed path on `onQuery || isDev()`, but
 * `executeRun` and `batch` called `#emit` unconditionally — so every insert,
 * update, delete and batch member allocated an event object, with up to six
 * conditional spreads, and dropped it unread. These are the two things that
 * gate must not break: the budget still counts, and every listener still hears
 * about every statement.
 */
describe('emitting only when someone is listening', () => {
	const stub = () => stubClient({ rows_read: 0, rows_written: 0 });

	it('still counts statements toward the plan budget with no onQuery and dev off', async () => {
		// The counter is the one side effect that has to survive the early
		// return, and it is invisible until dev is on. So the count is built up
		// with dev *off* and no listener — the production shape, and the path
		// that early-returns — stopping just short of the free plan's 50. Dev is
		// then turned on and the threshold crossed, which is the only window the
		// warning can be observed in: it fires at most once per database object,
		// so a crossing that happens while dev is off is consumed silently.
		const db = ormD1(stub(), { plan: 'free' });

		setDev(false);
		for (let i = 0; i < 49; i++) await db.insert(users).values({ id: i, email: `u${i}@e.com` }).run();

		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));
		try {
			for (let i = 49; i < 51; i++) await db.insert(users).values({ id: i, email: `u${i}@e.com` }).run();
		} finally {
			setDev(false);
		}

		// 51, not 2: the 49 statements that ran with nobody listening were still
		// counted. Skip `budget.record` in the early return and this reads 2, no
		// warning fires, and the plan-limit guard is silently dead in production
		// — which is exactly who it exists for.
		expect(messages.join('\n')).toMatch(/has run 51 statements/);
	});

	it('still reports writes to onQuery', async () => {
		const events: QueryEvent[] = [];
		const db = ormD1(stub(), { onQuery: (e) => events.push(e) });

		await db.insert(users).values({ id: 1, email: 'a@e.com' }).run();
		await db.update(users).set({ name: 'Ada' }).run();
		await db.delete(users).run();

		expect(events.map((e) => e.kind)).toEqual(['insert', 'update', 'delete']);
	});

	it('still reports every member of a batch', async () => {
		const events: QueryEvent[] = [];
		const client = stub();
		// `batch()` on the stub has to return one result per statement.
		const batching = {
			...client,
			batch: async (statements: unknown[]) =>
				statements.map(() => ({ success: true, results: [], meta: { rows_read: 0, rows_written: 0 } })),
		} as unknown as D1Database;
		const db = ormD1(batching, { onQuery: (e) => events.push(e) });

		await db.batch([
			db.insert(users).values({ id: 1, email: 'a@e.com' }),
			db.insert(users).values({ id: 2, email: 'b@e.com' }),
		]);

		expect(events).toHaveLength(2);
		expect(events.every((e) => e.kind === 'insert')).toBe(true);
	});
});
