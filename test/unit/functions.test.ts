import { describe, expect, it } from 'vitest';
import { avg, count, sum } from '../../src/sql/functions.js';

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
