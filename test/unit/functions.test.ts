import { min as drizzleMin, max as drizzleMax, sql as drizzleSql } from 'drizzle-orm';
import { integer as drizzleInteger, sqliteTable as drizzleSqliteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { integer, sql, sqliteTable } from '../../src/index.js';
import type { DecodedChunk } from '../../src/sql/functions.js';
import { avg, count, max, min, sum } from '../../src/sql/functions.js';

describe('sum() / avg() decode', () => {
	// Drizzle's `.mapWith(String)` for `sum`/`avg` in every dialect: a 64-bit
	// sum does not survive an IEEE double. See `[F-009]` in `AUDIT.md`.
	it('sum() decodes a non-null value to a string, not a number', () => {
		expect(sum({} as never).decode('123')).toBe('123');
		expect(typeof sum({} as never).decode('123')).toBe('string');
	});

	it('sum() decodes null/undefined to null', () => {
		expect(sum({} as never).decode(null)).toBeNull();
		expect(sum({} as never).decode(undefined)).toBeNull();
	});

	it('avg() decodes a non-null value to a string, not a number', () => {
		expect(avg({} as never).decode('4.5')).toBe('4.5');
		expect(typeof avg({} as never).decode('4.5')).toBe('string');
	});

	it('avg() decodes null/undefined to null', () => {
		expect(avg({} as never).decode(null)).toBeNull();
		expect(avg({} as never).decode(undefined)).toBeNull();
	});

	it('count() still decodes to a number, unlike sum/avg', () => {
		expect(count().decode('7')).toBe(7);
		expect(typeof count().decode('7')).toBe('number');
	});
});

// Real drizzle-orm: `.mapWith(is(expression, Column) ? expression : String)`
// (`drizzle-orm/sql/functions/aggregate.js`) — a Column operand decodes
// through its own column, a non-Column operand decodes through `String`.
describe('min() / max() decode', () => {
	const t = sqliteTable('t', { n: integer('n') });

	it('decodes a Column operand through the column itself, not String', () => {
		expect(min(t.n).decode(7)).toBe(7);
		expect(typeof min(t.n).decode(7)).toBe('number');
		expect(max(t.n).decode(7)).toBe(7);
		expect(typeof max(t.n).decode(7)).toBe('number');
	});

	it('decodes a non-Column operand through String, matching drizzle-orm', () => {
		// Compare against real drizzle-orm's own min()/max() for the same
		// shape of operand, rather than a hardcoded literal — this is what
		// Drizzle itself actually decodes a non-Column expression to.
		const dt = drizzleSqliteTable('t', { n: drizzleInteger('n') });
		const theirMin = drizzleMin(drizzleSql`${dt.n} + 1`);
		const theirMax = drizzleMax(drizzleSql`${dt.n} + 1`);
		const theirMinDecoded = (theirMin as unknown as { decoder: { mapFromDriverValue(v: unknown): unknown } })
			.decoder.mapFromDriverValue(7);
		const theirMaxDecoded = (theirMax as unknown as { decoder: { mapFromDriverValue(v: unknown): unknown } })
			.decoder.mapFromDriverValue(7);

		const expr = sql<number>`${t.n} + 1`;
		expect(min(expr).decode(7)).toBe(theirMinDecoded);
		expect(typeof min(expr).decode(7)).toBe(typeof theirMinDecoded);
		expect(max(expr).decode(7)).toBe(theirMaxDecoded);
		expect(typeof max(expr).decode(7)).toBe(typeof theirMaxDecoded);
	});

	it('decodes null/undefined to null for either operand shape', () => {
		expect(min(t.n).decode(null)).toBeNull();
		expect(min(t.n).decode(undefined)).toBeNull();
		expect(min(sql<number>`${t.n}`).decode(null)).toBeNull();
	});

	it('types a Column operand through the column\'s own decoded type', () => {
		expectTypeOf(min(t.n)).toEqualTypeOf<DecodedChunk<number | null>>();
		expectTypeOf(max(t.n)).toEqualTypeOf<DecodedChunk<number | null>>();
	});

	it('types a non-Column expression as `string | null`, not the fragment\'s own type', () => {
		// The type-level half of the finding this file guards against:
		// `min(sql<number>\`…\`)` must type as `string | null` per Drizzle's own
		// overload (`(T extends AnyColumn ? T['_']['data'] : string) | null`),
		// even though the fragment itself is typed `sql<number>`, and even
		// though decoding through `String` at runtime is asserted above.
		const expr = sql<number>`${t.n} + 1`;
		expectTypeOf(min(expr)).toEqualTypeOf<DecodedChunk<string | null>>();
		expectTypeOf(max(expr)).toEqualTypeOf<DecodedChunk<string | null>>();
	});
});
