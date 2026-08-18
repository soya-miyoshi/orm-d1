/**
 * A database orm-d1 did not create.
 *
 * Every other test in this suite starts from an orm-d1 schema, so both sides of
 * every comparison only ever see the five canonical type spellings —
 * `integer`, `text`, `real`, `blob`, `numeric`. The fuzz generator draws from
 * three of those. That is the wrong shape for `pull`, whose entire purpose is a
 * database somebody else built: real SQLite records whatever the `CREATE TABLE`
 * said, and `VARCHAR(255)`, `BOOLEAN`, `DATETIME` and `INT` are all ordinary.
 *
 * Compared by raw string those look like a type change on every column, which
 * `generate` then turns into a destructive rebuild that rewrites the live types
 * for no benefit — on the onboarding command, against a database that was
 * correct before it ran. Compared by SQLite's own affinity rules they are what
 * they always were.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, checkForeignTriggerConflicts, introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots, renderMigration } from '../../src/core/diff.js';
import { appendOnlyTriggerGuard } from '../../src/core/introspect.js';
import { createTableFromSnapshot, normalizeUniqueColumn, typeAffinity } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	async all<T>(sql: string): Promise<T[]> {
		return (await DB.prepare(sql).all()).results as T[];
	},
	async batch(statements: readonly string[]): Promise<void> {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

/** Types a hand-written or another tool's schema uses, none of them canonical. */
const LEGACY = `create table "accounts" (
	"id" INTEGER primary key,
	"email" VARCHAR(255) not null unique,
	"balance" NUMERIC,
	"active" BOOLEAN default 0,
	"created_at" DATETIME,
	"score" DOUBLE,
	"payload" BLOB,
	"tag" CHARACTER(8)
)`;

beforeEach(async () => {
	await DB.prepare('drop table if exists "accounts"').run();
	await DB.prepare(LEGACY).run();
});

describe('SQLite type affinity', () => {
	it('follows the documented rules, including the INT-before-CHAR ordering', () => {
		expect(typeAffinity('INTEGER')).toBe('integer');
		expect(typeAffinity('INT')).toBe('integer');
		expect(typeAffinity('VARCHAR(255)')).toBe('text');
		expect(typeAffinity('CHARACTER(8)')).toBe('text');
		expect(typeAffinity('CLOB')).toBe('text');
		expect(typeAffinity('BLOB')).toBe('blob');
		expect(typeAffinity('')).toBe('blob');
		expect(typeAffinity('DOUBLE')).toBe('real');
		expect(typeAffinity('FLOAT')).toBe('real');
		expect(typeAffinity('BOOLEAN')).toBe('numeric');
		expect(typeAffinity('DATETIME')).toBe('numeric');
		expect(typeAffinity('NUMERIC')).toBe('numeric');
		// SQLite's own worked example: POINT contains INT, so it is INTEGER.
		expect(typeAffinity('POINT')).toBe('integer');
	});
});

describe('introspecting a database orm-d1 did not write', () => {
	it('reads every column back', async () => {
		const snapshot = await introspect(runner);
		expect(Object.keys(snapshot.tables['accounts']!.columns)).toEqual([
			'id',
			'email',
			'balance',
			'active',
			'created_at',
			'score',
			'payload',
			'tag',
		]);
	});

	it('is stable against itself — no migration for a database nobody changed', async () => {
		// The failure this file exists for. `pull` writes this snapshot and a
		// module beside it; if introspecting twice already disagreed, nothing
		// downstream could be stable either.
		const first = await introspect(runner);
		const second = await introspect(runner);
		const { statements, errors } = diffSnapshots(first, second);

		expect(errors).toEqual([]);
		expect(statements).toEqual([]);
	});

	it('does not see a type change merely because the spelling is not canonical', async () => {
		const live = await introspect(runner);

		// The same table as an orm-d1 schema would describe it: canonical
		// spellings throughout, which is what `pull` writes into the module.
		const canonical = structuredClone(live) as typeof live;
		const columns = canonical.tables['accounts']!.columns as Record<string, { type: string }>;
		columns['email']!.type = 'text';
		columns['active']!.type = 'numeric';
		columns['created_at']!.type = 'numeric';
		columns['score']!.type = 'real';
		columns['tag']!.type = 'text';

		const { statements, errors } = diffSnapshots(live, canonical);
		expect(errors).toEqual([]);
		// Raw-string comparison produced a full rebuild here: create __new_,
		// copy, DESTRUCTIVE drop, rename.
		expect(statements).toEqual([]);
	});

	it('still sees a change when the affinity genuinely differs', async () => {
		const live = await introspect(runner);
		const changed = structuredClone(live) as typeof live;
		// TEXT -> INTEGER is a real change, and must not be swallowed.
		(changed.tables['accounts']!.columns as Record<string, { type: string }>)['email']!.type = 'integer';

		const { statements } = diffSnapshots(live, changed);
		expect(statements.length).toBeGreaterThan(0);
		expect(statements.some((s) => s.sql.includes('__new_accounts'))).toBe(true);
	});

	it('captures a column-level COLLATE and round-trips it through createTableFromSnapshot', async () => {
		// F-101: no pragma reports a column's own COLLATE, so it has to be
		// parsed out of the CREATE TABLE text the same way `hasAutoincrement`
		// and `parseGenerated` already do.
		await DB.prepare('drop table if exists "people"').run();
		await DB.prepare('create table "people" ("id" integer primary key, "email" text collate nocase not null)')
			.run();

		const live = await introspect(runner);
		const email = live.tables['people']!.columns['email']!;
		expect(email.collate).toBe('nocase');

		const rendered = createTableFromSnapshot(live.tables['people']!);
		expect(rendered).toContain('collate nocase');
	});

	it('[F-106] does not attribute a COLLATE inside a column-level CHECK to the column, and the rebuild applies', async () => {
		// On `main` this applied cleanly. The regression: a `COLLATE` living
		// inside the CHECK's own sub-expression used to be captured as the
		// column's own, so the next rebuild invented `COLLATE NOCASE` over a
		// live BINARY column with a unique index on it — and applying that
		// against real D1 fails with a UNIQUE constraint violation, since
		// 'active' and 'ACTIVE' only collide once NOCASE is (wrongly) added.
		await DB.prepare('drop table if exists "q"').run();
		await DB.prepare(
			'create table "q" ("id" integer primary key, "status" text not null '
				+ 'constraint "q_check_1" check ("status" collate nocase in (\'active\',\'closed\')))',
		).run();
		await DB.prepare('create unique index "q_status" on "q" ("status")').run();
		await DB.prepare('insert into "q" ("id", "status") values (1, \'active\'), (2, \'ACTIVE\')').run();

		const live = await introspect(runner);
		const status = live.tables['q']!.columns['status']!;
		expect(status.collate).toBeUndefined();

		// A rebuild forced for an unrelated reason must not resurrect a
		// COLLATE the column never had.
		const changed = structuredClone(live) as typeof live;
		(changed.tables['q']!.columns as Record<string, { type: string }>)['id']!.type = 'text';
		const { statements, errors } = diffSnapshots(live, changed);
		expect(errors).toEqual([]);

		// The rebuild's CHECK clause legitimately still says `collate nocase` —
		// that belongs to the sub-expression, not the column. What must not
		// appear is a `COLLATE` on the column's own definition line.
		const createTemp = statements.find((s) => s.sql.includes('create table "__new_q"'));
		const statusLine = createTemp?.sql.split('\n').find((line) => line.trim().startsWith('"status"'));
		expect(statusLine).not.toContain('collate');

		// On the regression this migration fails to apply at all: D1 rejects it
		// with a UNIQUE constraint violation once the invented COLLATE NOCASE
		// makes 'active' and 'ACTIVE' collide.
		const sql = renderMigration({ statements, errors, warnings: [] });
		await expect(applyMigrations(runner, [{ tag: 'm_q_rebuild', sql }])).resolves.toBeDefined();
	});

	it('[Finding 2] a composite PRIMARY KEY member COLLATE survives an unrelated rebuild through diffSnapshots', async () => {
		// The schema DSL has no `.collate()` spelling for a primary key member
		// any more than it does for a unique constraint member (`docs/04`), so a
		// schema-derived `after.compositePrimaryKeys` can never state one. This
		// proves the carry-forward machinery (`carryForwardPrimaryKeyCollation`
		// in `diff.ts`) actually reaches a live PK member's collation when
		// `diffSnapshots` forces a rebuild for a completely unrelated reason —
		// not just when `createTableFromSnapshot` is called directly on an
		// already-collation-bearing table (that path never lost it in the
		// first place).
		await DB.prepare('drop table if exists "t24"').run();
		await DB.prepare(
			'create table "t24" ("a" text, "b" text, constraint "t24_pk" primary key ("a" collate nocase, "b"))',
		).run();
		await DB.prepare('insert into "t24" ("a", "b") values (\'x\', \'y\')').run();

		const live = await introspect(runner);
		const livePk = Object.values(live.tables['t24']!.compositePrimaryKeys)[0]!;
		expect(normalizeUniqueColumn(livePk.columns[0]!)).toEqual({ name: 'a', collate: 'nocase' });

		// A schema-derived `after`: same PK members, but the member's collation
		// is structurally absent (as `snapshotFromSchema` would leave it), and
		// the table is marked STRICT — a real, unrelated reason to force a full
		// rebuild that has nothing to do with the primary key.
		const after = structuredClone(live) as typeof live;
		(after as { origin: string }).origin = 'schema';
		const afterTable = after.tables['t24']!;
		(afterTable as { strict: boolean }).strict = true;
		const afterPk = Object.values(afterTable.compositePrimaryKeys)[0]!;
		afterPk.columns = afterPk.columns.map((c) => normalizeUniqueColumn(c).name);

		const { statements, errors } = diffSnapshots(live, after);
		expect(errors).toEqual([]);
		expect(statements.some((s) => s.sql.includes('__new_t24'))).toBe(true);

		const sql = renderMigration({ statements, errors, warnings: [] });
		await applyMigrations(runner, [{ tag: 'm_t24_rebuild', sql }]);

		const rebuilt = await introspect(runner);
		const rebuiltPk = Object.values(rebuilt.tables['t24']!.compositePrimaryKeys)[0]!;
		expect(normalizeUniqueColumn(rebuiltPk.columns[0]!)).toEqual({ name: 'a', collate: 'nocase' });

		// Prove it actually enforces the constraint, not just that the snapshot
		// says so: a case-differing "a" with the same "b" must still collide.
		await expect(
			DB.prepare('insert into "t24" ("a", "b") values (\'X\', \'y\')').run(),
		).rejects.toThrow();
	});

	it('does not mistake a hand-written conditional guard for the append-only trigger', async () => {
		// The standard conditional-constraint idiom: a bare `SELECT RAISE(ABORT,
		// …) WHERE <cond>` — not orm-d1's unconditional guard.
		await DB.prepare(
			`create trigger "accounts_balance_immutable" before update on "accounts" begin `
				+ `select raise(abort, 'balance is immutable') where new."balance" <> old."balance"; end`,
		).run();

		const foreignTriggers: Record<string, string[]> = {};
		const live = await introspect(runner, foreignTriggers);
		expect(foreignTriggers['accounts']).toEqual(['accounts_balance_immutable']);

		// Force a rebuild of "accounts" via a genuine affinity change, same as
		// the test above.
		const changed = structuredClone(live) as typeof live;
		(changed.tables['accounts']!.columns as Record<string, { type: string }>)['email']!.type = 'integer';

		const { errors } = diffSnapshots(live, changed, { foreignTriggers });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.includes('accounts_balance_immutable'))).toBe(true);

		await expect(checkForeignTriggerConflicts(runner, [{
			tag: '0001_change',
			sql: `create table "__new_accounts" ("id" integer primary key); `
				+ `drop table "accounts"; alter table "__new_accounts" rename to "accounts"`,
		}])).rejects.toThrow(/accounts_balance_immutable/);
	});

	describe('a quoted identifier containing -- or /*', () => {
		// Regression: `blankLiterals` was comment-aware but not
		// identifier-aware, so `--` or `/*` inside a *quoted identifier* still
		// started a "comment" that blanked everything to end of line (or to the
		// next unrelated `*/`) — the exact founding failure mode `kit/README.md`
		// exists to prevent, reintroduced inside the fix meant to prevent it.

		it('(a) still captures a COLLATE after an identifier containing --, and the rebuild refuses a case-insensitive duplicate', async () => {
			await DB.prepare('drop table if exists "dd"').run();
			await DB.prepare(
				'create table "dd" ("id" integer primary key, "a--b" text, '
					+ '"email" text collate nocase not null)',
			).run();
			await DB.prepare('create unique index "dd_email" on "dd" ("email")').run();

			const live = await introspect(runner);
			expect(live.tables['dd']!.columns['email']!.collate).toBe('nocase');

			await DB.prepare('insert into "dd" ("id", "a--b", "email") values (1, \'x\', \'alice@x.com\')').run();
			await expect(
				DB.prepare('insert into "dd" ("id", "a--b", "email") values (2, \'y\', \'ALICE@x.com\')').run(),
			).rejects.toThrow();
		});

		it('(b) a GENERATED column anchored past an identifier containing -- still parses its expression', async () => {
			await DB.prepare('drop table if exists "gg"').run();
			await DB.prepare(
				'create table "gg" ("id" integer primary key, "a--b" text, '
					+ '"up" text generated always as (upper("a--b")) virtual)',
			).run();

			const live = await introspect(runner);
			const generated = live.tables['gg']!.columns['up']!.generated;
			expect(generated).toBeDefined();
			expect(generated!.as).toContain('upper');
			expect(generated!.mode).toBe('virtual');

			const rendered = createTableFromSnapshot(live.tables['gg']!);
			await DB.prepare('drop table if exists "gg_rebuilt"').run();
			await DB.prepare(rendered.replace('"gg"', '"gg_rebuilt"')).run();
		});

		it('(c) a CHECK anchored past an identifier containing -- is still captured', async () => {
			await DB.prepare('drop table if exists "t"').run();
			await DB.prepare(
				'create table "t" ("a--b" integer, "z" text not null, constraint "c1" check ("a--b" > 0))',
			).run();

			const live = await introspect(runner);
			expect(Object.keys(live.tables['t']!.checkConstraints)).toContain('c1');
			expect(Object.keys(live.tables['t']!.columns)).toContain('z');
		});

		it('(d) the append-only trigger guard is still recognised when the table name contains --', async () => {
			await DB.prepare('drop table if exists "t--x"').run();
			await DB.prepare('create table "t--x" ("id" integer primary key)').run();
			await DB.prepare(
				'create trigger "t--x_no_update" before update on "t--x" '
					+ "begin select raise(abort, 'append-only'); end",
			).run();

			expect(appendOnlyTriggerGuard(
				await DB.prepare('select sql from sqlite_master where type = \'trigger\' and name = \'t--x_no_update\'')
					.first<{ sql: string }>()
					.then((row) => row!.sql),
				't--x',
			)).toBe(true);
		});
	});

	it('[F-108] a check constraint whose expression references a column named with an embedded ( is captured, and later columns survive', async () => {
		await DB.prepare('drop table if exists "ck"').run();
		await DB.prepare(
			'create table "ck" ("id" integer primary key, "a(" text, "b" text not null, '
				+ 'constraint "ck_1" check ("a(" <> \'\'))',
		).run();

		const live = await introspect(runner);
		expect(live.tables['ck']!.checkConstraints['ck_1']?.value.trim()).toBe('"a(" <> \'\'');
		expect(Object.keys(live.tables['ck']!.columns)).toContain('b');
	});

	it('[F-108] a unique index with two members, one containing an embedded (, keeps both members', async () => {
		await DB.prepare('drop table if exists "ux"').run();
		await DB.prepare('create table "ux" ("id" integer primary key, "email" text, "a(" text)').run();
		await DB.prepare('create unique index "ux_u" on "ux" (lower("email"), "a(")').run();

		const live = await introspect(runner);
		const index = live.tables['ux']!.indexes['ux_u'];
		expect(index).toBeDefined();
		expect(index!.columns).toHaveLength(2);
	});

	it('a constraint named *_collate does not have its own name mistaken for a COLLATE clause', async () => {
		await DB.prepare('drop table if exists "mc"').run();
		await DB.prepare(
			'create table "mc" ("id" integer primary key, '
				+ '"b" text constraint b_collate check ("b" <> \'\'), "c" text)',
		).run();

		const live = await introspect(runner);
		expect(live.tables['mc']!.columns['b']!.collate).toBeUndefined();

		const rendered = createTableFromSnapshot(live.tables['mc']!);
		await DB.prepare('drop table if exists "mc_rebuilt"').run();
		await DB.prepare(rendered.replace('"mc"', '"mc_rebuilt"')).run();
	});

	it('captures COLLATE spelled with [brackets] and `backticks`, not just "double quotes"', async () => {
		await DB.prepare('drop table if exists "bt"').run();
		await DB.prepare(
			'create table "bt" ("id" integer primary key, '
				+ '"a" text collate [NOCASE], "b" text collate `NOCASE`)',
		).run();

		const live = await introspect(runner);
		expect(live.tables['bt']!.columns['a']!.collate).toBe('NOCASE');
		expect(live.tables['bt']!.columns['b']!.collate).toBe('NOCASE');

		const rendered = createTableFromSnapshot(live.tables['bt']!);
		expect(rendered.toLowerCase()).toContain('collate');
	});
});

describe('introspect: foreignTriggers out-param is prototype-safe', () => {
	it('records a foreign trigger on a live table literally named "constructor" without throwing', async () => {
		// `introspect(runner, {})` — every real caller passes a plain object
		// literal, which inherits `Object.prototype.constructor` (a function,
		// not `undefined`). If the out-param is populated with
		// `(foreignTriggers[row.tbl_name] ??= []).push(...)`, a live table named
		// "constructor" resolves that lookup to the inherited member instead of
		// `undefined`, and `.push` throws `TypeError: ... .push is not a
		// function` — instead of recording the trigger.
		await DB.prepare('drop table if exists "constructor"').run();
		await DB.prepare('create table "constructor" ("id" integer primary key)').run();
		await DB.prepare(
			'create trigger "constructor_audit" after insert on "constructor" begin select 1; end',
		).run();

		const foreignTriggers: Record<string, string[]> = {};
		await expect(introspect(runner, foreignTriggers)).resolves.toBeDefined();
		expect(foreignTriggers['constructor']).toEqual(['constructor_audit']);

		await DB.prepare('drop trigger "constructor_audit"').run();
		await DB.prepare('drop table "constructor"').run();
	});
});
