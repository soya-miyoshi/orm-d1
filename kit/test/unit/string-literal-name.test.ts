/**
 * [F-126] A `UNIQUE (…)` member name spelled as a `'…'` string literal is
 * unmatchable — `blankLiterals` erases the contents, and the name regex had
 * no `'…'` branch, so `matchUniqueClause` could never pair the clause with
 * its automatic index. The collation (and the constraint itself) was silently
 * downgraded.
 *
 * [F-127] The same hole on the PK clause: `primary key ('a' autoincrement)`
 * — `hasAutoincrement`'s PK-clause fallback compared the whitespace name
 * against the real column name, never matched, and `autoincrement: false`
 * was emitted.
 *
 * Both are exercised here as unit tests against the pure parser (no D1),
 * alongside the workers-level behavioural tests in the companion file.
 */
import { describe, expect, it } from 'vitest';
import { snapshotFromIntrospection } from '../../src/core/introspect.js';
import type { IntrospectionInput } from '../../src/core/introspect.js';

describe('[F-126] unique constraint member name as a string literal', () => {
	it('recovers the name and collation from a single-quoted member', () => {
		const input: IntrospectionInput = {
			master: [
				{
					type: 'table',
					name: 't',
					tbl_name: 't',
					sql: `create table "t" ("id" integer primary key, "email" text not null, unique ('email' collate nocase))`,
				},
			],
			tableInfo: Object.assign(Object.create(null), {
				t: [
					{ cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
					{ cid: 1, name: 'email', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
				],
			}),
			indexList: Object.assign(Object.create(null), {
				t: [
					{ seq: 0, name: 'sqlite_autoindex_t_1', unique: 1, origin: 'u', partial: 0 },
				],
			}),
			indexInfo: Object.assign(Object.create(null), {
				sqlite_autoindex_t_1: [
					{ seqno: 0, cid: 1, name: 'email' },
				],
			}),
			foreignKeys: Object.create(null),
		};

		const snapshot = snapshotFromIntrospection(input);
		const uc = Object.values(snapshot.tables['t']?.uniqueConstraints ?? {})[0];
		expect(uc?.columns).toEqual([{ name: 'email', collate: 'nocase' }]);
	});

	it('recovers the name when a string-literal member has no collation', () => {
		const input: IntrospectionInput = {
			master: [
				{
					type: 'table',
					name: 't',
					tbl_name: 't',
					sql: `create table "t" ("id" integer primary key, "v" text, unique ('v'))`,
				},
			],
			tableInfo: Object.assign(Object.create(null), {
				t: [
					{ cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
					{ cid: 1, name: 'v', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
				],
			}),
			indexList: Object.assign(Object.create(null), {
				t: [
					{ seq: 0, name: 'sqlite_autoindex_t_1', unique: 1, origin: 'u', partial: 0 },
				],
			}),
			indexInfo: Object.assign(Object.create(null), {
				sqlite_autoindex_t_1: [
					{ seqno: 0, cid: 1, name: 'v' },
				],
			}),
			foreignKeys: Object.create(null),
		};

		const snapshot = snapshotFromIntrospection(input);
		const uc = Object.values(snapshot.tables['t']?.uniqueConstraints ?? {})[0];
		// Plain string (no collate) — not a `{ name, collate }` object.
		expect(uc?.columns).toEqual(['v']);
	});
});

describe('[F-127] PK clause member name as a string literal', () => {
	it('recovers autoincrement from a single-quoted member in the PK clause', () => {
		const input: IntrospectionInput = {
			master: [
				{
					type: 'table',
					name: 't',
					tbl_name: 't',
					sql: `create table "t" ("a" integer, "v" text, primary key ('a' autoincrement))`,
				},
			],
			tableInfo: Object.assign(Object.create(null), {
				t: [
					{ cid: 0, name: 'a', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
					{ cid: 1, name: 'v', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
				],
			}),
			indexList: Object.create(null),
			indexInfo: Object.create(null),
			foreignKeys: Object.create(null),
		};

		const snapshot = snapshotFromIntrospection(input);
		const col = snapshot.tables['t']?.columns['a'];
		expect(col?.autoincrement).toBe(true);
	});

	it('recovers a composite PK member name spelled as a string literal', () => {
		const input: IntrospectionInput = {
			master: [
				{
					type: 'table',
					name: 't',
					tbl_name: 't',
					sql: `create table "t" ("a" text, "b" text, primary key ('a', 'b'))`,
				},
			],
			tableInfo: Object.assign(Object.create(null), {
				t: [
					{ cid: 0, name: 'a', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
					{ cid: 1, name: 'b', type: 'TEXT', notnull: 0, dflt_value: null, pk: 2 },
				],
			}),
			indexList: Object.create(null),
			indexInfo: Object.create(null),
			foreignKeys: Object.create(null),
		};

		const snapshot = snapshotFromIntrospection(input);
		const cpk = Object.values(snapshot.tables['t']?.compositePrimaryKeys ?? {})[0];
		expect(cpk?.columns.map((c: any) => typeof c === 'string' ? c : c.name)).toEqual(['a', 'b']);
	});
});
