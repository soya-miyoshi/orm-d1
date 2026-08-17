/**
 * `verify` replays the history into a throwaway database, and the runner it
 * replays into has to keep the `SqlRunner` contract: a batch is atomic.
 */
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verify } from '../../src/node/commands.js';
import type { Config } from '../../src/node/config.js';
import { scratchRunner } from '../../src/node/runners.js';

describe('scratchRunner', () => {
	// `defer_foreign_keys` is scoped to the current transaction, and a rebuild
	// emits it as the batch's first statement. Without a transaction around the
	// batch it is cleared at the first autocommit — i.e. immediately — and the
	// rebuild's `drop table` on a referenced table fails with FOREIGN KEY
	// constraint failed. Only a migration carrying rows hits it, so verify on an
	// empty replay stayed green while CI failed on the real history.
	it('runs a batch in one transaction, so defer_foreign_keys survives it', async () => {
		const runner = await scratchRunner();
		await runner.batch([
			'create table parent (id integer primary key)',
			'create table child (id integer primary key, parent_id integer references parent(id))',
		]);

		// The child arrives before the parent it points at: legal only while the
		// checks are deferred to the commit, which is exactly what the pragma
		// asks for and exactly what an autocommit-per-statement runner loses.
		await runner.batch([
			'pragma defer_foreign_keys = ON',
			'insert into child values (1, 1)',
			'insert into parent values (1)',
		]);

		expect(await runner.all('select id from child')).toEqual([{ id: 1 }]);
	});

	it('rolls a failed batch back rather than leaving half of it applied', async () => {
		const runner = await scratchRunner();
		await runner.batch(['create table t (id integer primary key)']);
		await expect(runner.batch(['insert into t values (1)', 'this is not sql'])).rejects.toThrow();

		expect(await runner.all('select count(*) as n from t')).toEqual([{ n: 0 }]);
	});
});

describe('verify', () => {
	const project = async (migrations: [tag: string, sql: string][]): Promise<Config> => {
		const out = join(mkdtempSync(join(tmpdir(), 'orm-d1-verify-')), 'migrations');
		await mkdir(join(out, 'meta'), { recursive: true });
		await writeFile(
			join(out, 'meta', '_journal.json'),
			JSON.stringify({
				version: '7',
				dialect: 'sqlite',
				entries: migrations.map(([tag], idx) => ({ idx, version: '7', when: 0, tag, breakpoints: true })),
			}),
		);
		for (const [tag, sql] of migrations) await writeFile(join(out, `${tag}.sql`), sql);

		return { schema: './schema.ts', out, d1: {} } as Config;
	};

	const context = (config: Config, lines: string[] = []) => ({
		cwd: process.cwd(),
		config,
		log: (message: string) => {
			lines.push(message);
		},
		now: () => 0,
	});

	// The count is what actually replayed. Reporting the journal's length on the
	// failure path reads as a complete replay that merely disagreed with the
	// schema — a different diagnosis from "migration 2 of 3 will not apply".
	it('counts only the migrations that replayed when one fails', async () => {
		const config = await project([
			['0000_first', 'create table a (id integer primary key);'],
			['0001_broken', 'create table a (id integer primary key);'],
			['0002_never_reached', 'create table b (id integer primary key);'],
		]);

		const result = await verify(context(config));
		expect(result.ok).toBe(false);
		expect(result.applied).toBe(1);
		expect(result.differences[0]).toMatch(/^0001_broken failed to apply/);
	});

	// The CLI turns `ok: false` into exit 1 and prints nothing of its own, so a
	// failure path that logs nothing is a command that fails in total silence —
	// which is what this one did: no tag, no reason, no exit-code explanation.
	it('says which migration stopped the replay instead of failing silently', async () => {
		const config = await project([
			['0000_first', 'create table a (id integer primary key);'],
			['0001_broken', 'create table a (id integer primary key);'],
		]);

		const lines: string[] = [];
		await verify(context(config, lines));

		expect(lines.join('\n')).toMatch(/0001_broken/);
		expect(lines.join('\n')).toMatch(/does NOT add up to the schema/);
	});
});
