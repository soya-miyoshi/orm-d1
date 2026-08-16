/**
 * Field resolution for the rest of the relational config — `orderBy` and `with`.
 *
 * `where` has its own suite (`relations-filter.test.ts`); these are the sibling
 * keys of the same object, arriving from the same place. `docs/07` documents
 * the whole `FindConfig` as a trust boundary, so every key that resolves
 * against a bag of columns or relations has to refuse a prototype member
 * rather than pick one up off the chain.
 *
 * These run against a stubbed D1 because the failure they pin down happens
 * while the query is being built — nothing needs to execute, and the stub
 * returning no rows is what keeps this a unit test.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from '../../src/index.js';
import * as schema from '../schema.js';

/** The narrowest D1 stub the relational path touches: it returns no rows. */
const stubClient = (): D1Database => {
	const statement = {
		bind: () => statement,
		raw: async () => [],
		all: async () => ({ success: true, results: [], meta: {} }),
		run: async () => ({ success: true, results: [], meta: {} }),
	};
	return { prepare: () => statement, batch: async () => [] } as unknown as D1Database;
};

const db = drizzle({ client: stubClient(), relations: schema.relations });

const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

describe('prototype keys in orderBy', () => {
	/**
	 * `columns['constructor']` is `Object` — truthy — so the "Cannot order by"
	 * refusal never ran. `asc(Object)` is not a column and not a SQL chunk, so
	 * it compiled to `? asc` with a *function* in the parameter list, which
	 * `D1PreparedStatement.bind()` rejects: a clean 400 became an unhandled 500
	 * at execution time, one layer below where the mistake was made.
	 */
	it.each(PROTOTYPE_KEYS)('refuses "%s" instead of resolving it off the prototype', async (key) => {
		await expect(db.query.users.findMany({ orderBy: { [key]: 'asc' } } as never))
			.rejects.toThrow(/Cannot order by/);
	});

	it('refuses an own __proto__ key parsed from JSON', async () => {
		const orderBy = JSON.parse('{"__proto__": "asc"}');
		expect(Object.hasOwn(orderBy, '__proto__')).toBe(true);
		await expect(db.query.users.findMany({ orderBy })).rejects.toThrow(/Cannot order by/);
	});

	it('still orders by a real column', async () => {
		// The guard is about where the key lives, not about rejecting keys.
		await expect(db.query.users.findMany({ orderBy: { name: 'desc' } })).resolves.toEqual([]);
	});
});

describe('prototype keys in with', () => {
	/**
	 * This one already threw — but with "has no resolved join columns", which
	 * names an internal invariant of `defineRelations` rather than the caller's
	 * mistake, and reads like a d1zzle bug worth filing. The relation genuinely
	 * does not exist, so that is what it must say.
	 */
	it.each(PROTOTYPE_KEYS)('reports "%s" as a missing relation, not a broken one', async (key) => {
		await expect(db.query.users.findMany({ with: { [key]: true } } as never))
			.rejects.toThrow(/has no relation named/);
	});

	it('refuses an own __proto__ key parsed from JSON', async () => {
		const withConfig = JSON.parse('{"__proto__": true}');
		expect(Object.hasOwn(withConfig, '__proto__')).toBe(true);
		await expect(db.query.users.findMany({ with: withConfig }))
			.rejects.toThrow(/has no relation named/);
	});

	/**
	 * The joined strategy answers `with` through its own support check
	 * (`supportsJoined`), which reads the same relation bag. It reached the
	 * right answer for the wrong reason — a prototype member failed its
	 * `sourceColumns` test — so it is pinned separately.
	 */
	it.each(PROTOTYPE_KEYS)('reports the same under the joined strategy: "%s"', async (key) => {
		const joined = drizzle({
			client: stubClient(),
			relations: schema.relations,
			relationalStrategy: 'joined',
		});
		await expect(joined.query.users.findMany({ with: { [key]: true } } as never))
			.rejects.toThrow(/has no relation named/);
	});

	it('still traverses a real relation', async () => {
		await expect(db.query.users.findMany({ with: { posts: true } })).resolves.toEqual([]);
	});
});
