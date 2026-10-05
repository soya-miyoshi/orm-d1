import { describe, expect, it } from 'vitest';
import { blob, CompileError, compilePlan, ormD1, inArray, integer, notInArray, sql, sqliteTable } from '../../src/index.js';
import type { SelectPlan } from '../../src/index.js';

// `orm-d1()` distinguishes a binding from a config by `prepare`; nothing runs.
const binding = { prepare: () => {} } as unknown as D1Database;

const keys = sqliteTable('keys', {
	id: integer('id').primaryKey(),
	// The shape with no faithful JSON spelling — UUID-as-bytes. Explicit
	// buffer mode: what's under test here is `isBinary(rawValue)` in
	// `collapsesToJsonEach` (src/sql/expressions.ts), which checks the raw
	// values passed to `inArray()`, not the column's encoder — but buffer
	// mode is still the honest column for a key that is actually bytes.
	uuid: blob('uuid', { mode: 'buffer' }).notNull(),
});

const planOf = (where?: SelectPlan['where']): SelectPlan => ({
	kind: 'select',
	from: keys,
	selection: undefined,
	joins: [],
	where,
	groupBy: [],
	having: undefined,
	orderBy: [],
	limit: undefined,
	offset: undefined,
	distinct: false,
});

describe('maxParams / jsonEachThreshold', () => {
	it('rejects a threshold above the budget at construction', () => {
		expect(() => ormD1(binding, { maxParams: 100, jsonEachThreshold: 200 }))
			.toThrow(CompileError);
		expect(() => ormD1(binding, { maxParams: 100, jsonEachThreshold: 200 }))
			.toThrow(/jsonEachThreshold \(200\) exceeds maxParams \(100\)/);
	});

	it('rejects it at compile time too, for callers using core directly', () => {
		expect(() => compilePlan(planOf(), { maxParams: 50, jsonEachThreshold: 60 }))
			.toThrow(/exceeds maxParams/);
	});

	it('accepts a threshold at the budget', () => {
		expect(() => ormD1(binding, { maxParams: 100, jsonEachThreshold: 100 })).not.toThrow();
	});

	it('clamps the default threshold when only maxParams is lowered', () => {
		// Lowering maxParams alone is how you ask for smaller chunks; the
		// default threshold of 30 is not a choice the caller made.
		expect(() => ormD1(binding, { maxParams: 10 })).not.toThrow();

		const compiled = compilePlan(planOf(inArray(keys.id, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), {
			maxParams: 10,
		});
		expect(compiled.sql).toContain('json_each');
		expect(compiled.params).toHaveLength(1);
	});

	it('rejects nonsense values', () => {
		expect(() => ormD1(binding, { maxParams: 0 })).toThrow(/maxParams must be a positive integer/);
		expect(() => ormD1(binding, { jsonEachThreshold: -1 }))
			.toThrow(/jsonEachThreshold must be a positive integer/);
	});
});

describe('inArray against the budget', () => {
	const ids = Array.from({ length: 150 }, (_, i) => i + 1);
	const uuids = Array.from({ length: 150 }, (_, i) => new Uint8Array([i, 0xaa]));

	it('collapses a long non-binary array to one parameter', () => {
		const compiled = compilePlan(planOf(inArray(keys.id, ids)));

		expect(compiled.sql).toContain('json_each');
		expect(compiled.params).toHaveLength(1);
	});

	it('names the budget for binary values, which cannot collapse', () => {
		expect(() => compilePlan(planOf(inArray(keys.uuid, uuids)))).toThrow(CompileError);
		expect(() => compilePlan(planOf(inArray(keys.uuid, uuids))))
			.toThrow(/inArray\(\) was given 150 values.*limit of 100.*no json_each spelling/s);
	});

	it('reports notInArray under its own name', () => {
		expect(() => compilePlan(planOf(notInArray(keys.uuid, uuids))))
			.toThrow(/notInArray\(\) was given 150 values/);
	});

	it('binds a short binary array as before', () => {
		const few = uuids.slice(0, 5);
		const compiled = compilePlan(planOf(inArray(keys.uuid, few)));

		expect(compiled.sql).not.toContain('json_each');
		expect(compiled.params).toHaveLength(5);
	});

	it('counts a row-value list as rows × columns, not rows', () => {
		// A tuple has no json_each spelling to collapse into, so the budget is
		// the only thing standing between a wide batch and SQLite's
		// `too many SQL variables`. 60 pairs is 120 parameters against a limit
		// of 100 — under the old per-element count it read as 60 and compiled.
		const tuple = sql`(${sql.join([keys.id, keys.uuid], ', ')})`;
		const pairs = Array.from({ length: 60 }, (_, i) => [i + 1, new Uint8Array([i, 0xaa])]);

		expect(() => compilePlan(planOf(inArray(tuple as never, pairs as never)))).toThrow(CompileError);
		expect(() => compilePlan(planOf(inArray(tuple as never, pairs as never))))
			.toThrow(/inArray\(\) was given 60 2-column row values, which bind 120 parameters.*limit of 100/s);

		// And one that fits binds every member.
		const compiled = compilePlan(planOf(inArray(tuple as never, pairs.slice(0, 4) as never)));
		expect(compiled.sql).toContain('in ((?, ?), (?, ?), (?, ?), (?, ?))');
		expect(compiled.params).toHaveLength(8);
	});

	it('reports a row-value overflow under notInArray’s own name, and renders `not in`', () => {
		const tuple = sql`(${sql.join([keys.id, keys.uuid], ', ')})`;
		const pairs = Array.from({ length: 60 }, (_, i) => [i + 1, new Uint8Array([i, 0xaa])]);

		expect(() => compilePlan(planOf(notInArray(tuple as never, pairs as never))))
			.toThrow(/notInArray\(\) was given 60 2-column row values/);

		expect(compilePlan(planOf(notInArray(tuple as never, pairs.slice(0, 2) as never))).sql)
			.toContain('not in ((?, ?), (?, ?))');
	});

	it('explains a collapsible array that only overflows because of a low threshold', () => {
		// Reachable only when both options are lowered together, since the
		// threshold can no longer exceed the budget.
		expect(() => compilePlan(planOf(inArray(keys.id, ids)), { maxParams: 20, jsonEachThreshold: 20 }))
			.not.toThrow();
	});
});
