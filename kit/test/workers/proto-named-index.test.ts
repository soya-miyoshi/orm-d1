/**
 * An index or CHECK constraint whose name is a JS `Object.prototype` member.
 *
 * `indexes['__proto__'] = …` on a plain object does not mis-*read* — it adds no
 * own key at all, because the inherited setter reassigns the object's prototype
 * instead. So the constraint disappears from the introspected snapshot outright:
 * `pull` writes a schema and a baseline without it, `check` reports it missing
 * forever, and the next rebuild of the table recreates it without the
 * uniqueness. That is the constraint-silently-vanishes class this project
 * exists for, and `__proto__` is a legal SQLite identifier.
 *
 * This has to run against a real database: the defect is in what
 * `snapshotFromIntrospection` records, so anything short of introspecting real
 * `sqlite_master` output proves nothing.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	async all<T>(sql: string): Promise<T[]> {
		return (await DB.prepare(sql).all()).results as T[];
	},
	async batch(statements: readonly string[]): Promise<void> {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

describe('a constraint named like an Object.prototype member survives introspection', () => {
	beforeEach(async () => {
		const existing = await runner.all<{ name: string }>(
			`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'`,
		);
		for (const { name } of existing) await runner.batch([`drop table "${name}"`]);
	});

	it('keeps a unique index named __proto__', async () => {
		await runner.batch([
			'create table "users" ("id" integer primary key, "email" text)',
			'create unique index "__proto__" on "users" ("email")',
		]);

		const snapshot = await introspect(runner);
		const users = snapshot.tables['users']!;

		expect(Object.keys(users.indexes)).toContain('__proto__');
		expect(users.indexes['__proto__']!.isUnique).toBe(true);
	});

	it('keeps a check constraint named __proto__', async () => {
		await runner.batch([
			'create table "t" ("id" integer primary key, "a" integer, constraint "__proto__" check ("a" > 0))',
		]);

		const snapshot = await introspect(runner);
		expect(Object.keys(snapshot.tables['t']!.checkConstraints)).toContain('__proto__');
	});
});
