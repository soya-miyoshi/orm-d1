import { describe, expect, it } from 'vitest';
import { and } from '../../src/sql/expressions.js';
import { coalesce } from '../../src/sql/functions.js';
import { sql } from '../../src/sql/sql.js';

describe('sql template rendering', () => {
	it('elides an interpolated undefined instead of binding it', () => {
		const q = sql`select 1 where ${and(undefined, undefined)}`.toQuery();
		expect(q).toEqual({ sql: 'select 1 where ', params: [] });
	});

	it('still binds an interpolated null as a parameter', () => {
		const q = sql`x = ${null}`.toQuery();
		expect(q.sql).toBe('x = ?');
		expect(q.params).toEqual([{ k: 'const', v: null }]);
	});

	it('expands an interpolated array into a parenthesized, comma-separated list', () => {
		const q = sql`id in ${[1, 2, 3]}`.toQuery();
		expect(q.sql).toBe('id in (?, ?, ?)');
		expect(q.params).toEqual([1, 2, 3].map((v) => ({ k: 'const', v })));
	});

	it('renders an empty interpolated array as ()', () => {
		const q = sql`id in ${[] as number[]}`.toQuery();
		expect(q.sql).toBe('id in ()');
		expect(q.params).toEqual([]);
	});

	it('does not treat a Uint8Array blob as an array to expand', () => {
		const blob = new Uint8Array([1, 2, 3]);
		const q = sql`x = ${blob}`.toQuery();
		expect(q.sql).toBe('x = ?');
		expect(q.params).toEqual([{ k: 'const', v: blob }]);
	});

	it('expands an array nested inside another sql chunk', () => {
		const inner = sql`id in ${[1, 2]}`;
		const q = sql`select * where ${inner}`.toQuery();
		expect(q.sql).toBe('select * where id in (?, ?)');
		expect(q.params).toEqual([1, 2].map((v) => ({ k: 'const', v })));
	});

	it('expands an array of sql chunks', () => {
		const q = sql`id in ${[sql`a`, sql`b`]}`.toQuery();
		expect(q.sql).toBe('id in (a, b)');
		expect(q.params).toEqual([]);
	});

	it('binds Uint8Array elements inside an array rather than expanding them', () => {
		const a = new Uint8Array([1]);
		const b = new Uint8Array([2]);
		const q = sql`vals ${[a, b]}`.toQuery();
		expect(q.sql).toBe('vals (?, ?)');
		expect(q.params).toEqual([a, b].map((v) => ({ k: 'const', v })));
	});

	it('elides an undefined element inside an interpolated array, matching Drizzle', () => {
		const q = sql`id in ${[1, undefined, 3]}`.toQuery();
		expect(q.sql).toBe('id in (?, , ?)');
		expect(q.params).toEqual([1, 3].map((v) => ({ k: 'const', v })));
	});

	it('recursively expands a nested array element', () => {
		const q = sql`vals ${[[1, 2], [3, 4]]}`.toQuery();
		expect(q.sql).toBe('vals ((?, ?), (?, ?))');
		expect(q.params).toEqual([1, 2, 3, 4].map((v) => ({ k: 'const', v })));
	});
});

describe('coalesce', () => {
	it('joins its operands with a comma separator', () => {
		const q = coalesce(sql`a`, sql`b`).toQuery();
		expect(q.sql).toBe('coalesce(a, b)');
	});
});

describe('sql.join', () => {
	it('concatenates with no separator by default', () => {
		const q = sql.join([sql`a`, sql`b`]).toQuery();
		expect(q.sql).toBe('ab');
	});

	it('uses the given separator when passed explicitly', () => {
		const q = sql.join([sql`a`, sql`b`], ', ').toQuery();
		expect(q.sql).toBe('a, b');
	});
});
