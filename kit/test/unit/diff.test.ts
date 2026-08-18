import { blob, check, customType, foreignKey, index, integer, numeric, primaryKey, real, sql, sqliteTable, text, unique, uniqueIndex } from 'orm-d1';
import { appendOnlyTrigger, tableOptions, validateTableOptions } from 'orm-d1/ddl';
import type { Column } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { carryForwardCollations, diffSnapshots, renderMigration } from '../../src/core/diff.js';
import { applicableStatements, splitStatements } from '../../src/core/sql.js';
import { appendOnlyTriggerGuard, hasAutoincrement, isAppendOnlyTrigger, parseChecks, parseColumnCollation, parseGenerated, parseTableOptions } from '../../src/core/introspect.js';
import { assertRoundTrip, canonicalTable, emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';
import { roundtripPlan } from '../../src/core/roundtrip.js';

const indexOn = (name: string, column: Column<any>) => index(name).on(column);

const snapshotOf = (...tables: Parameters<typeof snapshotFromSchema>[0] extends infer _ ? any[] : never): Snapshot =>
	snapshotFromSchema(tables);

describe('parsing a CREATE TABLE', () => {
	it('reads a generated expression containing parentheses, and the mode after it', () => {
		const sql = 'create table "t" ("name" text, "shout" text generated always as (upper("name")) stored)';

		// `[^)]*` stopped at the first `)`, so the expression came back truncated
		// and the trailing `stored` was never seen — silently downgrading it to
		// virtual, which is a different column.
		expect(parseGenerated(sql, 'shout')).toEqual({ as: 'upper("name")', mode: 'stored' });
	});

	it('defaults to virtual when no storage is written, as SQLite does', () => {
		const sql = 'create table "t" ("a" integer, "b" integer generated always as ("a" + 1))';
		expect(parseGenerated(sql, 'b')).toEqual({ as: '"a" + 1', mode: 'virtual' });
	});

	it('treats a column name as data, not as a pattern', () => {
		// `a(` is a legal SQLite identifier and used to throw "Unterminated group".
		const sql = 'create table "t" ("a(" integer primary key autoincrement)';
		expect(() => hasAutoincrement(sql, 'a(')).not.toThrow();
		expect(hasAutoincrement(sql, 'a(')).toBe(true);
		expect(parseGenerated(sql, 'a(')).toBeUndefined();
	});

	it('does not attribute a table-level UNIQUE clause\'s COLLATE to the column itself', () => {
		// `unique ("email" collate nocase)` is the standard idiom for
		// case-insensitive email uniqueness — the indexed-column grammar SQLite
		// allows `COLLATE` on in a `unique (…)`, `primary key (…)`, or
		// `check (…)` clause, not just on the column definition. `[^,]*?` used to
		// keep scanning right past the column definition's own end and pick up
		// this one instead, reporting a collation the column does not have.
		const sql = 'create table "u1" ("id" integer primary key, "email" text not null, unique ("email" collate nocase))';
		expect(parseColumnCollation(sql, 'email')).toBeUndefined();
	});

	it('does not attribute a table-level CHECK clause\'s COLLATE to the column it names', () => {
		const sql = 'create table "u2" ("a" text, "b" text, check ("a" = "b" collate nocase))';
		expect(parseColumnCollation(sql, 'a')).toBeUndefined();
		expect(parseColumnCollation(sql, 'b')).toBeUndefined();
	});

	it('still finds a genuine column COLLATE that comes before a comma inside a function call', () => {
		// The mirror false negative: `[^,]*?` stopped at the first comma it saw
		// at all, including one nested inside `substr(...)`, so a collation
		// stated *after* such a call on the column's own definition was missed.
		const sql = 'create table "u3" ("id" integer primary key, '
			+ '"email" text check (substr("email", 1, 1) <> \'@\') collate nocase not null)';
		expect(parseColumnCollation(sql, 'email')).toBe('nocase');
	});

	it('still finds an ordinary column-level COLLATE', () => {
		const sql = 'create table "u4" ("id" integer primary key, "email" text collate nocase not null)';
		expect(parseColumnCollation(sql, 'email')).toBe('nocase');
	});

	it('[F-106] does not attribute a COLLATE inside a column-level CHECK to the column itself', () => {
		// The whole sub-expression sits inside the `check (...)`'s own
		// parentheses — depth >= 1 from the column definition's point of view —
		// so it is not the column's own COLLATE, unlike the test above where
		// `collate nocase` comes back out to depth 0 after the check closes.
		const sql = 'create table "q" ("id" integer primary key, "status" text not null '
			+ 'constraint "q_check_1" check ("status" collate nocase in (\'active\',\'closed\')))';
		expect(parseColumnCollation(sql, 'status')).toBeUndefined();
	});

	it('[F-106] does not attribute a COLLATE inside a generated column\'s expression to the column itself', () => {
		const sql = 'create table "g" ("a" text, "b" integer generated always as ("a" collate nocase = \'x\') virtual)';
		expect(parseColumnCollation(sql, 'b')).toBeUndefined();
	});

	it('[F-108] a quoted identifier containing "(" does not desynchronise the depth counter', () => {
		const sql = 'create table "t" ("a(" text, "b" text generated always as ("a(" || \'x\') virtual, '
			+ '"email" text not null, unique ("email" collate nocase))';
		// Used to run to end-of-string and swallow the table-level unique(...).
		expect(parseColumnCollation(sql, 'b')).toBeUndefined();
		expect(parseColumnCollation(sql, 'email')).toBeUndefined();
	});

	it('[F-108] parses a quoted collation name', () => {
		const sql = 'create table "u5" ("id" integer primary key, "email" text collate "NOCASE" not null)';
		expect(parseColumnCollation(sql, 'email')).toBe('NOCASE');
	});

	it('parses a collation name spelled as a string literal — SQLite\'s grammar accepts '
		+ 'a STRING wherever an ids (name) is expected, so "collate \'nocase\'" is real and enforced', () => {
		const sql = 'create table "u6" ("id" integer primary key, "email" text collate \'nocase\' not null)';
		expect(parseColumnCollation(sql, 'email')).toBe('nocase');
	});

	it('a string literal elsewhere in the column span is not misread as a string-literal collation '
		+ '([F-069]\'s class: the literal\'s contents can spell the word "collate")', () => {
		const sql = 'create table "u7" ("id" integer primary key, '
			+ '"note" text default \' collate nocase \' collate binary not null)';
		expect(parseColumnCollation(sql, 'note')).toBe('binary');
	});

	it('does not read a COLLATE mentioned only in a "--" comment as the column\'s own', () => {
		const sql = 'create table "c1" ("id" integer primary key, '
			+ '"note" text -- TODO: collate nocase before launch\n\tnot null)';
		expect(parseColumnCollation(sql, 'note')).toBeUndefined();
	});

	it('does not read a COLLATE mentioned only in a "/* */" comment as the column\'s own', () => {
		const sql = 'create table "c1" ("id" integer primary key, "note" text /* TODO: collate nocase */ not null)';
		expect(parseColumnCollation(sql, 'note')).toBeUndefined();
	});

	it('an unbalanced "(" inside a "--" comment does not desynchronise the depth counter', () => {
		const sql = 'create table "c1" ("id" integer primary key, '
			+ '"note" text -- legacy (was varchar\n\tcollate nocase)';
		expect(parseColumnCollation(sql, 'note')).toBe('nocase');
	});

	it('a stray \'"\' inside a "--" comment does not swallow the rest of the column span', () => {
		const sql = 'create table "c1" ("id" integer primary key, '
			+ '"note" text -- see the "spec\n\t\tcollate nocase not null)';
		expect(parseColumnCollation(sql, 'note')).toBe('nocase');
	});

	it('a backtick-quoted identifier containing "(" does not desynchronise the depth counter', () => {
		const sql = 'create table "t" (`a(` text, "note" text check (`x(` <> \'\') collate nocase)';
		expect(parseColumnCollation(sql, 'note')).toBe('nocase');
	});

	it('a bracket-quoted identifier containing "(" does not desynchronise the depth counter', () => {
		const sql = 'create table "t" ([a(] text, "note" text check ([x(] <> \'\') collate nocase)';
		expect(parseColumnCollation(sql, 'note')).toBe('nocase');
	});

	it('[F-108 in parseGenerated] a quoted identifier containing "(" inside another column does not '
		+ 'swallow the rest of the table body into the generated expression', () => {
		const sql = 'create table "t" ("a(" text, "b" text generated always as ("a(" || \'x\') virtual, '
			+ '"email" text not null, unique ("email" collate nocase)) virtual';
		expect(parseGenerated(sql, 'b')).toEqual({ as: '"a(" || \'x\'', mode: 'virtual' });
	});
});

describe('diffing snapshots', () => {
	it('creates a table and its indexes from nothing', () => {
		const t = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const { statements, errors } = diffSnapshots(emptySnapshot(), snapshotOf(t));

		expect(errors).toEqual([]);
		expect(statements.map((s) => s.sql)).toEqual([
			'create table "users" (\n\t"id" integer primary key not null,\n\t"email" text not null\n)',
			'create unique index "users_email_idx" on "users" ("email")',
		]);
		expect(statements.every((s) => !s.destructive)).toBe(true);
	});

	it('renders an expression index member unquoted, not as a string literal', () => {
		// Regression: every `columns` entry used to be wrapped in `quote()`
		// unconditionally, so `index(...).on(sql\`lower(${t.email})\`)` rendered
		// as `("lower(""email"")")` — an index on the constant string, not the
		// expression. For a `uniqueIndex` that silently limited the table to one
		// row.
		const t = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [index('users_lower_email_idx').on(sql`lower(${c.email})`)]);

		const { statements } = diffSnapshots(emptySnapshot(), snapshotOf(t));
		const createIndex = statements.map((s) => s.sql).find((s) => s.includes('create index'));

		expect(createIndex).toContain('(lower("email"))');
		expect(createIndex).not.toContain('("lower(""email"")")');
	});

	it('does not report drift for an expression index whose whitespace differs from the schema', () => {
		// `canonicalIndex` already normalises `where`'s whitespace because
		// SQLite hands a partial index's predicate back with its own spacing.
		// An expression *member* goes through `sqlite_master`'s verbatim
		// `CREATE INDEX` text the same way, so a hand-written
		// `lower( "a" )` in the database against `lower("a")` in the schema
		// must compare equal too, not report a permanent drop/create.
		const t = sqliteTable('spaced', {
			id: integer('id').primaryKey(),
			a: text('a').notNull(),
		}, (c) => [index('spaced_lower_a_idx').on(sql`lower(${c.a})`)]);
		const schemaSide = snapshotOf(t);
		const liveSide: Snapshot = {
			...schemaSide,
			origin: 'introspection',
			tables: {
				spaced: {
					...schemaSide.tables['spaced']!,
					indexes: {
						...schemaSide.tables['spaced']!.indexes,
						spaced_lower_a_idx: {
							...schemaSide.tables['spaced']!.indexes['spaced_lower_a_idx']!,
							columns: [{ expression: 'lower( "a" )', isExpression: true }],
						},
					},
				},
			},
		};

		expect(diffSnapshots(liveSide, schemaSide).statements).toEqual([]);
	});

	it('reads an old-shape index snapshot (plain string columns) without reporting drift', () => {
		// Before `IndexColumnSnapshot`, `columns` was `readonly string[]`.
		// A snapshot on disk from before this change still has that shape, and
		// reading it must not itself look like the index changed.
		const t = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const fresh = snapshotOf(t);
		const oldShape: Snapshot = {
			...fresh,
			tables: {
				users: {
					...fresh.tables['users']!,
					indexes: {
						users_email_idx: {
							...fresh.tables['users']!.indexes['users_email_idx']!,
							columns: ['email'],
						},
					},
				},
			},
		};

		expect(diffSnapshots(oldShape, fresh).statements).toEqual([]);
		expect(diffSnapshots(fresh, oldShape).statements).toEqual([]);
	});

	it('reads a pre-desc/collate index snapshot without reporting drift against an equivalent fresh one', () => {
		// Before `desc`/`collate` existed on `IndexColumnSnapshot`, an
		// unqualified index member had neither field at all — not `desc: false`
		// or `collate: undefined`, just absent. A live database introspected
		// after this change reports that same ordinary column exactly the same
		// way (still no `desc`/`collate`, since neither applies to it), so the
		// two must diff as identical.
		const t = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const fresh = snapshotOf(t);
		const preDescCollate: Snapshot = {
			...fresh,
			tables: {
				users: {
					...fresh.tables['users']!,
					indexes: {
						users_email_idx: {
							...fresh.tables['users']!.indexes['users_email_idx']!,
							columns: [{ expression: 'email', isExpression: false }],
						},
					},
				},
			},
		};

		expect(diffSnapshots(preDescCollate, fresh).statements).toEqual([]);
		expect(diffSnapshots(fresh, preDescCollate).statements).toEqual([]);
	});

	it('does not force a destructive recreate for a live non-BINARY column collation the schema DSL cannot express (F-101)', () => {
		// A table pulled from a live DB with `email text collate nocase` gets
		// `collate: 'nocase'` on that column in the introspected snapshot. The
		// schema DSL has no `.collate()`, so every schema-derived snapshot of
		// the same table has `collate: undefined` on `email` forever. Diffing
		// the two must not read that as "changed to binary" and force a
		// destructive drop+recreate on the very first `generate` after `pull`.
		const t = sqliteTable('people', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		});
		const schemaSide = snapshotOf(t);
		const liveSide: Snapshot = {
			...schemaSide,
			origin: 'introspection',
			tables: {
				people: {
					...schemaSide.tables['people']!,
					columns: {
						...schemaSide.tables['people']!.columns,
						email: { ...schemaSide.tables['people']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		const { statements } = diffSnapshots(liveSide, schemaSide);
		expect(statements).toEqual([]);
	});

	it('still reports a genuine collation mismatch between two stated values', () => {
		// The exemption is one-directional: a real value on the schema side that
		// genuinely differs from the live database's real value must still be
		// caught, so this is not a blanket "ignore collate" escape hatch.
		const t = sqliteTable('people', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		});
		const base = snapshotOf(t);
		const before: Snapshot = {
			...base,
			origin: 'introspection',
			tables: {
				people: {
					...base.tables['people']!,
					columns: {
						...base.tables['people']!.columns,
						email: { ...base.tables['people']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};
		const after: Snapshot = {
			...base,
			origin: 'introspection',
			tables: {
				people: {
					...base.tables['people']!,
					columns: {
						...base.tables['people']!.columns,
						email: { ...base.tables['people']!.columns['email']!, collate: 'rtrim' },
					},
				},
			},
		};

		const { statements } = diffSnapshots(before, after);
		expect(statements.some((s) => s.reason?.includes('collation'))).toBe(true);
	});

	it('carries a live collation into a rebuild the schema DSL cannot state, instead of dropping it (F-101 follow-up)', () => {
		// A rebuild forced for an unrelated reason (here: `id` changes type) must
		// not read `columnDifference`'s "unstated = unchanged" exemption as
		// license to render the rebuilt table without the collation: the
		// rebuild reads `after`, which structurally never carries one, so
		// rendering `after` as-is silently turned a `uniqueIndex` over a
		// case-insensitive column into one over a BINARY column — nothing
		// failed, `alice@x.com` and `Alice@x.com` just both became insertable.
		const before = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);
		const after = sqliteTable('users', {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const schemaAfter = snapshotOf(after);
		const liveBefore: Snapshot = {
			...snapshotOf(before),
			origin: 'introspection',
			tables: {
				users: {
					...snapshotOf(before).tables['users']!,
					columns: {
						...snapshotOf(before).tables['users']!.columns,
						email: { ...snapshotOf(before).tables['users']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		const { statements, errors } = diffSnapshots(liveBefore, schemaAfter);
		expect(errors).toEqual([]);

		const createTemp = statements.find((s) => s.sql.includes('create table "__new_users"'));
		expect(createTemp?.sql).toContain('"email" text collate nocase not null');
	});

	it('[F-107] carries a live collation into the snapshot generate persists, not just the rebuilt table body', () => {
		// `recreateTable` above only fixes what the rebuild *renders*. `generate`
		// separately persists the schema-derived `after` snapshot as the new
		// `meta/` baseline, which structurally has no `collate` on any column —
		// so without carrying it forward there too, the very next `generate`
		// reads that baseline, believes the column was always BINARY, and drops
		// the live collation with zero drift ever reported again.
		const t = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

		const schemaAfter = snapshotOf(t);
		const liveBefore: Snapshot = {
			...snapshotOf(t),
			origin: 'introspection',
			tables: {
				users: {
					...snapshotOf(t).tables['users']!,
					columns: {
						...snapshotOf(t).tables['users']!.columns,
						email: { ...snapshotOf(t).tables['users']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		const persisted = carryForwardCollations(liveBefore, schemaAfter);
		expect(persisted.tables['users']!.columns['email']!.collate).toBe('nocase');

		// A second round trip off that persisted baseline must still see it —
		// this is the "second generate drops it silently" scenario.
		const roundTwo = carryForwardCollations(persisted, snapshotOf(t));
		expect(roundTwo.tables['users']!.columns['email']!.collate).toBe('nocase');
	});

	it('does not force a destructive recreate for a live unique-member collation the schema DSL cannot express (F-111 follow-up)', () => {
		// `unique ("email" collate nocase)` is introspected with `collate: 'nocase'`
		// on the constraint's `email` member. The schema DSL has no `.collate()`,
		// so `unique('u1').on(t.email)` can never state one — the same
		// "unexpressible" exemption `columnDifference` already applies to a
		// column's own `collate` must apply here too, or `pull` followed
		// immediately by `generate` forces a needless destructive rebuild.
		const t = sqliteTable('u_members', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);
		const schemaSide = snapshotOf(t);
		const liveSide: Snapshot = {
			...schemaSide,
			origin: 'introspection',
			tables: {
				u_members: {
					...schemaSide.tables['u_members']!,
					uniqueConstraints: {
						...schemaSide.tables['u_members']!.uniqueConstraints,
						u1: {
							...schemaSide.tables['u_members']!.uniqueConstraints['u1']!,
							columns: [{ name: 'email', collate: 'nocase' }],
						},
					},
				},
			},
		};

		expect(diffSnapshots(liveSide, schemaSide).statements).toEqual([]);
	});

	it('still reports a genuine unique-member collation mismatch between two stated values', () => {
		// One-directional, same as the column-level exemption: a real value on
		// both sides that genuinely differs must still be caught.
		const t = sqliteTable('u_members2', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);
		const base = snapshotOf(t);
		const withMember = (collate: string): Snapshot => ({
			...base,
			origin: 'introspection',
			tables: {
				u_members2: {
					...base.tables['u_members2']!,
					uniqueConstraints: {
						...base.tables['u_members2']!.uniqueConstraints,
						u1: {
							...base.tables['u_members2']!.uniqueConstraints['u1']!,
							columns: [{ name: 'email', collate }],
						},
					},
				},
			},
		});

		const { statements } = diffSnapshots(withMember('nocase'), withMember('rtrim'));
		expect(statements.some((s) => s.reason?.includes('unique constraint'))).toBe(true);
	});

	// Finding 3: `canonicalTable`'s primary-key fingerprint used to be
	// `JSON.stringify(primaryKeyColumns)` built from bare column *names* only
	// — a composite PK member's own `collate` (`[F-115]`) never made it in,
	// unlike `sameUniques`, which already compares member collations. Two
	// origin:'introspection' snapshots differing only in a composite PK
	// member's collation used to diff to zero statements. Mirrors "still
	// reports a genuine unique-member collation mismatch" just above.
	it('still reports a genuine composite-PK-member collation mismatch between two stated values (Finding 3)', () => {
		const t = sqliteTable('memberships3', {
			clubId: text('club_id'),
			userId: text('user_id'),
		}, (c) => [primaryKey({ columns: [c.clubId, c.userId] })]);
		const base = snapshotOf(t);
		const pkName = Object.keys(base.tables['memberships3']!.compositePrimaryKeys)[0]!;
		const withMemberCollate = (collate: string | undefined): Snapshot => ({
			...base,
			origin: 'introspection',
			tables: {
				memberships3: {
					...base.tables['memberships3']!,
					compositePrimaryKeys: {
						...base.tables['memberships3']!.compositePrimaryKeys,
						[pkName]: {
							...base.tables['memberships3']!.compositePrimaryKeys[pkName]!,
							columns: [
								collate ? { name: 'club_id', collate } : 'club_id',
								'user_id',
							],
						},
					},
				},
			},
		});

		// Same shape, no collate on either side: no diff.
		expect(diffSnapshots(withMemberCollate(undefined), withMemberCollate(undefined)).statements).toEqual([]);

		// Differ ONLY in the PK member's collation: must be a non-empty rebuild,
		// not zero statements / zero errors.
		const { statements } = diffSnapshots(withMemberCollate('nocase'), withMemberCollate('rtrim'));
		expect(statements.length).toBeGreaterThan(0);
		expect(statements.some((s) => s.reason?.includes('primary key'))).toBe(true);
	});

	// `carryForwardCollations`'s `carryForwardPrimaryKeyCollation` (`diff.ts`)
	// persists a live composite-PK member's `collate` into the snapshot
	// `generate` writes as its new baseline — the same role
	// `carryForwardUniqueCollation` plays for a unique constraint member
	// (tested just above and at "[F-115] persists a live unique-member
	// collation..." below). These cover the shapes that function's own doc
	// comment calls out: a table+column rename, a donor with no matching
	// target, a target with no matching donor, and a PK sharing its column
	// list with a unique constraint (proving the two are not confused).
	describe('carryForwardPrimaryKeyCollation (via carryForwardCollations)', () => {
		const withPkCollate = (
			tableName: string,
			columns: readonly string[],
			collateFirst: string | undefined,
		): Snapshot => {
			const t = sqliteTable(
				tableName,
				Object.fromEntries(columns.map((c) => [c, text(c)])),
				(cols) => [primaryKey({ columns: Object.values(cols) })],
			);
			const snap = snapshotOf(t);
			const table = snap.tables[tableName]!;
			const pkName = Object.keys(table.compositePrimaryKeys)[0]!;
			const pk = table.compositePrimaryKeys[pkName]!;
			return {
				...snap,
				origin: 'introspection',
				tables: {
					...snap.tables,
					[tableName]: {
						...table,
						compositePrimaryKeys: {
							...table.compositePrimaryKeys,
							[pkName]: {
								...pk,
								columns: pk.columns.map((c, i) => (
									i === 0 && collateFirst
										? { name: typeof c === 'string' ? c : c.name, collate: collateFirst }
										: c
								)),
							},
						},
					},
				},
			};
		};

		it('carries the member collation across both a table rename and a column rename', () => {
			const live = withPkCollate('members_live', ['club_id', 'user_id'], 'nocase');
			const schemaAfter = snapshotOf(
				sqliteTable('memberships', {
					clubId: text('club_id'),
					userId: text('user_id'),
				}, (c) => [primaryKey({ columns: [c.clubId, c.userId] })]),
			);

			const persisted = carryForwardCollations(live, schemaAfter, {
				renamedTables: { members_live: 'memberships' },
				renamedColumns: { 'memberships.club_id': 'club_id' },
			});
			const pk = Object.values(persisted.tables['memberships']!.compositePrimaryKeys)[0]!;
			expect(pk.columns[0]).toEqual({ name: 'club_id', collate: 'nocase' });
		});

		it('is a no-op when the donor table has no matching entry in `after` (table dropped)', () => {
			const live = withPkCollate('gone', ['a', 'b'], 'nocase');
			const after: Snapshot = { ...live, origin: 'schema', tables: {} };
			expect(() => carryForwardCollations(live, after)).not.toThrow();
			expect(carryForwardCollations(live, after)).toEqual(after);
		});

		it('is a no-op when `after` has a matching table but no compositePrimaryKeys entry (donor member list does not match)', () => {
			const live = withPkCollate('reshaped', ['a', 'b'], 'nocase');
			// `after` is schema-derived with a *single*-column PK on `a` only — no
			// arity-2 `compositePrimaryKeys` entry for `carryForwardPrimaryKeyCollation`
			// to match against, so it must leave `after` untouched rather than throw
			// or fabricate an entry.
			const after = snapshotOf(sqliteTable('reshaped', { a: text('a').primaryKey(), b: text('b') }));
			const persisted = carryForwardCollations(live, after);
			expect(Object.keys(persisted.tables['reshaped']!.compositePrimaryKeys)).toHaveLength(0);
		});

		it('does not confuse a primary key with a unique constraint sharing the same column list', () => {
			// Live: `(club_id, user_id)` is both the PK (collated) and, separately,
			// carries a plain unique constraint over the same two columns. Only the
			// PK member's collation must carry forward onto `after`'s PK — the
			// unique constraint is untouched by this path.
			const live = withPkCollate('dual', ['club_id', 'user_id'], 'nocase');
			const liveTable = live.tables['dual']!;
			const liveWithUnique: Snapshot = {
				...live,
				tables: {
					...live.tables,
					dual: {
						...liveTable,
						uniqueConstraints: {
							dual_u1: { name: 'dual_u1', columns: ['club_id', 'user_id'] },
						},
					},
				},
			};
			const schemaAfter = snapshotOf(
				sqliteTable('dual', {
					clubId: text('club_id'),
					userId: text('user_id'),
				}, (c) => [primaryKey({ columns: [c.clubId, c.userId] }), unique('dual_u1').on(c.clubId, c.userId)]),
			);

			const persisted = carryForwardCollations(liveWithUnique, schemaAfter);
			const pk = Object.values(persisted.tables['dual']!.compositePrimaryKeys)[0]!;
			expect(pk.columns[0]).toEqual({ name: 'club_id', collate: 'nocase' });
			const uq = Object.values(persisted.tables['dual']!.uniqueConstraints)[0]!;
			expect(uq.columns).toEqual(['club_id', 'user_id']);
		});
	});

	// Finding 4: `pragma index_list` reports SQLite's automatic unique indexes
	// in reverse creation order, so a schema-derived canonical table and an
	// introspected one — or the same live table introspected twice around an
	// unrelated rebuild — can disagree on `CanonicalTable.uniques`' array
	// order despite being semantically identical. `sameUniques`'s own
	// multiset match never cared, but `canonicalTable`'s output is deep-
	// compared order-sensitively elsewhere (`kit/test/workers/fuzz.test.ts`'s
	// `comparable()`), so the array itself needs a deterministic order.
	it('orders `uniques` deterministically regardless of declaration/introspection order (Finding 4)', () => {
		const t = sqliteTable('multi_unique', {
			id: integer('id').primaryKey(),
			a: text('a').notNull(),
			b: text('b').notNull(),
		}, (c) => [unique('u_a').on(c.a), unique('u_b').on(c.b)]);
		const forward = snapshotOf(t).tables['multi_unique']!;

		// Same table, same constraints, only the `Record`'s insertion order
		// reversed — exactly what a live table introspected before vs. after an
		// unrelated rebuild can produce.
		const entries = Object.entries(forward.uniqueConstraints);
		const reversed = {
			...forward,
			uniqueConstraints: Object.fromEntries(entries.slice().reverse()),
		};

		expect(canonicalTable(reversed).uniques).toEqual(canonicalTable(forward).uniques);
	});

	it('carries a live unique-member collation into a rebuild forced for an unrelated reason (F-111 follow-up)', () => {
		// A rebuild forced by, say, an `id` type change must not render the
		// after-side unique constraint as-is: `after` structurally never states
		// a member `collate`, so doing that would silently turn a
		// case-insensitive unique constraint into a BINARY one the moment
		// anything else about the table forces a recreate.
		const before = sqliteTable('u_rebuild', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);
		const after = sqliteTable('u_rebuild', {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);

		const schemaAfter = snapshotOf(after);
		const schemaBefore = snapshotOf(before);
		const liveBefore: Snapshot = {
			...schemaBefore,
			origin: 'introspection',
			tables: {
				u_rebuild: {
					...schemaBefore.tables['u_rebuild']!,
					uniqueConstraints: {
						...schemaBefore.tables['u_rebuild']!.uniqueConstraints,
						u1: {
							...schemaBefore.tables['u_rebuild']!.uniqueConstraints['u1']!,
							columns: [{ name: 'email', collate: 'nocase' }],
						},
					},
				},
			},
		};

		const { statements, errors } = diffSnapshots(liveBefore, schemaAfter);
		expect(errors).toEqual([]);

		const createTemp = statements.find((s) => s.sql.includes('create table "__new_u_rebuild"'));
		expect(createTemp?.sql).toContain('unique ("email" collate nocase)');
	});

	it('[F-115] persists a live unique-member collation into the snapshot `generate` writes as its new baseline', () => {
		// The unique-constraint analogue of the `[F-107]` test above:
		// `carryForwardCollations` carried a plain column's `collate` into the
		// persisted baseline but never a unique constraint member's — so the
		// baseline `generate` writes to `meta/` already lost it, even though
		// the *migration SQL* that same `generate` run emits is correct (it
		// reads straight from `before`, via `carryForwardUniqueCollation`
		// inside `recreateTable`, not from this persisted copy). The next
		// `generate` then reads that broken baseline and re-renders the
		// constraint with no collation at all — zero drift reported, because
		// as far as the diff is concerned nothing changed.
		const t = sqliteTable('members', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique('u1').on(c.email)]);

		const schemaAfter = snapshotOf(t);
		const liveBefore: Snapshot = {
			...schemaAfter,
			origin: 'introspection',
			tables: {
				members: {
					...schemaAfter.tables['members']!,
					uniqueConstraints: {
						...schemaAfter.tables['members']!.uniqueConstraints,
						u1: {
							...schemaAfter.tables['members']!.uniqueConstraints['u1']!,
							columns: [{ name: 'email', collate: 'nocase' }],
						},
					},
				},
			},
		};

		const persisted = carryForwardCollations(liveBefore, schemaAfter);
		const persistedMember = persisted.tables['members']!.uniqueConstraints['u1']!.columns[0];
		expect(persistedMember).toEqual({ name: 'email', collate: 'nocase' });

		// A second round trip off that persisted baseline must still see it.
		const roundTwo = carryForwardCollations(persisted, snapshotOf(t));
		const roundTwoMember = roundTwo.tables['members']!.uniqueConstraints['u1']!.columns[0];
		expect(roundTwoMember).toEqual({ name: 'email', collate: 'nocase' });
	});

	it('does not merge two distinct unique constraints that share the same column list (F-115 sibling fix)', () => {
		// Two different `before` unique constraints on the same ordered column
		// list, each with its *own* per-member collation. Before the fix,
		// `carryForwardUniqueCollation`'s inner loop matched — and kept
		// re-matching — the first `after` entry with that column list for
		// every `before` constraint, so the second `before`'s collation was
		// deposited onto the *same* already-claimed `after` entry: a
		// fabricated, merged constraint that neither live table actually had.
		const before = sqliteTable('u_pair', {
			a: text('a').notNull(),
			b: text('b').notNull(),
			n: text('n'),
		}, (c) => [unique('u1').on(c.a, c.b), unique('u2').on(c.a, c.b)]);
		const after = sqliteTable('u_pair', {
			a: text('a').notNull(),
			b: text('b').notNull(),
			n: integer('n'), // unrelated change, forces a rebuild
		}, (c) => [unique('u1').on(c.a, c.b), unique('u2').on(c.a, c.b)]);

		const schemaBefore = snapshotOf(before);
		const schemaAfter = snapshotOf(after);
		const liveBefore: Snapshot = {
			...schemaBefore,
			origin: 'introspection',
			tables: {
				u_pair: {
					...schemaBefore.tables['u_pair']!,
					uniqueConstraints: {
						u1: {
							...schemaBefore.tables['u_pair']!.uniqueConstraints['u1']!,
							columns: ['a', { name: 'b', collate: 'nocase' }],
						},
						u2: {
							...schemaBefore.tables['u_pair']!.uniqueConstraints['u2']!,
							columns: [{ name: 'a', collate: 'rtrim' }, 'b'],
						},
					},
				},
			},
		};

		const { statements, errors } = diffSnapshots(liveBefore, schemaAfter);
		expect(errors).toEqual([]);

		const createTemp = statements.find((s) => s.sql.includes('create table "__new_u_pair"'));
		expect(createTemp?.sql).toContain('constraint "u1" unique ("a", "b" collate nocase)');
		expect(createTemp?.sql).toContain('constraint "u2" unique ("a" collate rtrim, "b")');
	});

	it('does not silently collapse two single-member unique constraints on the same column into one (F-115 sibling fix)', () => {
		// The one-member variant of the sibling test above: `unique(a) collate
		// nocase` and `unique(a) collate rtrim` sharing the single-column list
		// `["a"]` used to merge into a single fabricated rule (or silently drop
		// the second one) rather than staying two distinct constraints.
		const before = sqliteTable('u_pair2', {
			a: text('a').notNull(),
			n: text('n'),
		}, (c) => [unique('u1').on(c.a), unique('u2').on(c.a)]);
		const after = sqliteTable('u_pair2', {
			a: text('a').notNull(),
			n: integer('n'),
		}, (c) => [unique('u1').on(c.a), unique('u2').on(c.a)]);

		const schemaBefore = snapshotOf(before);
		const schemaAfter = snapshotOf(after);
		const liveBefore: Snapshot = {
			...schemaBefore,
			origin: 'introspection',
			tables: {
				u_pair2: {
					...schemaBefore.tables['u_pair2']!,
					uniqueConstraints: {
						u1: {
							...schemaBefore.tables['u_pair2']!.uniqueConstraints['u1']!,
							columns: [{ name: 'a', collate: 'nocase' }],
						},
						u2: {
							...schemaBefore.tables['u_pair2']!.uniqueConstraints['u2']!,
							columns: [{ name: 'a', collate: 'rtrim' }],
						},
					},
				},
			},
		};

		const { statements, errors } = diffSnapshots(liveBefore, schemaAfter);
		expect(errors).toEqual([]);

		const createTemp = statements.find((s) => s.sql.includes('create table "__new_u_pair2"'));
		expect(createTemp?.sql).toContain('constraint "u1" unique ("a" collate nocase)');
		expect(createTemp?.sql).toContain('constraint "u2" unique ("a" collate rtrim)');
	});

	it('detects introspection-to-introspection collation drift instead of exempting it (F-101 follow-up)', () => {
		// Right after `pull`, both sides of `check` are `origin: 'introspection'`
		// — `undefined` there genuinely means BINARY, not "the schema DSL cannot
		// say". Keying the exemption on `b.collate === undefined` alone (rather
		// than on `after.origin`) hid a hand-rebuilt production table gaining a
		// real collation the pulled baseline never had.
		const t = sqliteTable('people', {
			id: integer('id').primaryKey(),
			email: text('email').notNull(),
		});
		const base = snapshotOf(t);
		const pulledBaseline: Snapshot = { ...base, origin: 'introspection' };
		const liveWithHandAddedCollation: Snapshot = {
			...base,
			origin: 'introspection',
			tables: {
				people: {
					...base.tables['people']!,
					columns: {
						...base.tables['people']!.columns,
						email: { ...base.tables['people']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		const { statements } = diffSnapshots(liveWithHandAddedCollation, pulledBaseline);
		expect(statements.some((s) => s.reason?.includes('collation'))).toBe(true);
	});

	it("[roundtrip] a restore leg keeps the live collation legs 1 and 2 preserve, not just the detach/rebuild pair", () => {
		// `roundtripPlan`'s restore legs merge a restored table straight out of
		// the schema-derived `after` snapshot, which structurally cannot state a
		// `collate` (Drizzle has no `.collate()`). Legs 1 and 2 diff against
		// `detachedBefore`/`detachedAfter`, which still carry the live collation
		// forward from `before`, so only a restore leg (3+) can lose it.
		//
		// `rt_orgs` is the roundtrip target; `rt_users` (which points at it, and
		// carries a live `collate` on a column unrelated to the FK) sits in its
		// closure, so leg 3 has to rebuild `rt_users` to put its foreign key
		// back.
		const orgs = sqliteTable('rt_orgs', {
			id: integer('id').primaryKey(),
			name: text('name').notNull(),
		});
		const users = sqliteTable('rt_users', {
			id: integer('id').primaryKey(),
			orgId: integer('org_id').notNull().references(() => orgs.id),
			email: text('email').notNull(),
		});

		const after = snapshotOf(orgs, users);
		const before: Snapshot = {
			...after,
			origin: 'introspection',
			tables: {
				...after.tables,
				rt_users: {
					...after.tables['rt_users']!,
					columns: {
						...after.tables['rt_users']!.columns,
						email: { ...after.tables['rt_users']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		const plan = roundtripPlan(before, after, 'rt_orgs');
		const restoreLeg = plan.legs.find((leg) => leg.title.startsWith('3.'));
		expect(restoreLeg).toBeDefined();
		expect(restoreLeg!.errors).toEqual([]);
		expect(restoreLeg!.statements.some((s) => /collate\s+nocase/i.test(s.sql))).toBe(true);
	});

	it('drops a removed table, and marks it destructive', () => {
		const t = sqliteTable('gone', { id: integer('id').primaryKey() });
		const { statements } = diffSnapshots(snapshotOf(t), emptySnapshot());

		expect(statements).toEqual([{
			sql: 'drop table "gone"',
			destructive: true,
			reason: 'table "gone" was removed from the schema',
		}]);
	});

	it('drops tables children first, the reverse of creation order', () => {
		const parent = sqliteTable('parent', { id: integer('id').primaryKey() });
		const child = sqliteTable('child', {
			id: integer('id').primaryKey(),
			parentId: integer('parent_id').references(() => parent.id),
		});

		// Declared parent-first, so the naive order would drop it while the
		// child's foreign key still points at it — which D1 enforces.
		const { statements } = diffSnapshots(snapshotOf(parent, child), emptySnapshot());

		expect(statements.map((s) => s.sql)).toEqual(['drop table "child"', 'drop table "parent"']);
	});

	it('refuses to drop a table a surviving one still references', () => {
		const parent = sqliteTable('parent', { id: integer('id').primaryKey() });
		const child = sqliteTable('child', {
			id: integer('id').primaryKey(),
			parentId: integer('parent_id').references(() => parent.id),
		});

		// `child` stays, `parent` goes. Ordering the drops cannot help here, and
		// D1 enforces the foreign key — the statement would fail on apply and
		// take the whole atomic migration with it.
		const { statements, errors } = diffSnapshots(snapshotOf(parent, child), snapshotOf(child));

		expect(statements.map((s) => s.sql)).not.toContain('drop table "parent"');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/"child" still references it/);
	});

	it('never drops a leftover "__new_X" from an interrupted rebuild, but warns about it by name (gap 3)', () => {
		const orders = sqliteTable('orders', { id: integer('id').primaryKey() });
		// Stands in for a live database left with both the original table and an
		// uncommitted-rename leftover from a split rebuild that never made it
		// past `alter table "__new_orders" rename to "orders"`.
		const leftover = sqliteTable('__new_orders', { id: integer('id').primaryKey() });

		const { statements, errors, warnings } = diffSnapshots(snapshotOf(orders, leftover), snapshotOf(orders));

		expect(errors).toEqual([]);
		expect(statements.map((s) => s.sql)).not.toContain('drop table "__new_orders"');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/"__new_orders"/);
		expect(warnings[0]).toMatch(/"orders"/);
	});

	it('adds a nullable column in place', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey() });
		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			name: text('name'),
		});

		expect(diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql))
			.toEqual(['alter table "users" add column "name" text']);
	});

	it('adds a NOT NULL column with a default in place', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey() });
		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role').notNull().default('member'),
		});

		expect(diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql))
			.toEqual([`alter table "users" add column "role" text not null default 'member'`]);
	});

	it('refuses a NOT NULL column with no default, rather than emitting SQL that fails on apply', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey() });
		const after = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role').notNull(),
		});

		const { errors } = diffSnapshots(snapshotOf(before), snapshotOf(after));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/cannot be backfilled/);
	});

	it('[F-109] renders a COLLATE on an ADD COLUMN, not just on a fresh CREATE TABLE', () => {
		// Unreachable through `generate`/`push`/`verify` today — the schema DSL
		// has no `.collate()`, so a schema-derived `after` never states one on a
		// newly added column — but `check`'s printed drift can still construct
		// this pair directly (an `after` built from a hand-edited/introspected
		// snapshot), and `columnDefinition` silently dropped it.
		const before = sqliteTable('users', { id: integer('id').primaryKey() });
		const afterSnapshot = snapshotOf(sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
		}));

		const withCollate: Snapshot = {
			...afterSnapshot,
			tables: {
				users: {
					...afterSnapshot.tables['users']!,
					columns: {
						...afterSnapshot.tables['users']!.columns,
						email: { ...afterSnapshot.tables['users']!.columns['email']!, collate: 'nocase' },
					},
				},
			},
		};

		expect(diffSnapshots(snapshotOf(before), withCollate).statements.map((s) => s.sql))
			.toEqual(['alter table "users" add column "email" text collate nocase']);
	});

	it('recreates rather than ALTERing for a non-constant default, which ADD COLUMN rejects', () => {
		const before = sqliteTable('events', { id: integer('id').primaryKey() });
		const after = sqliteTable('events', {
			id: integer('id').primaryKey(),
			at: integer('at').default(sql`(unixepoch())`),
		});

		const { statements, errors } = diffSnapshots(snapshotOf(before), snapshotOf(after));
		expect(errors).toEqual([]);
		expect(statements.map((s) => s.sql)).not.toContain(
			`alter table "events" add column "at" integer default (unixepoch())`,
		);
		expect(statements.some((s) => s.sql.startsWith('create table'))).toBe(true);
	});

	it('normalises a bare expression default, so it is not mistaken for a constant', () => {
		// `sql`unixepoch()`` — the spelling `pull` used to hand back — reached
		// the snapshot bare, and "does it start with `(`" is how ADD COLUMN's
		// constant check works: the guard was defeated by exactly the input it
		// exists to catch, and emitted `add column … default unixepoch()`,
		// which SQLite rejects.
		const before = sqliteTable('events', { id: integer('id').primaryKey() });
		const after = sqliteTable('events', {
			id: integer('id').primaryKey(),
			at: integer('at').default(sql`unixepoch()`),
		});

		expect(snapshotOf(after).tables.events!.columns.at!.default).toBe('(unixepoch())');

		const { statements, errors } = diffSnapshots(snapshotOf(before), snapshotOf(after));
		expect(errors).toEqual([]);
		expect(statements.every((s) => !s.sql.includes('add column'))).toBe(true);
		expect(statements.some((s) => s.sql.includes('default (unixepoch())'))).toBe(true);
	});

	it('treats an expression default as equal to itself with the parens stripped', () => {
		// CREATE TABLE requires `default (unixepoch())`; `pragma table_info`
		// reports it as `unixepoch()`. The only legal spelling was the one that
		// could not compare equal to itself, so the standard D1 timestamp idiom
		// rebuilt its table destructively on every check and push.
		const schemaSide = snapshotOf(sqliteTable('t', {
			id: integer('id').primaryKey(),
			at: integer('at').default(sql`(unixepoch())`),
		}));
		const liveSide: Snapshot = {
			...schemaSide,
			origin: 'introspection',
			tables: {
				t: {
					...schemaSide.tables['t']!,
					columns: {
						...schemaSide.tables['t']!.columns,
						at: { ...schemaSide.tables['t']!.columns['at']!, default: 'unixepoch()' },
					},
				},
			},
		};

		expect(diffSnapshots(liveSide, schemaSide).statements).toEqual([]);
	});

	it('does not rebuild a customType column just because an old snapshot predates declaredType', () => {
		// `declaredType` was added to `ColumnSnapshot` to keep migration
		// generation and direct DDL generation from disagreeing on a
		// `customType` column's spelling (see the round-trip fixture below). A
		// snapshot written before the field existed simply lacks it — that has
		// to compare equal to a freshly generated one, or every existing
		// `customType` column in every project's snapshot history rebuilds the
		// first time `generate` runs after upgrading.
		const t = sqliteTable('ct2', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'varchar(10)' })('amount'),
			// `'int'` is the case that actually distinguishes the old substring
			// rule from `affinityOf`'s real rules: the old rule's `.find()` over
			// `['integer', 'text', 'real', 'blob', 'numeric']` never matches
			// `'int'` as a substring of any of those five (it's a substring of
			// `'integer'`, not the other way around) and falls back to `'text'`,
			// while `affinityOf('int')` correctly says `'integer'`.
			flag: customType<string>({ dataType: () => 'int' })('flag'),
		});
		const fresh = snapshotOf(t);
		const preExisting: Snapshot = {
			...fresh,
			tables: {
				ct2: {
					...fresh.tables['ct2']!,
					columns: Object.fromEntries(
						Object.entries(fresh.tables['ct2']!.columns).map(([name, column]) => {
							const { declaredType: _declaredType, ...rest } = column;
							return [name, rest];
						}),
					),
				},
			},
		};

		expect(diffSnapshots(preExisting, fresh).statements).toEqual([]);
	});

	it('does not rebuild a genuinely 0.1.3-shaped snapshot whose type disagrees only under the old substring rule', () => {
		// Unlike the test above (which strips `declaredType` from a *freshly
		// computed* snapshot, so `type` was already derived by the new rule),
		// this hand-constructs what an actual pre-upgrade (0.1.3) snapshot
		// looked like: `type` computed by the OLD substring rule
		// (`.find()` over `['integer', 'text', 'real', 'blob', 'numeric']`,
		// `'text'` fallback), no `declaredType` field at all. For
		// `customType(() => 'int')`, the old rule recorded `'text'` (`'int'`
		// matches none of the five candidates as a substring); the current
		// schema's real affinity is `'integer'`. That disagreement must not be
		// reported as a type change.
		const t = sqliteTable('ct_legacy', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'int' })('amount'),
		});
		const fresh = snapshotOf(t);
		const legacy: Snapshot = {
			...fresh,
			tables: {
				ct_legacy: {
					...fresh.tables['ct_legacy']!,
					columns: {
						...fresh.tables['ct_legacy']!.columns,
						amount: {
							...fresh.tables['ct_legacy']!.columns['amount']!,
							type: 'text',
							declaredType: undefined,
						},
					},
				},
			},
		};

		expect(diffSnapshots(legacy, fresh).statements).toEqual([]);
	});

	it('reports real drift between a live TEXT column and a schema customType declaring int', () => {
		// The legacy hatch above only exists to keep a *pre-declaredType*
		// snapshot from looking like drift against itself. Since
		// `snapshotFromIntrospection` now stamps `declaredType` with the raw
		// spelling `table_xinfo` reports (see `kit/src/core/introspect.ts`), a
		// live snapshot always carries one — so a column that is genuinely
		// TEXT in the database, compared against a schema that declares it
		// `customType(() => 'int')`, must still be reported as a type change
		// rather than silently swallowed by the legacy substring rule.
		const schemaSide = snapshotOf(sqliteTable('drift', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'int' })('amount'),
		}));
		const liveSide: Snapshot = {
			...schemaSide,
			origin: 'introspection',
			tables: {
				drift: {
					...schemaSide.tables['drift']!,
					columns: {
						...schemaSide.tables['drift']!.columns,
						amount: { ...schemaSide.tables['drift']!.columns['amount']!, type: 'text', declaredType: 'text' },
					},
				},
			},
		};

		const { statements } = diffSnapshots(liveSide, schemaSide);
		expect(statements.length).toBeGreaterThan(0);
		expect(statements.some((s) => s.reason?.includes('changes type'))).toBe(true);
	});

	it('still reports a genuine type change between two declaredType-carrying snapshots', () => {
		const before = snapshotOf(sqliteTable('ct_changed', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'int' })('amount'),
		}));
		const after = snapshotOf(sqliteTable('ct_changed', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'text' })('amount'),
		}));

		expect(diffSnapshots(before, after).statements.length).toBeGreaterThan(0);
	});

	it('does not rebuild for a single-column table-level primary key', () => {
		// SQLite reports a lone primary key as NOT NULL whether or not it was
		// written that way, so the table-level spelling used to drift forever.
		const inline = snapshotOf(sqliteTable('t', { id: integer('id').primaryKey() }));
		const tableLevel = snapshotOf(
			sqliteTable('t', { id: integer('id') }, (c) => [primaryKey({ columns: [c.id] })]),
		);

		expect(diffSnapshots(inline, tableLevel).statements).toEqual([]);
	});

	it('never names a generated column in the rebuild it writes', () => {
		const from = sqliteTable('t', {
			id: integer('id').primaryKey(),
			name: text('name'),
			shout: text('shout').generatedAlwaysAs(sql`upper("name")`, { mode: 'stored' }),
		});
		// Any change at all forces the rebuild; SQLite rejects an INSERT that
		// names a generated column, and the batch is atomic, so the whole
		// migration rolled back.
		const to = sqliteTable('t', {
			id: integer('id').primaryKey(),
			name: text('name').notNull().default(''),
			shout: text('shout').generatedAlwaysAs(sql`upper("name")`, { mode: 'stored' }),
		});

		const insert = diffSnapshots(snapshotOf(from), snapshotOf(to))
			.statements.find((s) => s.sql.startsWith('insert into'))!;

		expect(insert.sql).toBe('insert into "__new_t" ("id", "name") select "id", "name" from "t"');
	});

	it('drops an index before the column it indexes, not after', () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey(), gone: text('gone') }, (c) => [
			indexOn('t_gone_idx', c.gone),
		]);
		const after = sqliteTable('t', { id: integer('id').primaryKey() });

		// DROP COLUMN re-validates every surviving index, so the reverse order
		// fails with "error in index t_gone_idx after drop column".
		const sql = diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql);
		expect(sql).toEqual(['drop index "t_gone_idx"', 'alter table "t" drop column "gone"']);
	});

	it('creates an index after the column it indexes', () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey() });
		const after = sqliteTable('t', { id: integer('id').primaryKey(), added: text('added') }, (c) => [
			indexOn('t_added_idx', c.added),
		]);

		const sql = diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql);
		expect(sql).toEqual([
			'alter table "t" add column "added" text',
			'create index "t_added_idx" on "t" ("added")',
		]);
	});

	describe('dropping a column something else still names', () => {
		// Each of these emitted a bare `drop column` that SQLite rejects, because
		// DROP COLUMN re-validates the whole surviving schema.
		const rebuildsFor = (before: any, after: any) => {
			const { statements, errors } = diffSnapshots(snapshotOf(before), snapshotOf(after));
			expect(errors).toEqual([]);
			return statements.map((s) => s.sql);
		};

		it('rebuilds when a generated expression names it', () => {
			const before = sqliteTable('t', {
				id: integer('id').primaryKey(),
				email: text('email'),
				domain: text('domain').generatedAlwaysAs(sql`upper("email")`, { mode: 'virtual' }),
			});
			const after = sqliteTable('t', {
				id: integer('id').primaryKey(),
				domain: text('domain').generatedAlwaysAs(sql`upper("email")`, { mode: 'virtual' }),
			});

			expect(rebuildsFor(before, after).some((s) => s.includes('__new_t'))).toBe(true);
		});

		it('rebuilds when a partial index predicate names it', () => {
			const before = sqliteTable('t', {
				id: integer('id').primaryKey(),
				name: text('name'),
				gone: integer('gone'),
			}, (c) => [uniqueIndex('t_idx').on(c.name).where(sql`${c.gone} = 1`)]);
			const after = sqliteTable('t', {
				id: integer('id').primaryKey(),
				name: text('name'),
			}, (c) => [uniqueIndex('t_idx').on(c.name).where(sql`"gone" = 1`)]);

			expect(rebuildsFor(before, after).some((s) => s.includes('__new_t'))).toBe(true);
		});

		it('rebuilds when a surviving check constraint names it', () => {
			const before = sqliteTable('t', {
				id: integer('id').primaryKey(),
				gone: integer('gone'),
			}, (c) => [check('t_chk', sql`${c.gone} >= 0`)]);
			const after = sqliteTable('t', {
				id: integer('id').primaryKey(),
			}, () => [check('t_chk', sql`"gone" >= 0`)]);

			expect(rebuildsFor(before, after).some((s) => s.includes('__new_t'))).toBe(true);
		});

		it('still drops in place when nothing else names it', () => {
			const before = sqliteTable('t', { id: integer('id').primaryKey(), spare: text('spare') });
			const after = sqliteTable('t', { id: integer('id').primaryKey() });

			expect(diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql))
				.toEqual(['alter table "t" drop column "spare"']);
		});

		it('is not fooled by a column name that is a prefix of another', () => {
			const before = sqliteTable('t', {
				id: integer('id').primaryKey(),
				email: text('email'),
				emailVerified: integer('email_verified'),
			}, (c) => [check('t_chk', sql`${c.emailVerified} >= 0`)]);
			const after = sqliteTable('t', {
				id: integer('id').primaryKey(),
				emailVerified: integer('email_verified'),
			}, (c) => [check('t_chk', sql`${c.emailVerified} >= 0`)]);

			// `email` is a substring of `email_verified`, but not a word in it.
			expect(rebuildsFor(before, after)).toEqual(['alter table "t" drop column "email"']);
		});
	});

	it('drops a removed column, and marks it destructive', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey(), old: text('old') });
		const after = sqliteTable('users', { id: integer('id').primaryKey() });

		const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(after));
		expect(statements[0]).toMatchObject({
			sql: 'alter table "users" drop column "old"',
			destructive: true,
		});
	});

	describe('table recreation', () => {
		const before = sqliteTable('users', {
			id: integer('id').primaryKey(),
			email: text('email'),
			age: text('age'),
		});

		it('rebuilds the table when a column changes type', () => {
			const after = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email'),
				age: integer('age'),
			});

			const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(after));
			const sql = statements.map((s) => s.sql);

			expect(sql[0]).toBe('PRAGMA defer_foreign_keys = ON');
			expect(sql[1]).toContain('create table "__new_users"');
			expect(sql[2]).toBe(
				'insert into "__new_users" ("id", "email", "age") select "id", "email", "age" from "users"',
			);
			expect(sql[3]).toBe('drop table "users"');
			expect(sql[4]).toBe('alter table "__new_users" rename to "users"');
			// No closing pragma: it is scoped to the transaction that ran it.
			expect(sql.some((s) => /foreign_keys\s*=\s*off/i.test(s))).toBe(false);
		});

		it('keeps the defer pragma in the statements that actually get applied', () => {
			const after = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email'),
				age: integer('age'),
			});

			const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(after));
			// D1 will not let a migration turn `foreign_keys` off, so unlike every
			// other pragma this one has to survive the applier's filter.
			expect(applicableStatements(renderMigration({ statements, errors: [], warnings: [] }))[0])
				.toBe('PRAGMA defer_foreign_keys = ON');
		});

		it('never selects *, and carries only the intersection of columns', () => {
			const after = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email').notNull().default(''),
				added: text('added'),
			});

			const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(after));
			const insert = statements.find((s) => s.sql.startsWith('insert into'))!;

			expect(insert.sql).toBe(
				'insert into "__new_users" ("id", "email") select "id", "email" from "users"',
			);
			expect(statements.some((s) => s.sql.includes('select *'))).toBe(false);
		});

		it('recreates the indexes it dropped with the table', () => {
			const withIndex = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email').notNull(),
			}, (c) => [uniqueIndex('users_email_idx').on(c.email)]);

			const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(withIndex));
			expect(statements.some((s) => s.sql === 'create unique index "users_email_idx" on "users" ("email")'))
				.toBe(true);
		});

		it('refuses to rebuild a table whose children would cascade on the drop', () => {
			const users = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
			const scores = sqliteTable('scores', {
				id: integer('id').primaryKey(),
				userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
			});

			// A type change on users forces the recreate; dropping it would fire
			// the cascade and empty `scores`, and D1 cannot disable that.
			const rebuilt = sqliteTable('users', { id: integer('id').primaryKey(), email: integer('email') });

			const { errors } = diffSnapshots(snapshotOf(users, scores), snapshotOf(rebuilt, scores));
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/"scores"."user_id" \(on delete cascade\)/);
			expect(errors[0]).toMatch(/cannot disable foreign keys/);
		});

		it('refuses just as firmly when the child has no referential action', () => {
			const users = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
			const scores = sqliteTable('scores', {
				id: integer('id').primaryKey(),
				userId: integer('user_id').references(() => users.id),
			});
			const rebuilt = sqliteTable('users', { id: integer('id').primaryKey(), email: integer('email') });

			// This used to be allowed. `DROP TABLE` runs an implicit `DELETE FROM`,
			// which increments the deferred violation counter once per child row;
			// the rename restores the schema but never decrements it, so the batch
			// fails with FOREIGN KEY constraint failed — but only when the child
			// holds rows, which is why an empty fixture never caught it.
			const { errors, statements } = diffSnapshots(snapshotOf(users, scores), snapshotOf(rebuilt, scores));
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/"scores"."user_id" \(on delete no action\)/);
			expect(statements.some((s) => s.sql === 'drop table "users"')).toBe(false);
		});

		it('refuses a self-referencing table too', () => {
			const nodes = sqliteTable('nodes', {
				id: integer('id').primaryKey(),
				parentId: integer('parent_id'),
				label: text('label'),
			}, (t) => [foreignKey({ columns: [t.parentId], foreignColumns: [t.id] })]);
			const rebuilt = sqliteTable('nodes', {
				id: integer('id').primaryKey(),
				parentId: integer('parent_id'),
				label: integer('label'),
			}, (t) => [foreignKey({ columns: [t.parentId], foreignColumns: [t.id] })]);

			const { errors } = diffSnapshots(snapshotOf(nodes), snapshotOf(rebuilt));
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/"nodes"."parent_id"/);
		});

		it('says specifically what changed, since the reason becomes the migration comment', () => {
			const typed = sqliteTable('users', { id: integer('id').primaryKey(), age: integer('age') });
			const nullable = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email').notNull(),
				age: text('age'),
			});

			const reasonFor = (after: any) =>
				diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.find((s) => s.reason)?.reason;

			expect(reasonFor(typed)).toMatch(/column "age" changes type/);
			expect(reasonFor(nullable)).toMatch(/column "email" changes nullability/);
		});

		it('warns rather than migrates when only a constraint name changed', () => {
			const from = sqliteTable('t', { id: integer('id').primaryKey(), a: integer('a') }, (c) => [
				unique('old_name').on(c.a),
			]);
			const to = sqliteTable('t', { id: integer('id').primaryKey(), a: integer('a') }, (c) => [
				unique('new_name').on(c.a),
			]);

			const { statements, warnings } = diffSnapshots(snapshotOf(from), snapshotOf(to));
			expect(statements).toEqual([]);
			expect(warnings[0]).toMatch(/"old_name" was renamed/);
		});

		it('emits nothing after the rebuild that would target the dropped table', () => {
			const from = sqliteTable('users', { id: integer('id').primaryKey(), old: text('old') });
			// Adding a unique column forces the rebuild; dropping `old` used to be
			// emitted after it as `alter table "users" drop column "old"`, which
			// fails with "no such column" and rolls the whole batch back.
			const to = sqliteTable('users', {
				id: integer('id').primaryKey(),
				handle: text('handle').unique(),
			});

			const { statements } = diffSnapshots(snapshotOf(from), snapshotOf(to));
			const sql = statements.map((s) => s.sql);

			expect(sql.some((s) => s.includes('__new_users'))).toBe(true);
			expect(sql.filter((s) => s.startsWith('alter table'))).toEqual([
				'alter table "__new_users" rename to "users"',
			]);
			// The rebuild already carries the surviving columns across.
			expect(sql.some((s) => s.includes('drop column'))).toBe(false);
		});

		it('rebuilds when nullability or a default changes', () => {
			const notNull = sqliteTable('users', {
				id: integer('id').primaryKey(),
				email: text('email').notNull().default(''),
				age: text('age'),
			});

			const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(notNull));
			expect(statements.some((s) => s.sql.includes('__new_users'))).toBe(true);
		});
	});

	it('applies explicit renames instead of dropping and recreating', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name') });
		const after = sqliteTable('people', { id: integer('id').primaryKey(), fullName: text('full_name') });

		const { statements } = diffSnapshots(snapshotOf(before), snapshotOf(after), {
			renamedTables: { users: 'people' },
			renamedColumns: { 'people.name': 'full_name' },
		});

		expect(statements.map((s) => s.sql)).toEqual([
			'alter table "users" rename to "people"',
			'alter table "people" rename column "name" to "full_name"',
		]);
	});

	it('repoints a referencing foreign key to the renamed table, instead of forcing a rebuild', () => {
		// F-098: SQLite's `ALTER TABLE … RENAME TO` rewrites every `REFERENCES`
		// clause naming the renamed table (since 3.25). `posts.author_id`
		// references `users.id`; renaming `users` to `people` alone must not
		// look like "a foreign key changes" on `posts`.
		const users = sqliteTable('users', { id: integer('id').primaryKey() });
		const posts = sqliteTable('posts', {
			id: integer('id').primaryKey(),
			authorId: integer('author_id').references(() => users.id),
		});

		const people = sqliteTable('people', { id: integer('id').primaryKey() });
		const postsAfter = sqliteTable('posts', {
			id: integer('id').primaryKey(),
			authorId: integer('author_id').references(() => people.id),
		});

		const { statements, errors } = diffSnapshots(
			snapshotOf(users, posts),
			snapshotOf(people, postsAfter),
			{ renamedTables: { users: 'people' } },
		);

		expect(errors).toEqual([]);
		expect(statements.map((s) => s.sql)).toEqual(['alter table "users" rename to "people"']);
	});

	it('repoints a self-referencing foreign key across a rename', () => {
		// F-098: a self-referencing table must also have its own reference
		// repointed, not just other tables' references to it.
		const nodes = sqliteTable('nodes', {
			id: integer('id').primaryKey(),
			parentId: integer('parent_id').references((): Column<any> => nodes.id),
		});
		const trees = sqliteTable('trees', {
			id: integer('id').primaryKey(),
			parentId: integer('parent_id').references((): Column<any> => trees.id),
		});

		const { errors } = diffSnapshots(snapshotOf(nodes), snapshotOf(trees), {
			renamedTables: { nodes: 'trees' },
		});

		expect(errors).toEqual([]);
	});

	it('leaves the rename to the rebuild when the table is also recreated', () => {
		// A standalone `rename column` emitted before the rebuild renames the
		// column out from under the rebuild's `INSERT … SELECT`, which still
		// reads the old name. D1 has double-quoted-string-literal fallback on,
		// so the unresolvable `"nick"` becomes the *string* `'nick'` rather than
		// an error: the migration reports success and every value in the column
		// is replaced by the old column's name.
		const before = sqliteTable('zzp', {
			id: integer('id').primaryKey(),
			nick: text('nick'),
			age: integer('age'),
		});
		// `age` changes type, which forces the rebuild.
		const after = sqliteTable('zzp', {
			id: integer('id').primaryKey(),
			handle: text('handle'),
			age: text('age'),
		});

		const sql = diffSnapshots(snapshotOf(before), snapshotOf(after), {
			renamedColumns: { 'zzp.nick': 'handle' },
		}).statements.map((s) => s.sql);

		expect(sql.some((s) => s.includes('rename column'))).toBe(false);
		// The rebuild carries the rename itself: old name on the right, new on
		// the left, both resolvable at the point the INSERT runs.
		expect(sql.some((s) => s.includes('"handle"') && s.includes('select') && s.includes('"nick"'))).toBe(true);
	});

	it('still emits the rename ALTER when the table survives in place', () => {
		const before = sqliteTable('zzp', { id: integer('id').primaryKey(), nick: text('nick') });
		const after = sqliteTable('zzp', { id: integer('id').primaryKey(), handle: text('handle') });

		expect(
			diffSnapshots(snapshotOf(before), snapshotOf(after), { renamedColumns: { 'zzp.nick': 'handle' } })
				.statements.map((s) => s.sql),
		).toEqual(['alter table "zzp" rename column "nick" to "handle"']);
	});

	it('adds and drops indexes without touching the table', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') }, (c) => [
			uniqueIndex('old_idx').on(c.email),
		]);
		const after = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') }, (c) => [
			uniqueIndex('new_idx').on(c.email),
		]);

		expect(diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql)).toEqual([
			'drop index "old_idx"',
			'create unique index "new_idx" on "users" ("email")',
		]);
	});

	it('produces nothing when the schema has not changed', () => {
		const t = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
		expect(diffSnapshots(snapshotOf(t), snapshotOf(t)).statements).toEqual([]);
	});

	it('renders a migration with a comment for every destructive step', () => {
		const before = sqliteTable('users', { id: integer('id').primaryKey(), old: text('old') });
		const after = sqliteTable('users', { id: integer('id').primaryKey() });

		expect(renderMigration(diffSnapshots(snapshotOf(before), snapshotOf(after)))).toBe(
			'-- column "users"."old" was removed from the schema\n'
				+ 'alter table "users" drop column "old";',
		);
	});
});

describe('parsing checks', () => {
	it('recovers an unnamed inline check', () => {
		// SQLite makes `constraint <name>` optional, and a hand-written database
		// usually omits it. Requiring it dropped the constraint silently, and the
		// next rebuild left it out of the new table.
		const sql = 'create table "t" ("a" integer, check ("a" >= 0))';
		expect(Object.values(parseChecks(sql, 't'))).toEqual([{ name: 't_check_1', value: '"a" >= 0' }]);
	});

	it('keeps a declared name when there is one', () => {
		const sql = 'create table "t" ("a" integer, constraint "t_a_chk" check ("a" >= 0))';
		expect(Object.values(parseChecks(sql, 't'))).toEqual([{ name: 't_a_chk', value: '"a" >= 0' }]);
	});

	it('does not read a check out of a string literal', () => {
		// A phantom constraint drifts against a table that matches its schema,
		// and the rebuild carries the same default forward — so it never
		// converges, destructively, on every run.
		const sql = `create table "t" ("note" text default 'check(1 = 2)')`;
		expect(parseChecks(sql, 't')).toEqual({});
	});

	it('still finds a real check whose expression contains a literal', () => {
		const sql = `create table "t" ("a" text, check ("a" <> 'a (b)'))`;
		expect(Object.values(parseChecks(sql, 't'))).toEqual([{ name: 't_check_1', value: `"a" <> 'a (b)'` }]);
	});
});

describe('column-definition anchoring', () => {
	it('does not match a column name inside another column default', () => {
		// `hasAutoincrement` used to anchor on the bare name anywhere in the SQL,
		// so a literal containing it stood in for the definition.
		const sql = `create table "t" ("label" text default 'id integer primary key autoincrement', "id" integer)`;
		expect(hasAutoincrement(sql, 'id')).toBe(false);
	});

	it('still finds the real definition', () => {
		const sql = 'create table "t" ("id" integer primary key autoincrement, "b" text)';
		expect(hasAutoincrement(sql, 'id')).toBe(true);
	});

	// Reviewer finding: the unanchored `/autoincrement/i.test(span)` this
	// replaced matched the *word* appearing anywhere in the column's span —
	// including verbatim inside a quoted identifier (a column literally named
	// `autoincrement_hint`, or a `references` clause naming a table/column
	// that contains "autoincrement") — fabricating AUTOINCREMENT on a
	// non-integer, non-PK column, which D1 rejects.
	it('does not fabricate autoincrement from a references clause naming a table containing the word', () => {
		const sql = 'create table "autoincrement_counters" ("id" text primary key); '
			+ 'create table "t" ("code" text primary key references "autoincrement_counters"("id"), "v" text)';
		expect(hasAutoincrement(sql, 'code')).toBe(false);
	});

	it('does not fabricate autoincrement from a quoted column name near a real integer PK', () => {
		const sql = 'create table "t" ("autoincrement_hint" text, "id" integer primary key)';
		expect(hasAutoincrement(sql, 'autoincrement_hint')).toBe(false);
		expect(hasAutoincrement(sql, 'id')).toBe(false);
	});

	// The corpus case: a column literally NAMED `autoincrement`, whose own
	// name is echoed back inside its own `check` and table-level `unique`
	// clauses — must not be confused by its own name.
	it('is not confused by a column named "autoincrement" mentioning itself in a check clause', () => {
		const sql = 'create table "t_779" ("autoincrement" ANY primary key unique '
			+ 'check ("autoincrement" is not null), unique ("autoincrement"))';
		expect(hasAutoincrement(sql, 'autoincrement')).toBe(false);
	});
});

describe('rebuilding alongside the dependents that block it', () => {
	const parent = (emailType: 'text' | 'integer') =>
		emailType === 'text'
			? sqliteTable('parent', { id: integer('id').primaryKey(), email: text('email') })
			: sqliteTable('parent', { id: integer('id').primaryKey(), email: integer('email') });

	it('allows the rebuild when the same migration drops the child', () => {
		const child = sqliteTable('child', {
			id: integer('id').primaryKey(),
			pid: integer('pid').references(() => parent('text').id),
		});

		// The child is gone by the time the rebuild runs, so it is not a
		// dependent — reading the before side refused this.
		const { statements, errors } = diffSnapshots(
			snapshotOf(parent('text'), child),
			snapshotOf(parent('integer')),
		);

		expect(errors).toEqual([]);
		expect(statements.some((s) => s.sql.includes('__new_parent'))).toBe(true);
		expect(statements.findIndex((s) => s.sql === 'drop table "child"'))
			.toBeLessThan(statements.findIndex((s) => s.sql.includes('__new_parent')));
	});

	it('allows the rebuild when the same migration removes the foreign key', () => {
		const withFk = sqliteTable('child', {
			id: integer('id').primaryKey(),
			pid: integer('pid').references(() => parent('text').id),
		});
		const withoutFk = sqliteTable('child', {
			id: integer('id').primaryKey(),
			pid: integer('pid'),
		});

		// This is exactly what the error message tells you to do, and it used to
		// be refused anyway because the guard read the pre-migration snapshot.
		const { statements, errors } = diffSnapshots(
			snapshotOf(parent('text'), withFk),
			snapshotOf(parent('integer'), withoutFk),
		);

		expect(errors).toEqual([]);
		// The child sheds its foreign key before the parent is dropped.
		expect(statements.findIndex((s) => s.sql.includes('__new_child')))
			.toBeLessThan(statements.findIndex((s) => s.sql.includes('__new_parent')));
	});

	it('still refuses when the child keeps its foreign key', () => {
		const child = sqliteTable('child', {
			id: integer('id').primaryKey(),
			pid: integer('pid').references(() => parent('text').id),
		});

		const { errors } = diffSnapshots(
			snapshotOf(parent('text'), child),
			snapshotOf(parent('integer'), child),
		);
		expect(errors).toHaveLength(1);
	});

	it('does not count a column named only inside a string literal', () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			keep: text('keep'),
			gone: text('gone'),
		}, (c) => [check('t_chk', sql`${c.keep} <> 'gone'`)]);
		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			keep: text('keep'),
		}, (c) => [check('t_chk', sql`${c.keep} <> 'gone'`)]);

		// `'gone'` is a value, not the column. Treating it as a reference forced
		// an unnecessary destructive rebuild.
		expect(diffSnapshots(snapshotOf(before), snapshotOf(after)).statements.map((s) => s.sql))
			.toEqual(['alter table "t" drop column "gone"']);
	});
});

describe('rebuild ordering does not depend on declaration order', () => {
	const build = (parentType: 'text' | 'integer', withFk: boolean) => {
		const parent = parentType === 'text'
			? sqliteTable('parent', { id: integer('id').primaryKey(), v: text('v') })
			: sqliteTable('parent', { id: integer('id').primaryKey(), v: integer('v') });
		const child = withFk
			? sqliteTable('child', {
				id: integer('id').primaryKey(),
				pid: integer('pid').references(() => parent.id),
			})
			: sqliteTable('child', { id: integer('id').primaryKey(), pid: integer('pid') });
		return { parent, child };
	};

	const orderOf = (declaredChildFirst: boolean) => {
		const from = build('text', true);
		const to = build('integer', false);

		// The edge that decides the order is the one this migration removes, so
		// ordering by the `after` graph found no edges at all and fell back to
		// declaration order — which is right only by luck.
		const { statements, errors } = diffSnapshots(
			snapshotOf(...(declaredChildFirst ? [from.child, from.parent] : [from.parent, from.child])),
			snapshotOf(...(declaredChildFirst ? [to.child, to.parent] : [to.parent, to.child])),
		);
		expect(errors).toEqual([]);

		const sql = statements.map((s) => s.sql);
		return {
			child: sql.findIndex((s) => s.includes('__new_child')),
			parent: sql.findIndex((s) => s.includes('__new_parent')),
		};
	};

	it('rebuilds the child first when the parent is declared first', () => {
		const { child, parent } = orderOf(false);
		expect(child).toBeGreaterThanOrEqual(0);
		expect(child).toBeLessThan(parent);
	});

	it('rebuilds the child first when the child is declared first', () => {
		const { child, parent } = orderOf(true);
		expect(child).toBeGreaterThanOrEqual(0);
		expect(child).toBeLessThan(parent);
	});

	it('orders a three-level chain leaf-first regardless of declaration', () => {
		const mk = (grandchildType: 'text' | 'integer') => {
			const a = sqliteTable('a', { id: integer('id').primaryKey() });
			const b = sqliteTable('b', {
				id: integer('id').primaryKey(),
				aid: integer('aid').references(() => a.id),
			});
			const c = grandchildType === 'text'
				? sqliteTable('c', {
					id: integer('id').primaryKey(),
					v: text('v'),
					bid: integer('bid').references(() => b.id),
				})
				: sqliteTable('c', { id: integer('id').primaryKey(), v: integer('v'), bid: integer('bid') });
			return { a, b, c };
		};

		const from = mk('text');
		const to = mk('integer');
		// Declared leaf-first, the order that used to come out backwards.
		const { statements, errors } = diffSnapshots(
			snapshotOf(from.c, from.b, from.a),
			snapshotOf(to.c, to.b, to.a),
		);

		expect(errors).toEqual([]);
		const sql = statements.map((s) => s.sql);
		expect(sql.findIndex((s) => s.includes('__new_c'))).toBeGreaterThanOrEqual(0);
	});
});

/**
 * The invariant `assertRoundTrip` exists to state: a snapshot has to reproduce
 * exactly what the DDL generator emits directly. It had no caller at all, which
 * on an unpublished package means it was asserting nothing.
 *
 * It is the property the whole kit rests on — `generate` renders migrations
 * from snapshots, so a snapshot that loses a constraint writes a migration that
 * drops it — and it is cheap enough to run over every shape the fixtures cover.
 */
describe('snapshot and DDL agree, table for table', () => {
	const parents = sqliteTable('p_parent', { id: integer('id').primaryKey() });
	const others = sqliteTable('p_other', { id: integer('id').primaryKey() });

	const fixtures = {
		'a plain table': sqliteTable('plain', { id: integer('id').primaryKey(), name: text('name') }),
		'autoincrement': sqliteTable('ai', { id: integer('id').primaryKey({ autoIncrement: true }) }),
		'not null and defaults': sqliteTable('nd', {
			id: integer('id').primaryKey(),
			name: text('name').notNull().default('anon'),
			count: integer('count').notNull().default(0),
		}),
		'a column-level unique': sqliteTable('cu', {
			id: integer('id').primaryKey(),
			email: text('email').notNull().unique(),
		}),
		'a composite primary key': sqliteTable('cpk', {
			a: integer('a').notNull(),
			b: text('b').notNull(),
		}, (t) => [primaryKey({ columns: [t.a, t.b] })]),
		'a table-level unique': sqliteTable('tu', {
			a: integer('a').notNull(),
			b: text('b').notNull(),
		}, (t) => [unique('tu_ab').on(t.a, t.b)]),
		'a check constraint': sqliteTable('ck', {
			id: integer('id').primaryKey(),
			n: integer('n'),
		}, (t) => [check('ck_n', sql`${t.n} >= 0`)]),
		// Two unnamed table-level keys used to derive the same `${table}_fk`
		// name, so the snapshot's record kept only the second — a referential
		// constraint dropped from the generated migration with no warning, and
		// invisible to the ordering and drop guards that read the same record.
		'two unnamed table-level foreign keys': sqliteTable('p_child', {
			parentId: integer('parent_id').notNull(),
			otherId: integer('other_id').notNull(),
		}, (t) => [
			foreignKey({ columns: [t.parentId], foreignColumns: [parents.id] }),
			foreignKey({ columns: [t.otherId], foreignColumns: [others.id] }),
		]),
		'a generated column': sqliteTable('gen', {
			id: integer('id').primaryKey(),
			name: text('name').notNull(),
			shout: text('shout').generatedAlwaysAs(sql`upper("name")`, { mode: 'stored' }),
		}),
		// `customType`'s `declaredType` — the literal string its `dataType()`
		// returned — has to make it through the snapshot unchanged, or the DDL
		// `createTableFromSnapshot` regenerates for `generate` disagrees with
		// `createSchema`'s direct emission over the *reduced affinity* the
		// snapshot used to store instead (kit/src/core/snapshot.ts).
		'a customType column': sqliteTable('ct', {
			id: integer('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'varchar(10)' })('amount').notNull(),
		}),
		// `[F-012]`: `getSQLType()` folds in the length (`text(255)`), but DDL
		// and snapshot rendering read `declaredType ?? type` directly and stay
		// bare `text` — this pins that the snapshot round-trip agrees with the
		// bare spelling regardless of what `getSQLType()` now reports.
		'a length-bearing text column': sqliteTable('lt', {
			id: integer('id').primaryKey(),
			name: text('name', { length: 255 }).notNull(),
		}),
	};

	for (const [description, table] of Object.entries(fixtures)) {
		it(`round-trips ${description}`, () => {
			expect(() => assertRoundTrip(table)).not.toThrow();
		});
	}

	it('refuses two indexes whose derived names collide, rather than dropping one', () => {
		const users = sqliteTable('users_collide', {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
			username: text('username').notNull(),
		}, (t) => [
			uniqueIndex().on(sql`lower(${t.email})`),
			uniqueIndex().on(sql`lower(${t.username})`),
		]);

		expect(() => snapshotFromSchema([users])).toThrow(/derive the name "users_collide_expr_unique"/);
	});

	it('names both colliding declarations in the message, not just the shared name', () => {
		const users = sqliteTable('users', {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
			username: text('username').notNull(),
		}, (t) => [
			uniqueIndex().on(sql`lower(${t.email})`),
			uniqueIndex().on(sql`lower(${t.username})`),
		]);

		expect(() => snapshotFromSchema([users])).toThrow(/lower\("username"\)/);
	});

	it('a check constraint collision tells the author to rename, not to add a name they already gave', () => {
		const t = sqliteTable('checked', {
			id: integer('id').primaryKey(),
			n: integer('n'),
		}, (t) => [
			check('dupe', sql`${t.n} >= 0`),
			check('dupe', sql`${t.n} <= 100`),
		]);

		expect(() => snapshotFromSchema([t])).toThrow(/Rename one/);
		expect(() => snapshotFromSchema([t])).not.toThrow(/Give at least one an explicit name/);
	});

	// A constraint explicitly named `constructor`, `toString`, `valueOf`, etc.
	// is a legal SQL identifier that `pull` on a foreign database can emit —
	// and it collides with an *inherited* property of a plain object literal,
	// not an own one. Testing with `in`/bracket access instead of
	// `Object.hasOwn` reported every such name as colliding with itself.
	for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
		it(`an index named "${name}" snapshots as a single constraint, not a self-collision`, () => {
			const t = sqliteTable('t1', { a: text('a') }, (x) => [index(name).on(x.a)]);
			const snap = snapshotFromSchema([t]);
			expect(Object.keys(snap.tables.t1!.indexes)).toEqual([name]);
		});

		it(`a check constraint named "${name}" snapshots as a single constraint, not a self-collision`, () => {
			const t = sqliteTable('t2', { n: integer('n') }, (x) => [check(name, sql`${x.n} >= 0`)]);
			const snap = snapshotFromSchema([t]);
			expect(Object.keys(snap.tables.t2!.checkConstraints)).toEqual([name]);
		});

		it(`a unique constraint named "${name}" snapshots as a single constraint, not a self-collision`, () => {
			const t = sqliteTable('t3', { a: text('a').notNull() }, (x) => [unique(name).on(x.a)]);
			const snap = snapshotFromSchema([t]);
			expect(Object.keys(snap.tables.t3!.uniqueConstraints)).toEqual([name]);
		});
	}

	it('a genuine duplicate of a prototype-key name still throws', () => {
		const t = sqliteTable('t4', { a: text('a'), b: text('b') }, (x) => [
			index('constructor').on(x.a),
			index('constructor').on(x.b),
		]);
		expect(() => snapshotFromSchema([t])).toThrow(/derive the name "constructor"/);
	});

	it('an index named "__proto__" lands as an own property instead of mutating the prototype', () => {
		const t = sqliteTable('t5', { a: text('a') }, (x) => [index('__proto__').on(x.a)]);
		const snap = snapshotFromSchema([t]);
		expect(Object.hasOwn(snap.tables.t5!.indexes, '__proto__')).toBe(true);
		expect(snap.tables.t5!.indexes.__proto__).toEqual(
			expect.objectContaining({ name: '__proto__' }),
		);
		// The map itself must be unaffected by the assignment — this is what the
		// bug broke: `indexes['__proto__'] = value` on a plain object literal
		// repoints the object's prototype instead of adding an entry.
		expect(Object.getPrototypeOf(snap.tables.t5!.indexes)).not.toBe(Object.prototype);
		expect(snap.tables.t5!.indexes.constructor).toBeUndefined();
	});
});

describe('table options: STRICT, WITHOUT ROWID and the append-only guard', () => {
	const users = sqliteTable('users', {
		id: text('id').primaryKey(),
		email: text('email').notNull(),
	});
	const events = sqliteTable('events', {
		id: text('id').primaryKey(),
		at: integer('at').notNull(),
	});

	const withOptions = (table: any, options: Record<string, boolean>): Snapshot =>
		snapshotFromSchema([table], '', tableOptions([[table, options]]));

	it('emits the options on CREATE TABLE, in the order sqlite_master reports them', () => {
		const pairs = sqliteTable('pairs', {
			a: text('a').notNull(),
			b: text('b').notNull(),
		}, (c) => [primaryKey({ columns: [c.a, c.b] })]);

		const diff = diffSnapshots(emptySnapshot(), withOptions(pairs, { strict: true, withoutRowid: true }));
		expect(diff.statements[0]!.sql).toMatch(/\)\s*strict, without rowid$/);
	});

	it('creates the append-only trigger with a new table', () => {
		const diff = diffSnapshots(emptySnapshot(), withOptions(events, { appendOnly: true }));
		const sql = diff.statements.map((s) => s.sql).join('\n');
		expect(sql).toMatch(/create trigger "events_no_update"/);
		expect(sql).toMatch(/before update on "events"/);
		expect(sql).toMatch(/raise\(abort,/);
	});

	it('rebuilds the table when STRICT is turned on — SQLite has no ALTER for it', () => {
		const diff = diffSnapshots(withOptions(users, {}), withOptions(users, { strict: true }));
		const sql = diff.statements.map((s) => s.sql).join('\n');
		expect(diff.errors).toEqual([]);
		expect(sql).toMatch(/create table "__new_users"/);
		expect(sql).toMatch(/drop table "users"/);
		expect(diff.statements.some((s) => s.reason?.includes('becomes STRICT'))).toBe(true);
	});

	it('rebuilds the table when WITHOUT ROWID changes', () => {
		const diff = diffSnapshots(withOptions(users, {}), withOptions(users, { withoutRowid: true }));
		expect(diff.statements.some((s) => s.reason?.includes('becomes WITHOUT ROWID'))).toBe(true);
	});

	it('adds and drops the guard in place — a trigger needs no rebuild', () => {
		const added = diffSnapshots(withOptions(events, {}), withOptions(events, { appendOnly: true }));
		expect(added.statements.map((s) => s.sql).join('\n')).not.toMatch(/__new_events/);
		expect(added.statements).toHaveLength(1);
		expect(added.statements[0]!.sql).toMatch(/create trigger "events_no_update"/);

		const removed = diffSnapshots(withOptions(events, { appendOnly: true }), withOptions(events, {}));
		expect(removed.statements[0]!.sql).toMatch(/drop trigger if exists "events_no_update"/);
		// Losing a protection is worth flagging, even though no data is deleted.
		expect(removed.statements[0]!.destructive).toBe(true);
	});

	it('re-emits the guard after a rebuild, since DROP TABLE takes the trigger with it', () => {
		// The failure this pins is silent: the table comes back unprotected and
		// nothing errors, so UPDATEs simply start working again.
		const before = withOptions(events, { appendOnly: true });
		const after = snapshotFromSchema(
			[sqliteTable('events', { id: text('id').primaryKey(), at: text('at').notNull() })],
			'',
			tableOptions([[events, { appendOnly: true }]]),
		);

		const diff = diffSnapshots(before, after);
		const sql = diff.statements.map((s) => s.sql).join('\n');
		expect(sql).toMatch(/create table "__new_events"/);
		expect(sql).toMatch(/create trigger "events_no_update"/);
		// And after the rename, not before it.
		expect(sql.indexOf('create trigger')).toBeGreaterThan(sql.indexOf('rename to "events"'));
	});

	// SQLite keeps a trigger's name across `ALTER TABLE … RENAME TO` and only
	// repoints its `tbl_name`, so the guard on a renamed table is still called
	// `<old>_no_update`. Everything downstream of the rename is keyed on the new
	// name, so both halves of this were wrong before: the drop was a no-op that
	// left UPDATE blocked forever, and the keep silently kept the stale name.
	describe('the guard across a table rename', () => {
		const renamed = sqliteTable('audit', { id: text('id').primaryKey(), at: text('at').notNull() });
		const opts = (table: any, appendOnly: boolean): Snapshot =>
			snapshotFromSchema([table], '', tableOptions([[table, { appendOnly }]]));

		it('drops the trigger under the name it actually has', () => {
			const diff = diffSnapshots(opts(events, true), opts(renamed, false), {
				renamedTables: { events: 'audit' },
			});
			const sql = diff.statements.map((s) => s.sql);

			expect(sql).toContain('alter table "events" rename to "audit"');
			expect(sql).toContain('drop trigger if exists "events_no_update"');
			// And never under the new name, which no trigger is called.
			expect(sql.join('\n')).not.toMatch(/drop trigger if exists "audit_no_update"/);
		});

		it('re-creates the guard under the new name when the table stays append-only', () => {
			const diff = diffSnapshots(opts(events, true), opts(renamed, true), {
				renamedTables: { events: 'audit' },
			});
			const sql = diff.statements.map((s) => s.sql);

			expect(sql).toContain('drop trigger if exists "events_no_update"');
			expect(sql.some((s) => /create trigger "audit_no_update"/.test(s))).toBe(true);
			// Ordering matters: the create has to follow the rename it names.
			expect(sql.findIndex((s) => s.includes('create trigger')))
				.toBeGreaterThan(sql.indexOf('alter table "events" rename to "audit"'));
		});
	});

	it('reports no drift when nothing about the options changed', () => {
		const snapshot = withOptions(events, { strict: true, withoutRowid: false, appendOnly: true });
		expect(diffSnapshots(snapshot, snapshot).statements).toEqual([]);
	});

	// Finding 4: renaming an append-only table used to clear `appendOnly` on
	// the carried-forward table as a side effect of the rename, which made the
	// in-place destructive check below never see the transition at all — the
	// guard silently escaped `--accept-data-loss`.
	describe('escaping --accept-data-loss by renaming an append-only table (finding 4)', () => {
		const renamed = sqliteTable('audit', { id: text('id').primaryKey(), at: text('at').notNull() });
		const opts = (table: any, appendOnly: boolean): Snapshot =>
			snapshotFromSchema([table], '', tableOptions([[table, { appendOnly }]]));

		it('marks the guard drop destructive when the renamed table does not stay append-only', () => {
			const diff = diffSnapshots(opts(events, true), opts(renamed, false), {
				renamedTables: { events: 'audit' },
			});
			expect(diff.statements.some((s) => s.destructive)).toBe(true);
			const drop = diff.statements.find((s) => s.sql === 'drop trigger if exists "events_no_update"');
			expect(drop?.destructive).toBe(true);
			expect(drop?.reason).toMatch(/no longer append-only/);
		});

		it('still marks the in-place (non-renaming) transition destructive', () => {
			const diff = diffSnapshots(withOptions(events, { appendOnly: true }), withOptions(events, {}));
			const drop = diff.statements.find((s) => s.sql === 'drop trigger if exists "events_no_update"');
			expect(drop?.destructive).toBe(true);
			expect(drop?.reason).toMatch(/no longer append-only/);
		});

		it('does not mark the drop destructive when the renamed table stays append-only', () => {
			const diff = diffSnapshots(opts(events, true), opts(renamed, true), {
				renamedTables: { events: 'audit' },
			});
			const drop = diff.statements.find((s) => s.sql === 'drop trigger if exists "events_no_update"');
			expect(drop).toBeDefined();
			expect(drop?.destructive).toBe(false);
			const create = diff.statements.find((s) => /create trigger "audit_no_update"/.test(s.sql));
			expect(create).toBeDefined();
			expect(create?.destructive).toBe(false);
		});
	});

	// Finding 2: a rebuild only ever re-creates the append-only guard it
	// authors itself; any other trigger on the live table is silently dropped
	// with the table, with no error and no way to get it back.
	describe('refusing a rebuild that would silently drop a foreign trigger (finding 2)', () => {
		it('refuses when the live table carries a trigger orm-d1 did not author', () => {
			const before = withOptions(users, {});
			const after = withOptions(
				sqliteTable('users', { id: text('id').primaryKey(), email: text('email') }),
				{},
			);

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { users: ['users_audit'] },
			});

			expect(diff.statements).toEqual([]);
			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"users" has to be recreated/);
			expect(diff.errors[0]).toMatch(/"users_audit"/);
		});

		it('refuses when the live foreign trigger is recorded under a differently-cased table name (diff.ts:808)', () => {
			// `options.foreignTriggers` is keyed the way `introspect()` populates
			// it — exactly as `sqlite_master.tbl_name` spelled it, "USERS" here —
			// while the diff's own table name is "users" (lowercase). A direct
			// `options.foreignTriggers[liveTableNames[name] ?? name]` lookup would
			// miss the "USERS"-keyed entry.
			const before = withOptions(users, {});
			const after = withOptions(
				sqliteTable('users', { id: text('id').primaryKey(), email: text('email') }),
				{},
			);

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { USERS: ['users_audit'] },
			});

			expect(diff.statements).toEqual([]);
			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"users_audit"/);
		});

		it('does not refuse when the only trigger present is the append-only guard itself', () => {
			const before = withOptions(users, { appendOnly: true });
			const after = withOptions(
				sqliteTable('users', { id: text('id').primaryKey(), email: text('email') }),
				{ appendOnly: true },
			);

			// The append-only guard is never passed as a `foreignTrigger` by a
			// real caller (`introspect`'s out-param excludes it) — this proves
			// the rebuild still succeeds when `foreignTriggers` is absent/empty.
			const diff = diffSnapshots(before, after);
			expect(diff.errors).toEqual([]);
			expect(diff.statements.some((s) => /create table "__new_users"/.test(s.sql))).toBe(true);
		});

		it('still refuses for a table that also has dependents, naming the trigger not just the dependent', () => {
			const parent = sqliteTable('parent', {
				id: text('id').primaryKey(),
				name: text('name'),
			});
			const child = sqliteTable('child', {
				id: text('id').primaryKey(),
				parentId: text('parent_id').references(() => parent.id),
			});
			const parentAfter = sqliteTable('parent', {
				id: text('id').primaryKey(),
				name: integer('name'),
			});

			const diff = diffSnapshots(
				snapshotOf(parent, child),
				snapshotOf(parentAfter, child),
				{ foreignTriggers: { parent: ['parent_audit'] } },
			);

			// The dependents check runs first and refuses before the trigger
			// check is ever reached — both are real reasons this rebuild cannot
			// happen, and the first one found is reported.
			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"child".*references it/);
		});

		// [F-046]: `recreateTable`'s contract is "no statements alongside a
		// refusal", but the append-only-loss block used to run unconditionally
		// after the `recreateTable` call regardless of whether it refused, so a
		// refused rebuild still emitted a lone destructive `drop trigger`.
		it('emits no statements at all — not even the append-only-loss drop trigger — when the rebuild is refused for carrying a foreign trigger', () => {
			const before = withOptions(users, { appendOnly: true });
			const after = withOptions(
				sqliteTable('users', { id: text('id').primaryKey(), email: integer('email') }),
				{},
			);

			const diff = diffSnapshots(before, after, { foreignTriggers: { users: ['users_audit'] } });

			expect(diff.errors).toHaveLength(1);
			expect(diff.statements).toEqual([]);
		});

		it('still refuses when the trigger-carrying table is also renamed in the same migration', () => {
			// `options.foreignTriggers` is keyed by the LIVE (pre-rename) name,
			// the same way `introspect()` populates it — `users`, not `people`.
			// A rebuild forced by the type change on `email` must still find it
			// even though the diff also renames the table.
			const before = withOptions(users, {});
			const after = withOptions(
				sqliteTable('people', { id: text('id').primaryKey(), email: integer('email') }),
				{},
			);

			const diff = diffSnapshots(before, after, {
				renamedTables: { users: 'people' },
				foreignTriggers: { users: ['users_audit'] },
			});

			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"people" has to be recreated/);
			expect(diff.errors[0]).toMatch(/"users_audit"/);
		});
	});

	// Gap 2 (regression review of finding 2): the anchoring means a hand-edited
	// `<table>_no_update` is correctly no longer classified as the guard, so a
	// live `appendOnly = false` -> schema `appendOnly = true` transition fires
	// an in-place `create trigger` — but the name is already taken by that
	// foreign trigger, so it cannot apply. Refuse instead of emitting SQL that
	// fails with "trigger ... already exists".
	describe('refusing an in-place append-only guard creation that collides with a foreign trigger', () => {
		it('refuses when the live table already has a foreign trigger named "<table>_no_update"', () => {
			const before = withOptions(events, {});
			const after = withOptions(events, { appendOnly: true });

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { events: ['events_no_update'] },
			});

			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"events_no_update"/);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(false);
		});

		// [Finding 7c]: SQLite trigger names are database-global, not scoped to
		// the table gaining the guard, so the collision check has to scan every
		// table's foreign triggers — not just look up `foreignTriggers[name]` for
		// the table becoming append-only. Reverting to that per-table
		// `.includes(guardName)` shape (main's old check) left every existing
		// test in this file green, because they all happen to put the collider
		// on the table gaining the guard, or on a table this same diff drops.
		// This one puts it on a *different* table that neither is rebuilt nor
		// dropped — untouched by this diff except for being where the colliding
		// trigger happens to live.
		it('refuses when the colliding trigger lives on a different table entirely, which survives untouched', () => {
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const before = snapshotOf(audit, events);
			const after = snapshotFromSchema([audit, events], '', tableOptions([[events, { appendOnly: true }]]));

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['events_no_update'] },
			});

			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"events_no_update"/);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(false);
			// "audit" itself is untouched by this diff — it is neither rebuilt nor
			// dropped, just the table the collider happens to live on.
			expect(diff.statements.some((s) => s.sql.includes('"audit"'))).toBe(false);
		});

		// `tableGuardCollides`'s `droppedTriggerNames` exemption: a rename of an
		// append-only table drops its OLD guard under the OLD name (step 1, see
		// the comment at diff.ts ~569-593 on why SQLite does not rename a
		// trigger along with its table). If this same diff also creates a
		// brand-new table that happens to reuse that freed-up name — legal,
		// since the old name no longer appears in `after` once the rename takes
		// it — the new table's own derived guard name is identical to the one
		// just dropped. `options.foreignTriggers` (a pre-diff snapshot) has no
		// way to know that literal name is about to be vacated by this diff's
		// own rename, so a naive scan over it would refuse a guard creation
		// this diff's own earlier statement already made safe.
		it('does not refuse a new table\'s guard whose name was already vacated by an earlier rename in the same diff', () => {
			const legacyBefore = sqliteTable('legacy', { id: text('id').primaryKey() });
			const before = snapshotFromSchema([legacyBefore], '', tableOptions([[legacyBefore, { appendOnly: true }]]));

			const ordersAfter = sqliteTable('orders', { id: text('id').primaryKey() });
			const legacyNew = sqliteTable('legacy', { id: text('id').primaryKey() });
			const after = snapshotFromSchema(
				[ordersAfter, legacyNew],
				'',
				tableOptions([[legacyNew, { appendOnly: true }]]),
			);

			const diff = diffSnapshots(before, after, {
				renamedTables: { legacy: 'orders' },
				// A stale pre-diff record of a trigger literally named
				// "legacy_no_update" — as if it lived on some unrelated table.
				foreignTriggers: { misc: ['legacy_no_update'] },
			});

			expect(diff.errors).toEqual([]);
			expect(diff.statements.some((s) => s.sql === 'drop trigger if exists "legacy_no_update"')).toBe(true);
			expect(diff.statements.some((s) => /create trigger "legacy_no_update"/.test(s.sql))).toBe(true);
		});

		it('still creates the guard normally when no foreign trigger occupies the name', () => {
			const before = withOptions(events, {});
			const after = withOptions(events, { appendOnly: true });

			const diff = diffSnapshots(before, after);

			expect(diff.errors).toEqual([]);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(true);
		});

		// [F-079], regression half: `options.foreignTriggers` is a pre-diff
		// snapshot, so a naive scan over it refuses a migration that is itself
		// the fix — dropping the table the collider lives on, in the same
		// batch, removes the collider before `create trigger` ever runs.
		it('does not refuse when the colliding trigger\'s own table is dropped in the same diff', () => {
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const before = snapshotOf(audit, events);
			const after = snapshotFromSchema([events], '', tableOptions([[events, { appendOnly: true }]]));

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['events_no_update'] },
			});

			expect(diff.errors).toEqual([]);
			expect(diff.statements.some((s) => s.sql === 'drop table "audit"')).toBe(true);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(true);
		});

		// [Finding 2]: `tableGuardCollides`'s `droppedTables` exemption used to be
		// pure membership — "this diff drops that table eventually" — not order.
		// `diffSnapshots` emits created tables (step 2) *before* dropped tables
		// (step 3), so a brand-new append-only table whose guard collides with a
		// trigger on a table this same diff also drops used to be exempted here
		// even though, in the emitted SQL, the colliding `create trigger` runs
		// before the `drop table` that was supposed to clear the name — the
		// create fails on apply (or, worse, silently attaches to whichever table
		// SQLite still has under that name). Both "audit" and "log" are dropped
		// (neither survives into `after`), so nothing in the emitted statements
		// removes the collider before the new "events" guard would try to claim
		// its name.
		it('refuses a brand-new append-only table whose guard collides with a live trigger on a table dropped later in the same diff', () => {
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const log = sqliteTable('log', { id: text('id').primaryKey() });
			const before = snapshotOf(audit, log);
			const after = snapshotFromSchema([events], '', tableOptions([[events, { appendOnly: true }]]));

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['events_no_update'] },
			});

			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"events_no_update"/);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(false);
		});

		// [F-079], narrowness half: the created-table path never checked at all.
		it('refuses a brand-new append-only table whose guard name collides with a live foreign trigger on a table that survives', () => {
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const before = snapshotOf(audit);
			const after = snapshotFromSchema([audit, events], '', tableOptions([[events, { appendOnly: true }]]));

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['events_no_update'] },
			});

			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"events_no_update"/);
			expect(diff.statements.some((s) => /create trigger "events_no_update"/.test(s.sql))).toBe(false);
		});

		// [F-079], narrowness half: the rebuild path never checked at all — a
		// table rebuilt for some unrelated reason (here, a type change) that
		// also turns on `appendOnly` used to re-create the guard with no check.
		it('refuses a rebuild that turns a table append-only when the guard name collides with a live foreign trigger on a table that survives', () => {
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const before = snapshotOf(audit, events);
			// A type change on "at" forces `recreateTable`'s rebuild path, which
			// is also where this diff turns "events" append-only.
			const rebuiltEvents = sqliteTable('events', { id: text('id').primaryKey(), at: text('at') });
			const after = snapshotFromSchema(
				[audit, rebuiltEvents],
				'',
				tableOptions([[rebuiltEvents, { appendOnly: true }]]),
			);

			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['events_no_update'] },
			});

			// [Finding 6]: a guard-collision refusal here used to fall through and
			// still return the full destructive rebuild alongside the error — the
			// `create table "__new_events"`, the data copy, the `drop table`, the
			// rename — unapplyable SQL sitting next to an error that says the
			// rebuild cannot happen. It must refuse the same way the other two
			// `recreateTable` refusals do: an error, and no statements at all.
			expect(diff.errors).toHaveLength(1);
			expect(diff.errors[0]).toMatch(/"events_no_update"/);
			expect(diff.statements).toEqual([]);
		});

		// [Round 3, Finding 3]: `tableGuardCollides` used to fold case with
		// `.toLowerCase()`, not the ASCII-only `foldAsciiCase` this file already
		// uses elsewhere for identifier comparison. `.toLowerCase()` maps U+212A
		// KELVIN SIGN to ordinary ASCII "k" — SQLite's own identifier comparison
		// is ASCII-only and treats them as different characters — so a table
		// named with a Kelvin sign turning append-only used to be refused
		// against a live trigger that, to SQLite, has an entirely different
		// name. `create trigger` would actually succeed.
		it('does not refuse when the guard name only collides after non-ASCII case folding (Kelvin sign vs "k")', () => {
			const kelvinSign = String.fromCharCode(0x212a);
			const eventK = sqliteTable(`event${kelvinSign}`, { id: text('id').primaryKey() });
			const audit = sqliteTable('audit', { id: text('id').primaryKey() });
			const before = snapshotOf(audit, eventK);
			const after = snapshotFromSchema([audit, eventK], '', tableOptions([[eventK, { appendOnly: true }]]));

			// A live foreign trigger spelled with an ordinary ASCII "k" — distinct
			// from `event<KELVIN SIGN>_no_update` to SQLite, but `.toLowerCase()`
			// would fold both to the same string.
			const diff = diffSnapshots(before, after, {
				foreignTriggers: { audit: ['eventk_no_update'] },
			});

			expect(diff.errors).toEqual([]);
			expect(diff.statements.some((s) => s.sql.includes(`"event${kelvinSign}_no_update"`))).toBe(true);
		});
	});

	// Finding 2 (smaller half): a rebuild triggered for some other reason
	// (here, a type change) that also happens to turn off `appendOnly` used to
	// `continue` past the in-place transition block entirely, losing the
	// guard with no destructive `reason` naming it.
	it('still emits the append-only-lost reason when a rebuild fires for another reason', () => {
		const before = withOptions(events, { appendOnly: true });
		const after = snapshotFromSchema(
			[sqliteTable('events', { id: text('id').primaryKey(), at: text('at') })],
			'',
			tableOptions([[events, {}]]),
		);

		const diff = diffSnapshots(before, after);
		expect(diff.statements.some((s) => /create table "__new_events"/.test(s.sql))).toBe(true);

		const guardLoss = diff.statements.find((s) =>
			s.sql === 'drop trigger if exists "events_no_update"' && s.destructive
		);
		expect(guardLoss).toBeDefined();
		expect(guardLoss?.reason).toMatch(/no longer append-only/);
	});
});

describe('reading table options back out of a CREATE TABLE', () => {
	it('reads STRICT and WITHOUT ROWID off the tail', () => {
		expect(parseTableOptions('create table "t" ("a" text) strict, without rowid'))
			.toEqual({ strict: true, withoutRowid: true });
		expect(parseTableOptions('create table "t" ("a" text) strict'))
			.toEqual({ strict: true, withoutRowid: false });
		expect(parseTableOptions('create table "t" ("a" text)'))
			.toEqual({ strict: false, withoutRowid: false });
	});

	it('does not mistake a column or a literal for the option', () => {
		// Only the tail past the final `)` is scanned, so neither of these counts.
		expect(parseTableOptions('create table "t" ("strict" text, "without rowid" text)'))
			.toEqual({ strict: false, withoutRowid: false });
		expect(parseTableOptions(`create table "t" ("a" text default 'strict')`))
			.toEqual({ strict: false, withoutRowid: false });
	});

	it('does not read an option out of a comment', () => {
		// SQLite keeps a comment that sits *before* a table option, verbatim. Its own
		// `)` used to bound the tail by accident; now that comments are blanked, the
		// tail must be taken from the blanked text or the word inside the comment
		// becomes an option the table never had — and the rebuilt table gets a
		// constraint that rejects rows the original accepted.
		expect(parseTableOptions('create table "t" ("id" text primary key, "n" integer) /* strict ) */ without rowid'))
			.toEqual({ strict: false, withoutRowid: true });
		expect(parseTableOptions('create table "t" ("id" integer primary key autoincrement) /* without rowid ) */ strict'))
			.toEqual({ strict: true, withoutRowid: false });
		expect(parseTableOptions('create table "t" ("a" text) -- strict )\n'))
			.toEqual({ strict: false, withoutRowid: false });
	});

	it('recognises the guard by what it does, not by its name', () => {
		const guard = 'CREATE TRIGGER whatever_i_called_it BEFORE UPDATE ON "events" '
			+ "BEGIN SELECT RAISE(ABORT, 'nope'); END";
		expect(isAppendOnlyTrigger(guard, 'events')).toBe(true);

		// A trigger on a different table, and one that does not abort.
		expect(isAppendOnlyTrigger(guard, 'users')).toBe(false);
		expect(isAppendOnlyTrigger('CREATE TRIGGER t AFTER INSERT ON "events" BEGIN SELECT 1; END', 'events'))
			.toBe(false);
	});

	// The unsafe direction: reading a *conditional* abort as the guard reports a
	// table as protected when UPDATE in fact still works on most rows.
	it('does not mistake a conditional validation trigger for the guard', () => {
		const when = 'CREATE TRIGGER validate BEFORE UPDATE ON "events" WHEN new.kind IS NULL '
			+ "BEGIN SELECT RAISE(ABORT, 'kind required'); END";
		expect(isAppendOnlyTrigger(when, 'events')).toBe(false);

		// Aborts, but only down one branch of the CASE.
		const branch = 'CREATE TRIGGER validate BEFORE UPDATE ON "events" BEGIN '
			+ "SELECT CASE WHEN new.kind IS NULL THEN RAISE(ABORT, 'no') END; END";
		expect(isAppendOnlyTrigger(branch, 'events')).toBe(false);

		// And a guard that does something *else* as well is not the guard either.
		const extra = 'CREATE TRIGGER g BEFORE UPDATE ON "events" BEGIN '
			+ "INSERT INTO audit VALUES (1); SELECT RAISE(ABORT, 'no'); END";
		expect(isAppendOnlyTrigger(extra, 'events')).toBe(false);

		// The standard conditional-constraint idiom: a bare `SELECT RAISE(ABORT, …)
		// WHERE <cond>` is a prefix match for the guard but is not unconditional.
		const filtered = 'CREATE TRIGGER guard BEFORE UPDATE ON "events" BEGIN '
			+ "SELECT RAISE(ABORT, 'kind is immutable') WHERE new.kind <> old.kind; END";
		expect(isAppendOnlyTrigger(filtered, 'events')).toBe(false);
	});

	it('still recognises orm-d1\'s own generated guard after the anchor tightening', () => {
		expect(isAppendOnlyTrigger(appendOnlyTrigger('events'), 'events')).toBe(true);
	});

	// A rebuild drops the table and its trigger with it. Re-emitting the guard
	// as `true` when it was scoped would silently widen it; forgetting the list
	// is the same bug the whole-table version had before it was covered.
	describe('a column-scoped guard survives a rebuild', () => {
		const guarded = (appendOnly: boolean | string[], checkValue: string) => ({
			version: '3',
			dialect: 'sqlite',
			id: '',
			prevId: '',
			origin: 'schema',
			tables: {
				t: {
					name: 't',
					columns: {
						id: { name: 'id', type: 'text', notNull: true, primaryKey: true },
						amount: { name: 'amount', type: 'integer', notNull: true, primaryKey: false },
						fee: { name: 'fee', type: 'integer', notNull: false, primaryKey: false },
					},
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {},
					uniqueConstraints: {},
					checkConstraints: { t_amount_check: { name: 't_amount_check', value: checkValue } },
					appendOnly,
				},
			},
		}) as never;

		it('re-emits the column list, not a whole-table guard', () => {
			const { statements } = diffSnapshots(
				guarded(['amount'], '"amount" > 0'),
				guarded(['amount'], '"amount" >= 0'),
				{},
			);
			const created = statements.filter((s) => s.sql.startsWith('create trigger'));
			expect(created).toHaveLength(1);
			expect(created[0]!.sql).toContain('before update of "amount" on "t"');
		});

		it('narrowing the list is reported as removing a protection', () => {
			const { statements } = diffSnapshots(
				guarded(true, '"amount" > 0'),
				guarded(['amount'], '"amount" > 0'),
				{},
			);
			const drop = statements.find((s) => s.sql.startsWith('drop trigger'));
			expect(drop).toMatchObject({ destructive: true });
			expect(drop!.reason).toContain('no longer covers');
			expect(drop!.reason).toContain('fee');
		});

		it('widening the list is not destructive', () => {
			const { statements } = diffSnapshots(
				guarded(['amount'], '"amount" > 0'),
				guarded(['amount', 'fee'], '"amount" > 0'),
				{},
			);
			expect(statements.find((s) => s.sql.startsWith('drop trigger'))).toMatchObject({
				destructive: false,
			});
			expect(statements.find((s) => s.sql.startsWith('create trigger'))!.sql)
				.toContain('before update of "amount", "fee" on "t"');
		});

		it('reordering the list is not a change at all', () => {
			const { statements } = diffSnapshots(
				guarded(['amount', 'fee'], '"amount" > 0'),
				guarded(['fee', 'amount'], '"amount" > 0'),
				{},
			);
			expect(statements).toEqual([]);
		});
	});

	// `BEFORE UPDATE OF` used to be lumped in with `WHEN` as "conditional, so not
	// the guard". It is a different kind of conditional: `WHEN` decides per row,
	// `OF` decides per column and freezes the ones it names for every row. Reading
	// it as `false` hid orm-d1's own trigger from `apply`, which treats anything
	// it does not recognise as a foreign trigger it must not touch.
	describe('column-scoped guards', () => {
		it('reports the column list instead of true', () => {
			const scoped = 'CREATE TRIGGER g BEFORE UPDATE OF "kind", "amount" ON "events" '
				+ "BEGIN SELECT RAISE(ABORT, 'no'); END";
			expect(appendOnlyTriggerGuard(scoped, 'events')).toEqual(['amount', 'kind']);
			expect(isAppendOnlyTrigger(scoped, 'events')).toBe(true);
		});

		it('round-trips what the generator emits, in normalised order', () => {
			const sql = appendOnlyTrigger('events', ['kind', 'amount']);
			expect(sql).toContain('before update of "amount", "kind" on "events"');
			expect(appendOnlyTriggerGuard(sql, 'events')).toEqual(['amount', 'kind']);
		});

		it('keeps the case a column was declared with', () => {
			const sql = appendOnlyTrigger('events', ['recordedAt']);
			expect(appendOnlyTriggerGuard(sql, 'events')).toEqual(['recordedAt']);
		});

		it('reads an unquoted list, and one with odd spacing', () => {
			const scoped = 'CREATE TRIGGER g BEFORE UPDATE OF kind ,  amount ON "events" '
				+ "BEGIN SELECT RAISE(ABORT, 'no'); END";
			expect(appendOnlyTriggerGuard(scoped, 'events')).toEqual(['amount', 'kind']);
		});

		it('a WHEN clause still disqualifies it, column list or not', () => {
			const both = 'CREATE TRIGGER g BEFORE UPDATE OF "kind" ON "events" WHEN new.kind IS NULL '
				+ "BEGIN SELECT RAISE(ABORT, 'no'); END";
			expect(appendOnlyTriggerGuard(both, 'events')).toBe(false);
		});

		it('a whole-table guard is still true, not a list', () => {
			expect(appendOnlyTriggerGuard(appendOnlyTrigger('events'), 'events')).toBe(true);
		});
	});
});

describe('table options that SQLite would reject', () => {
	it('refuses WITHOUT ROWID on a table with no primary key', () => {
		const t = sqliteTable('no_pk', { a: text('a').notNull() });
		expect(validateTableOptions(t, { withoutRowid: true })).toMatch(/no primary key/);
		expect(validateTableOptions(t, { withoutRowid: false })).toBeUndefined();
	});

	it('refuses STRICT on a table with a NUMERIC column', () => {
		// Verified against D1: `unknown datatype ... "NUMERIC"`.
		const t = sqliteTable('money', { id: text('id').primaryKey(), amount: numeric('amount') });
		expect(validateTableOptions(t, { strict: true })).toMatch(/NUMERIC/);
	});

	it('accepts a table whose columns are all in the STRICT allow-list', () => {
		const t = sqliteTable('ok', {
			id: text('id').primaryKey(),
			n: integer('n'),
			r: real('r'),
			b: blob('b'),
		});
		expect(validateTableOptions(t, { strict: true, withoutRowid: true })).toBeUndefined();
	});

	it('accepts STRICT with a length-bearing text column (getSQLType() says text(255), DDL emits bare text)', () => {
		// `[F-012]`: `getSQLType()` is Drizzle-faithful and includes the length,
		// but STRICT's own check (`typeName()`) reads `declaredType ?? type`
		// directly, never `getSQLType()`, so a `text({length})` column stays
		// STRICT-legal — this pins that decoupling.
		const t = sqliteTable('with_len', {
			id: text('id').primaryKey(),
			name: text('name', { length: 255 }),
		});
		expect(t.name.getSQLType()).toBe('text(255)');
		expect(validateTableOptions(t, { strict: true })).toBeUndefined();
	});

	it('refuses AUTOINCREMENT on a WITHOUT ROWID table', () => {
		// SQLite: `AUTOINCREMENT not allowed on WITHOUT ROWID tables`. Same
		// family as the two above, and the same consequence if it slips through:
		// a migration that reads fine and fails on apply.
		const t = sqliteTable('log', { id: integer('id').primaryKey({ autoIncrement: true }) });
		expect(validateTableOptions(t, { withoutRowid: true })).toMatch(/AUTOINCREMENT/);
		expect(validateTableOptions(t, { withoutRowid: false })).toBeUndefined();
	});

	it('refuses STRICT on a customType column whose declared spelling is not an allowed type', () => {
		// `varchar(10)` and `bigint` both reduce to an allowed *affinity*
		// (`text`, `integer`), which used to be what this check compared — but
		// the DDL emits the literal declared string, and D1 rejects both of
		// those spellings under STRICT with `unknown datatype`.
		const varchar = sqliteTable('sv', {
			id: text('id').primaryKey(),
			amount: customType<string>({ dataType: () => 'varchar(10)' })('amount'),
		});
		expect(validateTableOptions(varchar, { strict: true })).toMatch(/VARCHAR\(10\)/);

		const bigint = sqliteTable('sb', {
			id: text('id').primaryKey(),
			amount: customType<bigint>({ dataType: () => 'bigint' })('amount'),
		});
		expect(validateTableOptions(bigint, { strict: true })).toMatch(/BIGINT/);
	});

	it('accepts a customType column whose declared spelling is STRICT-legal', () => {
		for (const declared of ['int', 'integer', 'real', 'text', 'blob', 'any']) {
			const t = sqliteTable('sok', {
				id: text('id').primaryKey(),
				v: customType<string>({ dataType: () => declared })('v'),
			});
			expect(validateTableOptions(t, { strict: true })).toBeUndefined();
		}
	});

	it('rejects a duplicate table in tableOptions rather than letting one win', () => {
		const t = sqliteTable('dup', { id: text('id').primaryKey() });
		expect(() => tableOptions([[t, { strict: true }], [t, { strict: false }]])).toThrow(/declared twice/);
	});
});

describe('splitting a migration that contains a trigger', () => {
	it('keeps the trigger body whole instead of cutting it at its semicolons', () => {
		// The failure was total: the fragment ending at `begin` came back as its
		// own statement and SQLite rejected it with `incomplete input`, so any
		// migration creating a trigger could not be applied at all.
		const migration = 'create table "t" ("a" text);\n'
			+ 'create trigger "t_no_update"\n'
			+ 'before update on "t"\n'
			+ 'begin\n'
			+ "\tselect raise(abort, 't is append-only: UPDATE is prohibited');\n"
			+ 'end;\n'
			+ 'create index "t_a_idx" on "t" ("a");';

		const statements = splitStatements(migration);
		expect(statements).toHaveLength(3);
		expect(statements[1]).toContain('raise(abort');
		expect(statements[1]!.trimEnd().endsWith('end')).toBe(true);
		expect(statements[2]).toMatch(/^create index/);
	});

	// The guard's own message ends in "…is prohibited", but a hand-written one
	// need not: counting BEGIN/CASE/END over the raw text closed the body at the
	// word `end` inside the literal and handed the applier `incomplete input` —
	// the very failure the trigger-aware split exists to prevent.
	it('ignores BEGIN, CASE and END inside quoted text', () => {
		const migration = 'create trigger "x_no_update"\n'
			+ 'before update on "x"\n'
			+ 'begin\n'
			+ "\tselect raise(abort, 'cannot edit an entry once the season has come to an end');\n"
			+ 'end;\n'
			+ 'create index "i" on "a" ("id");';

		const statements = splitStatements(migration);
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain('come to an end');
		expect(statements[0]!.trimEnd().endsWith('end')).toBe(true);
		expect(statements[1]).toMatch(/^create index/);
	});

	it('ignores a quoted identifier that spells a keyword', () => {
		const migration = 'create trigger "g" before update on "end" begin '
			+ "select raise(abort, 'no'); end;\n"
			+ 'create table "u" ("b" text);';

		expect(splitStatements(migration)).toHaveLength(2);
	});

	it('still splits ordinary statements, and a CASE inside a trigger body', () => {
		const migration = 'create trigger "g" before update on "t" begin '
			+ "select case when 1 then raise(abort, 'no') else 1 end; end;\n"
			+ 'create table "u" ("b" text);';

		const statements = splitStatements(migration);
		expect(statements).toHaveLength(2);
		expect(statements[1]).toMatch(/^create table "u"/);
	});
});
