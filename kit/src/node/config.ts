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
	 * three has a spelling in `drizzle-orm/sqlite-core`, and doc 08 keeps the
	 * schema DSL a strict subset of it so a schema file stays reverse-aliasable.
	 * See `TableOptions` in `d1zzle/ddl`.
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
}

export type UserConfig = Partial<Config> & { schema: string | string[] };

export const defineConfig = (config: UserConfig): UserConfig => config;

const CONFIG_FILES = ['d1zzle.config.ts', 'd1zzle.config.js', 'd1zzle.config.mjs'];
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

interface WranglerConfig {
	d1_databases?: { binding: string; database_name: string; database_id: string }[];
	account_id?: string;
	migrations_dir?: string;
}

export async function readWranglerConfig(cwd: string, file?: string): Promise<WranglerConfig | undefined> {
	const candidates = file ? [file] : WRANGLER_FILES;
	for (const candidate of candidates) {
		const path = resolve(cwd, candidate);
		if (!existsSync(path)) continue;
		const text = await readFile(path, 'utf8');
		if (path.endsWith('.toml')) return parseWranglerToml(text);
		return parseJsonc<WranglerConfig>(text);
	}
	return undefined;
}

/** Just enough TOML for the `[[d1_databases]]` blocks and `account_id`. */
function parseWranglerToml(text: string): WranglerConfig {
	const config: WranglerConfig = { d1_databases: [] };
	let current: Record<string, string> | undefined;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.split('#')[0]!.trim();
		if (!line) continue;

		if (line === '[[d1_databases]]') {
			current = {};
			config.d1_databases!.push(current as never);
			continue;
		}
		if (line.startsWith('[')) {
			current = undefined;
			continue;
		}

		const match = /^(\w+)\s*=\s*"([^"]*)"/.exec(line);
		if (!match) continue;
		if (current) current[match[1]!] = match[2]!;
		else if (match[1] === 'account_id') config.account_id = match[2]!;
		else if (match[1] === 'migrations_dir') config.migrations_dir = match[2]!;
	}

	return config;
}

export async function loadConfig(cwd: string, configPath?: string): Promise<Config> {
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
			`No d1zzle config found. Create d1zzle.config.ts:\n\n`
				+ `  import { defineConfig } from 'd1zzle-migrate';\n\n`
				+ `  export default defineConfig({\n`
				+ `    schema: './src/schema.ts',\n`
				+ `    out: './migrations',\n`
				+ `  });\n`,
		);
	}

	const wrangler = await readWranglerConfig(cwd, user.wrangler);
	const binding = user.d1?.binding;
	const database = binding
		? wrangler?.d1_databases?.find((d) => d.binding === binding)
		: wrangler?.d1_databases?.[0];

	return {
		schema: user.schema,
		tableOptions: user.tableOptions,
		// Wrangler's own default layout, so `wrangler d1 migrations apply` and
		// `d1zzle-migrate migrate` stay interchangeable.
		out: user.out ?? wrangler?.migrations_dir ?? './migrations',
		casing: user.casing ?? 'preserve',
		migrationsTable: user.migrationsTable ?? 'd1_migrations',
		d1: {
			binding: binding ?? database?.binding,
			databaseName: user.d1?.databaseName ?? database?.database_name,
			databaseId: user.d1?.databaseId ?? database?.database_id,
			accountId: user.d1?.accountId ?? process.env['CLOUDFLARE_ACCOUNT_ID'] ?? wrangler?.account_id,
			token: user.d1?.token ?? process.env['CLOUDFLARE_API_TOKEN'],
			localFile: user.d1?.localFile,
		},
	};
}
