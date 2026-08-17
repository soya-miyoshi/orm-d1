/**
 * D1's non-parameter limits.
 *
 * The bound-parameter budget has its own file; these are the ones D1 states in
 * bytes or in counts, which orm-d1 checks at compile time so the error names
 * the call instead of arriving as a bare SQLite message.
 */
import { describe, expect, it } from 'vitest';
import { setDev, setWarn } from '../../src/dev.js';
import type { InsertPlan } from '../../src/plan/plan.js';
import {
	CompileError,
	coalesce,
	compilePlan,
	eq,
	glob,
	integer,
	like,
	MAX_COLUMNS_PER_TABLE,
	MAX_FUNCTION_ARGS,
	MAX_PATTERN_BYTES,
	PLAN_LIMITS,
	ph,
	query,
	sql,
	sqliteTable,
	text,
} from '../../src/index.js';
import { exceedsBytes, InvocationBudget, MAX_STATEMENT_BYTES } from '../../src/limits.js';

const users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name') });

describe('byte counting', () => {
	it('measures UTF-8 bytes, not UTF-16 code units', () => {
		// 20 code units, 60 bytes — over a 50-byte limit that `.length` clears.
		const emoji = '猫'.repeat(20);
		expect(emoji.length).toBe(20);
		expect(exceedsBytes(emoji, 50)).toBe(true);
		expect(exceedsBytes('a'.repeat(50), 50)).toBe(false);
		expect(exceedsBytes('a'.repeat(51), 50)).toBe(true);
	});
});

describe('pattern length', () => {
	it('refuses a like pattern over the 50-byte cap', () => {
		expect(() => like(users.name, 'a'.repeat(MAX_PATTERN_BYTES + 1)))
			.toThrow(/exceeds D1's 50-byte limit/);
		expect(() => glob(users.name, 'a'.repeat(MAX_PATTERN_BYTES + 1))).toThrow(CompileError);
	});

	it('accepts one at the cap, and counts bytes', () => {
		expect(() => like(users.name, 'a'.repeat(MAX_PATTERN_BYTES))).not.toThrow();
		// 18 characters, 54 bytes.
		expect(() => like(users.name, '猫'.repeat(18))).toThrow(/50-byte limit/);
	});

	it('leaves a placeholder to the database, being unknowable here', () => {
		// The pattern arrives after compilation, so there is nothing to measure.
		// Saying so beats a check that pretends to cover this.
		expect(() => like(users.name, ph('pattern'))).not.toThrow();
	});
});

describe('function arity', () => {
	it('refuses more than 32 arguments to a single SQL function', () => {
		const args = Array.from({ length: MAX_FUNCTION_ARGS + 1 }, (_, i) => i);
		expect(() => coalesce(...args)).toThrow(/exceeds D1's limit of 32 per SQL function/);
		expect(() => coalesce(...args.slice(1))).not.toThrow();
	});
});

describe('columns per table', () => {
	it('refuses a table wider than 100 columns at declaration', () => {
		const wide = Object.fromEntries(
			Array.from({ length: MAX_COLUMNS_PER_TABLE + 1 }, (_, i) => [`c${i}`, integer(`c${i}`)]),
		);
		expect(() => sqliteTable('wide', wide)).toThrow(/exceeds D1's limit of 100 per table/);
	});

	it('accepts one exactly at the cap', () => {
		const exact = Object.fromEntries(
			Array.from({ length: MAX_COLUMNS_PER_TABLE }, (_, i) => [`c${i}`, integer(`c${i}`)]),
		);
		expect(() => sqliteTable('exact', exact)).not.toThrow();
	});
});

describe('statement length', () => {
	// Through the builders, not `compilePlan`. Every builder calls its own
	// compiler directly, so a check wired only to `compilePlan` is reachable
	// from tests and from nothing else — which is how this limit shipped
	// unenforced the first time.
	it('refuses an oversized select built through the public builder', () => {
		const huge = sql.raw(`/*${'x'.repeat(MAX_STATEMENT_BYTES)}*/ 1 = 1`);
		expect(() => query.select().from(users).where(huge).compile())
			.toThrow(/exceeds D1's 100000-byte limit on SQL text/);
	});

	it('refuses an oversized delete and update through their builders', () => {
		// `insert` has no where clause, so its builder path is exercised by the
		// wide-insert case below instead.
		const huge = sql.raw(`/*${'x'.repeat(MAX_STATEMENT_BYTES)}*/ 1 = 1`);
		expect(() => query.delete(users).where(huge).compile()).toThrow(CompileError);
		expect(() => query.update(users).set({ name: 'x' }).where(huge).compile()).toThrow(CompileError);
	});

	it('leaves an ordinary statement alone', () => {
		// A long *bound value* is not statement text — this is the distinction
		// the error message makes, so it is worth pinning.
		const long = 'x'.repeat(MAX_STATEMENT_BYTES);
		expect(() => query.select().from(users).where(eq(users.name, ph('n'))).limit(1).compile())
			.not.toThrow();
		expect(() => query.delete(users).where(eq(users.name, long)).compile()).not.toThrow();
	});

	it('names maxParams as the lever when a wide insert overruns it', () => {
		// Chunking divides by maxParams, so a raised budget is what lets a single
		// statement's *text* pass 100 KB before its parameter count does. That is
		// the real shape of this failure, and the reason the message points at
		// maxParams rather than at the row count.
		const columns = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [`c${i}`, text(`${'n'.repeat(90)}${i}`)]),
		);
		const wide = sqliteTable('wide_names', columns);
		const row = Object.fromEntries(Object.keys(columns).map((k) => [k, 'v']));

		const plan: InsertPlan = {
			kind: 'insert',
			table: wide,
			values: Array.from({ length: 3_000 }, () => row),
			onConflict: undefined,
			returning: undefined,
		};

		expect(() => compilePlan(plan, { maxParams: 100_000 }))
			.toThrow(/exceeds D1's 100000-byte limit on SQL text/);
		expect(() => compilePlan(plan, { maxParams: 100_000 })).toThrow(/Lower maxParams/);

		// The default budget chunks it into statements far below the byte cap,
		// which is why this limit is reachable only by raising maxParams.
		expect(() => compilePlan(plan)).not.toThrow();
	});
});

describe('the plan option', () => {
	const collect = (run: (budget: InvocationBudget) => void): string[] => {
		const messages: string[] = [];
		setDev(true);
		setWarn((message) => messages.push(message));
		try {
			run(new InvocationBudget('free', PLAN_LIMITS['free']));
		} finally {
			setDev(false);
		}
		return messages;
	};

	it('warns once past the free plan’s 50 statements per invocation', () => {
		const messages = collect((budget) => {
			for (let i = 0; i < 60; i++) budget.record(undefined);
		});

		// Once, not ten times: past the line every further statement is also past
		// it, and repeating the claim buries it.
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatch(/51 statements, past the free plan's limit of 50/);
	});

	it('says nothing at or below the limit', () => {
		expect(collect((budget) => {
			for (let i = 0; i < PLAN_LIMITS['free'].queriesPerInvocation; i++) budget.record(undefined);
		})).toEqual([]);
	});

	it('warns as the database approaches the plan’s size cap', () => {
		const limit = PLAN_LIMITS['free'].databaseBytes;
		expect(collect((budget) => budget.record(limit * 0.5))).toEqual([]);
		expect(collect((budget) => budget.record(limit * 0.95))[0])
			.toMatch(/past 90% of the free plan's 0.50 GB limit/);
	});

	it('carries the paid plan’s larger numbers', () => {
		expect(PLAN_LIMITS['paid'].queriesPerInvocation).toBe(1_000);
		expect(PLAN_LIMITS['paid'].databaseBytes).toBe(10_000_000_000);
	});
});
