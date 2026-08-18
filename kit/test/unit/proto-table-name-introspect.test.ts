/**
 * [reviewer issue 3] `snapshotFromIntrospection`'s `tables` map (kept
 * separate from the `snapshotFromSchema` case tested elsewhere, since this
 * one goes through `IntrospectionInput`, not a `sqliteTable` schema) used to
 * be a plain `{}`. A live table literally named `__proto__` — legal SQL,
 * `sqlite_master` reports it with no trouble — silently vanished from
 * `Object.keys(tables)` once assigned as a key on a plain object.
 */
import { describe, expect, it } from 'vitest';
import { snapshotFromIntrospection } from '../../src/core/introspect.js';
import type { IntrospectionInput } from '../../src/core/introspect.js';

describe('snapshotFromIntrospection with a live table named __proto__', () => {
	it('reports it as an own entry, not swallowed into the prototype', () => {
		const input: IntrospectionInput = {
			master: [
				{
					type: 'table',
					name: '__proto__',
					tbl_name: '__proto__',
					sql: 'create table "__proto__" ("id" integer primary key not null)',
				},
			],
			// Built with a computed key and `Object.create(null)`: a literal
			// `{ __proto__: … }` sets the *prototype*, not an own key — that is
			// plain JS object-literal syntax, unrelated to the map-safety bug
			// under test — and a plain `{}` for the others would make
			// `input.foreignKeys['__proto__']` resolve `Object.prototype` itself
			// instead of `undefined`, which is exactly the class of hazard this
			// test exists to rule out in the code under test, not smuggle in here.
			tableInfo: Object.assign(Object.create(null), {
				['__proto__']: [
					{ cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
				],
			}),
			indexList: Object.create(null),
			indexInfo: Object.create(null),
			foreignKeys: Object.create(null),
		};

		const snapshot = snapshotFromIntrospection(input);

		expect(Object.hasOwn(snapshot.tables, '__proto__')).toBe(true);
		expect(snapshot.tables['__proto__']).toBeDefined();
		expect(snapshot.tables['__proto__']!.name).toBe('__proto__');
		expect(Object.getPrototypeOf(snapshot.tables)).toBeNull();
	});
});
