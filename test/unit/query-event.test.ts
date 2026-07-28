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
import { d1zzle, eq } from '../../src/index.js';
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
	const db = d1zzle(stubClient(meta), { onQuery: (e) => void (event = e) });
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
