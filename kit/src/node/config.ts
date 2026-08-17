/**
 * Configuration, and where it comes from.
 *
 * The database name and id default to what `wrangler.jsonc` already says.
 * Duplicated database configuration matters more than it sounds: it is a
 * common source of "applied to the wrong database" incidents.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { importModule } from './import.js';

export interface D1Config {
	/** Binding name in wrangler.jsonc; used to find the database. */
	binding?: string | undefined;
	/**
	 * Wrangler environment to resolve the binding from — the `<name>` in
	 * `[[env.<name>.d1_databases]]`, exactly what `wrangler --env <name>` selects.
	 * `--env` on the command line overrides this. See {@link resolveEnvironment}.
	 */
	env?: string | undefined;
	databaseName?: string | undefined;
	databaseId?: string | undefined;
	accountId?: string | undefined;
	token?: string | undefined;
	/**
	 * An explicit local SQLite file for `--local`, instead of discovering one
	 * under `.wrangler/state`. For projects whose dev server and tests run in
	 * Node against a plain file through a D1-shaped adapter.
	 */
	localFile?: string | undefined;
}

export interface Config {
	/** Path to the schema module, or several. */
	schema: string | string[];
	/**
	 * Path to a module whose default export is `tableOptions([...])` — per-table
	 * `STRICT` / `WITHOUT ROWID` / `appendOnly`.
	 *
	 * A separate module rather than part of the schema on purpose: none of the
	 * three has a spelling in `drizzle-orm/sqlite-core`, and docs/04 keeps the
	 * schema DSL a strict subset of it so a schema file stays reverse-aliasable.
	 * See `TableOptions` in `orm-d1/ddl`.
	 */
	tableOptions?: string | undefined;
	/** Migration output folder, in wrangler's layout. */
	out: string;
	d1: D1Config;
	casing?: 'preserve' | 'snake_case';
	/** Wrangler config to read defaults from. */
	wrangler?: string;
	/** Migration bookkeeping table. Wrangler's own by default. */
	migrationsTable?: string;
	/**
	 * Where every resolved value came from, for the line the CLI prints before
	 * it touches a database. Optional so a hand-built `Config` (tests, scripts)
	 * stays valid.
	 */
	resolution?: ConfigResolution;
}

/** One resolved value and the place it was read from. */
export interface Resolved {
	readonly value: string | undefined;
	/** Human-readable origin: a file, a flag, or an environment variable. */
	readonly source: string;
}

/**
 * The audit trail for "which database is this about to touch".
 *
 * Printed unconditionally before `--local` or `--remote` does anything, because
 * a CI log that does not say which database was migrated cannot be used to
 * answer the only question anyone ever asks it afterwards.
 */
export interface ConfigResolution {
	/** Wrangler environment name; `undefined` means the top-level block. */
	readonly environment: Resolved;
	/** Wrangler config file the defaults came from, if any. */
	readonly wranglerFile: string | undefined;
	readonly binding: Resolved;
	readonly databaseName: Resolved;
	readonly databaseId: Resolved;
	readonly accountId: Resolved;
}

export type UserConfig = Partial<Config> & { schema: string | string[] };

export const defineConfig = (config: UserConfig): UserConfig => config;

const CONFIG_FILES = ['orm-d1.config.ts', 'orm-d1.config.js', 'orm-d1.config.mjs'];
const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * JSONC → JSON. Comments and trailing commas, nothing more exotic.
 *
 * Both are removed inside the scan rather than by a regex afterwards, because
 * a regex has no idea what is a string: `{"a": "a, }b"}` lost its comma, and
 * a value ending in a backslash — `"C:\\path\\"` — was read as an escaped
 * quote, which left the parser inside a string for the rest of the file and
 * silently disabled comment stripping from there on.
 */
export function parseJsonc<T>(text: string): T {
	let out = '';
	let quote = false;
	let escaped = false;
	let comment: 'line' | 'block' | undefined;
	/** Index in `out` of a comma that may yet turn out to be trailing. */
	let pendingComma: number | undefined;

	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		const next = text[i + 1];

		if (comment === 'line') {
			if (char === '\n') {
				comment = undefined;
				out += char;
			}
			continue;
		}
		if (comment === 'block') {
			if (char === '*' && next === '/') {
				comment = undefined;
				i++;
			}
			continue;
		}

		if (quote) {
			out += char;
			// One flag, not a look-behind: `\\` is an escaped backslash and
			// leaves the next quote closing, which `text[i - 1] !== '\\'` got
			// exactly backwards.
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') quote = false;
			continue;
		}

		if (char === '/' && next === '/') {
			comment = 'line';
			continue;
		}
		if (char === '/' && next === '*') {
			comment = 'block';
			i++;
			continue;
		}

		if (char === ',') {
			pendingComma = out.length;
		} else if (pendingComma !== undefined && !/\s/.test(char)) {
			// The comma was trailing after all — drop it, keeping the
			// whitespace and comments that followed.
			if (char === '}' || char === ']') {
				out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
			}
			pendingComma = undefined;
		}

		if (char === '"') quote = true;
		out += char;
	}

	return JSON.parse(out) as T;
}

export interface WranglerD1Database {
	binding: string;
	database_name: string;
	database_id: string;
	/**
	 * Wrangler puts `migrations_dir` on the *binding*, not at the top level —
	 * verified against wrangler 4's own `validateD1Binding`, whose allowed keys
	 * are binding / database_id / database_name / migrations_dir /
	 * migrations_pattern / migrations_table / preview_database_id / remote.
	 */
	migrations_dir?: string;
}

/** The subset of a wrangler config block this kit reads. */
export interface WranglerEnvironment {
	d1_databases?: WranglerD1Database[];
	account_id?: string;
}

export interface WranglerConfig extends WranglerEnvironment {
	env?: Record<string, WranglerEnvironment>;
	/**
	 * Not a key wrangler itself honours at the top level (see
	 * {@link WranglerD1Database.migrations_dir}). Kept because earlier versions
	 * of this kit read it, and removing it would silently relocate an existing
	 * project's migrations folder.
	 */
	migrations_dir?: string;
	/** Which file this came from, for the resolution log. */
	configFile?: string;
}

export async function readWranglerConfig(cwd: string, file?: string): Promise<WranglerConfig | undefined> {
	const candidates = file ? [file] : WRANGLER_FILES;
	for (const candidate of candidates) {
		const path = resolve(cwd, candidate);
		if (!existsSync(path)) continue;
		const text = await readFile(path, 'utf8');
		const config = path.endsWith('.toml') ? parseWranglerToml(text) : parseJsonc<WranglerConfig>(text);
		config.configFile = candidate;
		return config;
	}
	return undefined;
}

/**
 * Just enough TOML for the `d1_databases` blocks and `account_id`, at the top
 * level *and* under `[env.<name>]`.
 *
 * The environment blocks are the point: matching only the exact string
 * `[[d1_databases]]` and treating every other `[`-line as "section over" meant
 * `[[env.stg.d1_databases]]` was dropped on the floor, so `--remote` against a
 * project whose real databases all live under `[env.*]` silently resolved the
 * *top-level* block — usually the local placeholder. That is the "applied to
 * the wrong database" incident this file exists to prevent.
 */
function parseWranglerToml(text: string): WranglerConfig {
	const config: WranglerConfig = { d1_databases: [], env: {} };

	/** Where plain `key = "value"` lines currently land; undefined = ignored. */
	let target: Record<string, string> | undefined = config as never;

	const envOf = (name: string): WranglerEnvironment => (config.env![name] ??= {});

	for (const rawLine of text.split('\n')) {
		const line = rawLine.split('#')[0]!.trim();
		if (!line) continue;

		const arrayHeader = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
		if (arrayHeader) {
			const path = arrayHeader[1]!;
			const scoped = /^env\.([^.]+)\.d1_databases$/.exec(path);
			const entry: Record<string, string> = {};
			if (path === 'd1_databases') config.d1_databases!.push(entry as never);
			else if (scoped) (envOf(scoped[1]!).d1_databases ??= []).push(entry as never);
			// Any other array-of-tables (`[[routes]]`, `[[env.x.kv_namespaces]]`)
			// is not ours; its keys must not leak into whatever came before it.
			target = path === 'd1_databases' || scoped ? entry : undefined;
			continue;
		}

		const tableHeader = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
		if (tableHeader) {
			const path = tableHeader[1]!;
			const scoped = /^env\.([^.]+)$/.exec(path);
			// `[env.stg]` carries the environment's inheritable scalars —
			// `account_id` is one. Anything deeper (`[env.stg.vars]`) is not.
			target = scoped ? (envOf(scoped[1]!) as never) : undefined;
			continue;
		}

		const match = /^(\w+)\s*=\s*"([^"]*)"/.exec(line);
		if (!match || !target) continue;
		// Only the keys this kit understands, so a `name = "app"` cannot
		// masquerade as configuration we act on.
		if (READ_KEYS.has(match[1]!)) target[match[1]!] = match[2]!;
	}

	return config;
}

const READ_KEYS = new Set([
	'binding',
	'database_name',
	'database_id',
	'migrations_dir',
	'account_id',
]);

/**
 * Which wrangler environment this run is about.
 *
 * The rule, in one sentence: **mirror wrangler where wrangler has an opinion,
 * and refuse where only orm-d1 does.**
 *
 * - `--env <name>` wins outright, spelled as wrangler spells it. The same flag
 *   is passed to both tools from the same script, so orm-d1 disagreeing with
 *   wrangler about what it means would be the whole bug.
 * - `CLOUDFLARE_ENV` is read next, because wrangler reads it.
 * - `d1.env` in `orm-d1.config.ts` is the static default for a repo.
 *
 * `CLOUDFLARE_ENV` and `d1.env` disagreeing is the one case with no wrangler
 * precedent to copy: a committed default silently beating the operator's own
 * environment variable (or the reverse) is exactly how a migration lands on
 * production while the deploy goes to staging. So it is an error, not a
 * preference.
 */
export function resolveEnvironment(
	flagEnv: string | undefined,
	configEnv: string | undefined,
	processEnv: Record<string, string | undefined> = process.env,
): Resolved {
	if (flagEnv !== undefined) return { value: flagEnv, source: '--env' };

	const fromVariable = processEnv['CLOUDFLARE_ENV'];
	if (fromVariable !== undefined && configEnv !== undefined && fromVariable !== configEnv) {
		throw new Error(
			`CLOUDFLARE_ENV is "${fromVariable}" but orm-d1.config.ts sets d1.env to "${configEnv}". `
				+ 'Refusing to guess which database you meant — pass --env explicitly, or make them agree.',
		);
	}
	if (fromVariable !== undefined) return { value: fromVariable, source: 'CLOUDFLARE_ENV' };
	if (configEnv !== undefined) return { value: configEnv, source: 'orm-d1.config.ts (d1.env)' };
	return { value: undefined, source: 'default (top-level block)' };
}

/**
 * The `d1_databases` list for the selected environment — or a refusal.
 *
 * Wrangler classifies `d1_databases` as **non-inheritable**: an environment that
 * does not declare its own gets *none*, plus a warning ("… is not inherited by
 * environments"). Falling back to the top-level block here would therefore make
 * orm-d1 migrate a database wrangler would never have bound — the precise
 * failure this tool exists to prevent — so the equivalent of wrangler's "no
 * bindings" is an error, not a fallback. A warning is not enough: nobody reads
 * warnings in CI, and the consequence is an irreversible write.
 */
function environmentBlock(
	wrangler: WranglerConfig | undefined,
	environment: Resolved,
): WranglerEnvironment | undefined {
	if (environment.value === undefined) return wrangler;

	const name = environment.value;
	const where = `${environment.source} selected environment "${name}"`;

	if (!wrangler) {
		throw new Error(
			`${where}, but no wrangler config was found. An environment names a block in `
				+ `wrangler.toml / wrangler.jsonc; without one there is nothing to select.`,
		);
	}

	const file = wrangler.configFile ?? 'the wrangler config';
	const known = Object.keys(wrangler.env ?? {});
	const block = wrangler.env?.[name];

	if (!block) {
		throw new Error(
			`${where}, but ${file} has no "env.${name}" block.`
				+ (known.length > 0 ? ` It defines: ${known.join(', ')}.` : ' It defines no environments at all.')
				+ ' Not falling back to the top-level block: that is a different database, and applying a '
				+ 'migration to it is not undoable.',
		);
	}

	if (!block.d1_databases || block.d1_databases.length === 0) {
		throw new Error(
			`${where}, and ${file} has an "env.${name}" block, but no d1_databases in it. `
				+ 'Wrangler does not inherit d1_databases from the top level — it would bind no database at '
				+ `all — so neither does orm-d1. Add the binding under "env.${name}".`,
		);
	}

	return block;
}

export async function loadConfig(cwd: string, configPath?: string, flagEnv?: string): Promise<Config> {
	const candidates = configPath ? [configPath] : CONFIG_FILES;
	let user: UserConfig | undefined;

	for (const candidate of candidates) {
		const path = resolve(cwd, candidate);
		if (!existsSync(path)) continue;
		user = (await importModule<{ default?: UserConfig }>(path)).default;
		break;
	}

	if (!user) {
		throw new Error(
			`No orm-d1 config found. Create orm-d1.config.ts:\n\n`
				+ `  import { defineConfig } from 'orm-d1-kit';\n\n`
				+ `  export default defineConfig({\n`
				+ `    schema: './src/schema.ts',\n`
				+ `    out: './migrations',\n`
				+ `  });\n`,
		);
	}

	const wrangler = await readWranglerConfig(cwd, user.wrangler);
	const environment = resolveEnvironment(flagEnv, user.d1?.env);
	const block = environmentBlock(wrangler, environment);

	const binding = user.d1?.binding;
	const database = binding
		? block?.d1_databases?.find((d) => d.binding === binding)
		: block?.d1_databases?.[0];

	/**
	 * Where a wrangler-sourced value came from, named precisely enough to be
	 * acted on: `wrangler.toml [env.stg]` and `wrangler.toml` are different
	 * blocks, and knowing which one answered is the point of the log line.
	 */
	const fromWrangler = `${wrangler?.configFile ?? 'wrangler config'}${
		environment.value ? ` [env.${environment.value}]` : ''
	}`;

	/**
	 * One precedence rule for every value: **`orm-d1.config.ts` > environment
	 * variable > wrangler config.**
	 *
	 * The config file is first because a value written there is a deliberate
	 * per-repo decision, and it can opt into the environment itself
	 * (`accountId: process.env.CLOUDFLARE_ACCOUNT_ID`) whenever that is what the
	 * author wants — so putting it first restricts nobody. This is also the
	 * order `accountId` and `token` already used, so no existing project moves.
	 */
	const pick = (
		fromConfig: string | undefined,
		variable: string | undefined,
		fallback: string | undefined,
	): Resolved =>
		fromConfig !== undefined
			? { value: fromConfig, source: 'orm-d1.config.ts' }
			: variable !== undefined && process.env[variable] !== undefined
			? { value: process.env[variable], source: variable }
			: { value: fallback, source: fallback === undefined ? 'unset' : fromWrangler };

	// `database_id` gets the same environment-variable route `account_id` and the
	// API token already had. Projects that treat the id as a secret commit a
	// placeholder and substitute it at deploy time; reading the variable directly
	// means the migration step needs no rewritten file to point at the right
	// database.
	//
	// Deliberately NOT `${VAR}` interpolation of the wrangler file: wrangler does
	// not interpolate its own config (verified in wrangler 4 — `parseTOML` is a
	// bare parse, and dotenv-expand is applied only to `.env`/`.dev.vars`), so a
	// orm-d1 that did would read a different value than wrangler from the same
	// line. That is a new instance of exactly the drift this change removes.
	const databaseId = pick(user.d1?.databaseId, 'CLOUDFLARE_D1_DATABASE_ID', database?.database_id);
	// No environment-variable route for the *name*: it only selects a local
	// SQLite file, it is not a secret, and every extra variable is another place
	// two tools can disagree.
	const databaseName = pick(user.d1?.databaseName, undefined, database?.database_name);
	// `account_id` *is* inheritable in wrangler, so an environment block that
	// omits it falls back to the top level — matching wrangler exactly.
	const accountId = pick(
		user.d1?.accountId,
		'CLOUDFLARE_ACCOUNT_ID',
		block?.account_id ?? wrangler?.account_id,
	);

	return {
		schema: user.schema,
		tableOptions: user.tableOptions,
		// Wrangler's own default layout, so `wrangler d1 migrations apply` and
		// `orm-d1-kit migrate` stay interchangeable. `migrations_dir` is a
		// property of the binding in wrangler; the top-level read is kept only so
		// projects configured against older versions of this kit do not move.
		out: user.out ?? database?.migrations_dir ?? wrangler?.migrations_dir ?? './migrations',
		casing: user.casing ?? 'preserve',
		migrationsTable: user.migrationsTable ?? 'd1_migrations',
		d1: {
			binding: binding ?? database?.binding,
			...(environment.value !== undefined ? { env: environment.value } : {}),
			databaseName: databaseName.value,
			databaseId: databaseId.value,
			accountId: accountId.value,
			token: user.d1?.token ?? process.env['CLOUDFLARE_API_TOKEN'],
			localFile: user.d1?.localFile,
		},
		resolution: {
			environment,
			wranglerFile: wrangler?.configFile,
			binding: binding !== undefined
				? { value: binding, source: 'orm-d1.config.ts' }
				: { value: database?.binding, source: database ? fromWrangler : 'unset' },
			databaseName,
			databaseId,
			accountId,
		},
	};
}

/**
 * The lines the CLI prints before it touches anything.
 *
 * Unconditional, and on both `--local` and `--remote`: the question a CI log
 * has to answer months later is "which database did this run write to", and no
 * amount of care in the config resolution helps if the answer is not recorded.
 */
export function describeResolution(config: Config, remote: boolean): string[] {
	const r = config.resolution;
	if (!r) return [];

	const line = (label: string, resolved: Resolved | undefined, render = (v: string) => v): string =>
		`  ${label.padEnd(14)} ${
			resolved?.value === undefined ? '(unset)' : render(resolved.value)
		}  ← ${resolved?.source ?? 'unset'}`;

	return [
		`Target: ${remote ? 'remote D1 (HTTP API)' : 'local .wrangler SQLite state'}`,
		line('environment', { value: r.environment.value ?? '(top level)', source: r.environment.source }),
		line('binding', r.binding),
		line('database_name', r.databaseName),
		// Masked, not omitted: the last four characters are enough to tell staging
		// from production in a log — which is the whole job — while a project that
		// deliberately keeps the id out of git does not get it printed into CI
		// output by the tool that was supposed to protect it.
		...(remote ? [line('database_id', r.databaseId, maskId), line('account_id', r.accountId, maskId)] : []),
		...(r.wranglerFile ? [] : ['  (no wrangler config found; values came from orm-d1.config.ts or the environment)']),
	];
}

const maskId = (value: string): string => (value.length <= 4 ? '…' : `…${value.slice(-4)}`);
