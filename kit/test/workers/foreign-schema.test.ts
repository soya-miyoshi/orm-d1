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
import { checkForeignTriggerConflicts, introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots } from '../../src/core/diff.js';
import { typeAffinity } from '../../src/core/snapshot.js';

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
});
