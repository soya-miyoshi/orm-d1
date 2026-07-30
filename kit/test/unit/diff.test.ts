import { blob, check, customType, foreignKey, index, integer, numeric, primaryKey, real, sql, sqliteTable, text, unique, uniqueIndex } from 'd1zzle';
import { tableOptions, validateTableOptions } from 'd1zzle/ddl';
import type { Column } from 'd1zzle';
import { describe, expect, it } from 'vitest';
import { diffSnapshots, renderMigration } from '../../src/core/diff.js';
import { applicableStatements, splitStatements } from '../../src/core/sql.js';
import { hasAutoincrement, isAppendOnlyTrigger, parseChecks, parseGenerated, parseTableOptions } from '../../src/core/introspect.js';
import { assertRoundTrip, emptySnapshot, snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

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
	};

	for (const [description, table] of Object.entries(fixtures)) {
		it(`round-trips ${description}`, () => {
			expect(() => assertRoundTrip(table)).not.toThrow();
		});
	}
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

		const columns = 'CREATE TRIGGER validate BEFORE UPDATE OF "kind" ON "events" '
			+ "BEGIN SELECT RAISE(ABORT, 'no'); END";
		expect(isAppendOnlyTrigger(columns, 'events')).toBe(false);

		// Aborts, but only down one branch of the CASE.
		const branch = 'CREATE TRIGGER validate BEFORE UPDATE ON "events" BEGIN '
			+ "SELECT CASE WHEN new.kind IS NULL THEN RAISE(ABORT, 'no') END; END";
		expect(isAppendOnlyTrigger(branch, 'events')).toBe(false);

		// And a guard that does something *else* as well is not the guard either.
		const extra = 'CREATE TRIGGER g BEFORE UPDATE ON "events" BEGIN '
			+ "INSERT INTO audit VALUES (1); SELECT RAISE(ABORT, 'no'); END";
		expect(isAppendOnlyTrigger(extra, 'events')).toBe(false);
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
