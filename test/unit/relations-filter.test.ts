/**
 * The object filter DSL's field resolution.
 *
 * `docs/07` documents `where` as something callers will hand straight from a
 * JSON body — it is the shape Pothos passes through — so "which keys resolve to
 * a column" is a trust boundary, not an ergonomic detail. The unknown-field
 * refusal is the only thing standing between a caller-supplied key and the
 * compiler, and a plain `columns[key]` read walks the prototype chain right
 * past it.
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns, integer, sqliteTable, text } from '../../src/index.js';
import { compileFilter } from '../../src/relations/filter.js';

const users = sqliteTable('users', {
	id: integer('id').primaryKey(),
	name: text('name'),
});

const columns = getTableColumns(users) as Record<string, any>;

const compile = (filter: unknown) => compileFilter(filter as never, users, columns, {}, {});

describe('prototype keys in the filter DSL', () => {
	/**
	 * Every one of these is an inherited member of `Object.prototype`, so
	 * `columns[key]` is truthy and the refusal below never ran. The filter
	 * compiled to `? = ?` with a *function* in the parameter list, which
	 * `D1PreparedStatement.bind()` rejects — turning what should be a clean
	 * "unknown filter field" into an unhandled failure at execution time.
	 */
	it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
		'refuses "%s" instead of resolving it off the prototype',
		(key) => {
			expect(() => compile({ [key]: 'x' })).toThrow(/Unknown filter field/);
		},
	);

	/**
	 * `JSON.parse` creates `__proto__` as an *own* property, so it survives
	 * `Object.entries` — which is exactly how a `where` taken from a request
	 * body reaches the compiler. `columns['__proto__']` is `Object.prototype`:
	 * an object, so it was walked as an operator record rather than refused.
	 */
	it('refuses an own __proto__ key parsed from JSON', () => {
		const filter = JSON.parse('{"__proto__": {"eq": 1}}');
		expect(Object.hasOwn(filter, '__proto__')).toBe(true);
		expect(() => compile(filter)).toThrow(/Unknown filter field/);
	});

	it('never binds a function as a parameter', () => {
		// The precise failure the old code produced: `? = ?`, with `Object` in
		// slot 0. Asserted separately from the throw so a future regression that
		// swallows the error still fails here.
		let compiled: ReturnType<typeof compile> | undefined;
		try {
			compiled = compile({ constructor: 'x' });
		} catch { /* expected */ }
		const params = compiled?.toQuery().params ?? [];
		expect(params.some((p) => p.k === 'const' && typeof p.v === 'function')).toBe(false);
	});

	it('still resolves a real column, and a column that shadows a prototype name', () => {
		expect(compile({ name: 'Ada' })?.toQuery().sql).toBe('"users"."name" = ?');

		// An own column called `constructor` must still work — `hasOwn` is about
		// where the name came from, not about the spelling being forbidden.
		const shadow = sqliteTable('shadow', { constructor: text('constructor') });
		const shadowColumns = getTableColumns(shadow) as Record<string, any>;
		const query = compileFilter({ constructor: 'x' } as never, shadow, shadowColumns, {}, {})?.toQuery();
		expect(query?.sql).toBe('"shadow"."constructor" = ?');
		expect(query?.params).toEqual([{ k: 'const', v: 'x' }]);
	});
});
