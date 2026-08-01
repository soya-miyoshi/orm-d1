/**
 * Environment-scoped configuration resolution.
 *
 * The fixture is a real project's `wrangler.toml`: a top-level block holding the
 * Miniflare placeholder, plus `stg` and `prd` blocks that reuse the *same*
 * binding name and commit a placeholder id substituted at deploy time. Every
 * way of getting this wrong points a migration at a database the operator did
 * not name, which is not undoable — so the assertions here are mostly about
 * refusing rather than about resolving.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentFlag, parseArgs } from '../../src/cli.js';
import { describeResolution, loadConfig, readWranglerConfig, resolveEnvironment } from '../../src/node/config.js';
import { resolveRunner } from '../../src/node/commands.js';

const temp = () => mkdtemp(join(tmpdir(), 'd1zzle-env-'));

const WRANGLER_TOML = `name = "acme-api"
main = "src/index.ts"
account_id = "top-level-account"

[[d1_databases]]                       # local (miniflare)
binding = "DB"
database_name = "acme-db-local"
database_id = "local"

[env.stg]
account_id = "stg-account"

[[env.stg.d1_databases]]
binding = "DB"
database_name = "acme-db-stg"
database_id = "__CLOUDFLARE_D1_DATABASE_ID__"

[[env.prd.d1_databases]]
binding = "DB"
database_name = "acme-db-prd"
database_id = "__CLOUDFLARE_D1_DATABASE_ID__"
`;

/** The same project expressed as wrangler JSONC, comments and all. */
const WRANGLER_JSONC = `{
	"name": "acme-api",
	"account_id": "top-level-account",
	// local (miniflare)
	"d1_databases": [
		{ "binding": "DB", "database_name": "acme-db-local", "database_id": "local" },
	],
	"env": {
		"stg": {
			"account_id": "stg-account",
			"d1_databases": [
				{ "binding": "DB", "database_name": "acme-db-stg", "database_id": "stg-id-1111" },
			],
		},
		"prd": {
			"d1_databases": [
				{ "binding": "DB", "database_name": "acme-db-prd", "database_id": "prd-id-2222" },
			],
		},
	},
}`;

/** A project on disk: a wrangler config plus a minimal d1zzle config. */
const project = async (wrangler: string, file = 'wrangler.toml', d1zzleConfig = `{ schema: './schema.ts' }`) => {
	const dir = await temp();
	await writeFile(join(dir, file), wrangler);
	await writeFile(join(dir, 'd1zzle.config.ts'), `export default ${d1zzleConfig};\n`);
	return dir;
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('parsing environment-scoped wrangler config', () => {
	it('reads [[env.<name>.d1_databases]] out of TOML, alongside the top-level block', async () => {
		// The old parser matched the literal string `[[d1_databases]]` and treated
		// every other `[` line as "section over", so both env blocks vanished and
		// `--remote` silently resolved the local placeholder.
		const dir = await project(WRANGLER_TOML);
		const config = await readWranglerConfig(dir);

		expect(config?.d1_databases).toEqual([
			{ binding: 'DB', database_name: 'acme-db-local', database_id: 'local' },
		]);
		expect(config?.account_id).toBe('top-level-account');
		expect(config?.env?.['stg']).toEqual({
			account_id: 'stg-account',
			d1_databases: [
				{ binding: 'DB', database_name: 'acme-db-stg', database_id: '__CLOUDFLARE_D1_DATABASE_ID__' },
			],
		});
		expect(config?.env?.['prd']?.d1_databases?.[0]?.database_name).toBe('acme-db-prd');
	});

	it('does not let keys from an unrelated array-of-tables leak into a d1 block', async () => {
		const dir = await project(
			'[[d1_databases]]\nbinding = "DB"\ndatabase_name = "app-db"\ndatabase_id = "abc"\n\n'
				+ '[[env.stg.kv_namespaces]]\nbinding = "KV"\ndatabase_id = "not-a-database"\n\n'
				+ '[triggers]\naccount_id = "not-the-account"\n',
		);
		const config = await readWranglerConfig(dir);

		expect(config?.d1_databases).toEqual([{ binding: 'DB', database_name: 'app-db', database_id: 'abc' }]);
		expect(config?.env?.['stg']?.d1_databases).toBeUndefined();
		expect(config?.account_id).toBeUndefined();
	});

	it('reads the JSON/JSONC "env" object too', async () => {
		const dir = await project(WRANGLER_JSONC, 'wrangler.jsonc');
		const config = await readWranglerConfig(dir);

		expect(config?.env?.['stg']?.d1_databases?.[0]?.database_id).toBe('stg-id-1111');
		expect(config?.env?.['prd']?.d1_databases?.[0]?.database_id).toBe('prd-id-2222');
	});
});

describe('selecting an environment', () => {
	it('resolves the named block, not the top-level one', async () => {
		const dir = await project(WRANGLER_JSONC, 'wrangler.jsonc');

		expect((await loadConfig(dir, undefined, 'prd')).d1).toMatchObject({
			binding: 'DB',
			env: 'prd',
			databaseName: 'acme-db-prd',
			databaseId: 'prd-id-2222',
		});
		// Same binding name in every block — resolving by binding alone is what
		// made these three indistinguishable.
		expect((await loadConfig(dir, undefined, 'stg')).d1.databaseId).toBe('stg-id-1111');
		expect((await loadConfig(dir)).d1.databaseId).toBe('local');
	});

	it('refuses to fall back to the top level when the environment is missing', async () => {
		// The whole point: wrangler treats d1_databases as non-inheritable, so a
		// fallback here would migrate a database wrangler would never have bound.
		const dir = await project(WRANGLER_TOML);

		await expect(loadConfig(dir, undefined, 'dev')).rejects.toThrow(/no "env\.dev" block/);
		await expect(loadConfig(dir, undefined, 'dev')).rejects.toThrow(/It defines: stg, prd\./);
		await expect(loadConfig(dir, undefined, 'dev')).rejects.toThrow(/Not falling back to the top-level block/);
	});

	it('refuses an environment block that declares no d1_databases', async () => {
		const dir = await project(
			'[[d1_databases]]\nbinding = "DB"\ndatabase_name = "app-db"\ndatabase_id = "abc"\n\n'
				+ '[env.stg]\naccount_id = "stg-account"\n',
		);

		await expect(loadConfig(dir, undefined, 'stg')).rejects.toThrow(/no d1_databases in it/);
		await expect(loadConfig(dir, undefined, 'stg')).rejects.toThrow(/does not inherit d1_databases/);
	});

	it('refuses --env when there is no wrangler config to select from', async () => {
		const dir = await temp();
		await writeFile(join(dir, 'd1zzle.config.ts'), `export default { schema: './schema.ts' };\n`);

		await expect(loadConfig(dir, undefined, 'stg')).rejects.toThrow(/no wrangler config was found/);
	});
});

describe('which environment', () => {
	it('prefers --env, then CLOUDFLARE_ENV, then d1.env', () => {
		expect(resolveEnvironment('flag', 'config', { CLOUDFLARE_ENV: 'variable' }))
			.toEqual({ value: 'flag', source: '--env' });
		expect(resolveEnvironment(undefined, undefined, { CLOUDFLARE_ENV: 'variable' }))
			.toEqual({ value: 'variable', source: 'CLOUDFLARE_ENV' });
		expect(resolveEnvironment(undefined, 'config', {}))
			.toMatchObject({ value: 'config' });
		expect(resolveEnvironment(undefined, undefined, {}).value).toBeUndefined();
	});

	it('refuses a CLOUDFLARE_ENV that disagrees with d1.env', () => {
		// Wrangler has no `d1.env`, so there is no wrangler behaviour to mirror and
		// nothing to justify picking a winner: a committed default quietly beating
		// the deploy job's own variable is how a migration lands on prd while the
		// deploy goes to stg.
		expect(() => resolveEnvironment(undefined, 'stg', { CLOUDFLARE_ENV: 'prd' }))
			.toThrow(/Refusing to guess which database you meant/);
		// Agreeing is not a conflict.
		expect(resolveEnvironment(undefined, 'stg', { CLOUDFLARE_ENV: 'stg' }).value).toBe('stg');
	});

	it('lets --env settle a disagreement, exactly as wrangler does', () => {
		expect(resolveEnvironment('prd', 'stg', { CLOUDFLARE_ENV: 'dev' }).value).toBe('prd');
	});

	it('reads d1.env from the config file', async () => {
		const dir = await project(WRANGLER_JSONC, 'wrangler.jsonc', `{ schema: './schema.ts', d1: { env: 'stg' } }`);
		expect((await loadConfig(dir)).d1.databaseId).toBe('stg-id-1111');
	});

	it('requires a value for --env, so a bare flag cannot mean "top level"', () => {
		expect(() => environmentFlag(parseArgs(['migrate', '--env', 'stg']).flags)).not.toThrow();
		expect(environmentFlag(parseArgs(['migrate', '--env', 'stg']).flags)).toBe('stg');
		expect(() => environmentFlag(parseArgs(['migrate', '--env']).flags)).toThrow(/expects an environment name/);
		expect(() => environmentFlag(parseArgs(['migrate', '--env', 'a', '--env', 'b']).flags))
			.toThrow(/expects an environment name/);
		expect(environmentFlag(parseArgs(['migrate']).flags)).toBeUndefined();
	});
});

describe('precedence of a resolved value', () => {
	it('takes d1zzle.config.ts over the environment variable over wrangler', async () => {
		vi.stubEnv('CLOUDFLARE_D1_DATABASE_ID', 'from-variable');

		const fromWrangler = await project(WRANGLER_JSONC, 'wrangler.jsonc');
		expect((await loadConfig(fromWrangler, undefined, 'stg')).d1.databaseId).toBe('from-variable');

		const fromConfig = await project(
			WRANGLER_JSONC,
			'wrangler.jsonc',
			`{ schema: './schema.ts', d1: { databaseId: 'from-config' } }`,
		);
		expect((await loadConfig(fromConfig, undefined, 'stg')).d1.databaseId).toBe('from-config');

		vi.unstubAllEnvs();
		expect((await loadConfig(fromWrangler, undefined, 'stg')).d1.databaseId).toBe('stg-id-1111');
	});

	it('lets CLOUDFLARE_D1_DATABASE_ID stand in for a committed placeholder', async () => {
		// The case that motivated this: the id is a secret, the file holds
		// `__CLOUDFLARE_D1_DATABASE_ID__`, and CI substitutes it at deploy time.
		vi.stubEnv('CLOUDFLARE_D1_DATABASE_ID', 'real-stg-id-9999');
		const dir = await project(WRANGLER_TOML);
		const config = await loadConfig(dir, undefined, 'stg');

		expect(config.d1.databaseId).toBe('real-stg-id-9999');
		expect(config.d1.databaseName).toBe('acme-db-stg');
		expect(config.resolution?.databaseId.source).toBe('CLOUDFLARE_D1_DATABASE_ID');
	});

	it('does not interpolate ${VAR} in the wrangler file', async () => {
		// Wrangler does not interpolate its own config, so a d1zzle that did would
		// read a different value than wrangler from the same line — a new instance
		// of the drift this change exists to remove.
		vi.stubEnv('D1_ID', 'interpolated');
		const dir = await project(
			'[[env.stg.d1_databases]]\nbinding = "DB"\ndatabase_name = "db"\ndatabase_id = "${D1_ID}"\n',
		);

		expect((await loadConfig(dir, undefined, 'stg')).d1.databaseId).toBe('${D1_ID}');
	});

	it('inherits account_id from the top level, and prefers the environment\'s own', async () => {
		// `account_id` IS inheritable in wrangler, unlike `d1_databases`.
		const dir = await project(WRANGLER_TOML);
		expect((await loadConfig(dir, undefined, 'stg')).d1.accountId).toBe('stg-account');
		expect((await loadConfig(dir, undefined, 'prd')).d1.accountId).toBe('top-level-account');
	});

	it('reads migrations_dir off the binding, where wrangler puts it', async () => {
		const dir = await project(
			'[[env.stg.d1_databases]]\nbinding = "DB"\ndatabase_name = "db"\ndatabase_id = "id"\n'
				+ 'migrations_dir = "./drizzle"\n',
		);

		expect((await loadConfig(dir, undefined, 'stg')).out).toBe('./drizzle');
	});
});

describe('saying where it is about to write', () => {
	const runnerLog = async (dir: string, environment: string | undefined, remote: boolean) => {
		const config = await loadConfig(dir, undefined, environment);
		const logged: string[] = [];
		const ctx = { cwd: dir, config, log: (m: string) => logged.push(m), now: () => 1 };
		// The connection itself is irrelevant here; the log has to have been
		// written before it is attempted.
		await resolveRunner(ctx, { remote, local: !remote }).catch(() => undefined);
		return logged.join('\n');
	};

	it('names the environment, binding, database and every source, on remote', async () => {
		vi.stubEnv('CLOUDFLARE_D1_DATABASE_ID', 'abcdefgh1234');
		vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
		const log = await runnerLog(await project(WRANGLER_TOML), 'prd', true);

		expect(log).toContain('remote D1');
		expect(log).toContain('prd');
		expect(log).toContain('DB');
		expect(log).toContain('acme-db-prd');
		expect(log).toContain('CLOUDFLARE_D1_DATABASE_ID');
		expect(log).toContain('wrangler.toml [env.prd]');
		// Masked to the last four: enough to tell stg from prd in a CI log, without
		// the tool printing an id the project deliberately keeps out of git.
		expect(log).toContain('…1234');
		expect(log).not.toContain('abcdefgh1234');
	});

	it('reports the local target too, so --local runs are auditable as well', async () => {
		const log = await runnerLog(await project(WRANGLER_TOML), undefined, false);

		expect(log).toContain('local .wrangler SQLite state');
		expect(log).toContain('(top level)');
		expect(log).toContain('acme-db-local');
		// No id or account on a local run — neither is used to find the file.
		expect(log).not.toContain('database_id');
	});

	it('renders nothing for a hand-built config that has no resolution', () => {
		expect(describeResolution({ schema: '', out: '', d1: {} }, true)).toEqual([]);
	});
});

describe('a remote id that cannot be one', () => {
	const remote = async (dir: string, environment?: string) => {
		const config = await loadConfig(dir, undefined, environment);
		return resolveRunner(
			{ cwd: dir, config, log: () => {}, now: () => 1 },
			{ remote: true },
		);
	};

	it('refuses the committed placeholder instead of asking the API about it', async () => {
		vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
		await expect(remote(await project(WRANGLER_TOML), 'stg'))
			.rejects.toThrow(/__CLOUDFLARE_D1_DATABASE_ID__.*placeholder/s);
	});

	it('refuses the local sentinel', async () => {
		vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
		await expect(remote(await project(WRANGLER_TOML))).rejects.toThrow(/local sentinel/);
	});

	it('accepts a real-looking id', async () => {
		vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
		vi.stubEnv('CLOUDFLARE_D1_DATABASE_ID', 'e1f2a3b4-0000-4000-8000-abcdefabcdef');
		await expect(remote(await project(WRANGLER_TOML), 'stg')).resolves.toBeTruthy();
	});
});
