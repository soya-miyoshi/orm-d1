#!/usr/bin/env node
/**
 * `d1zzle-migrate <command>`.
 *
 * The command surface deliberately mirrors drizzle-kit, so existing muscle
 * memory and CI scripts transfer unchanged.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiffOptions } from './core/diff.js';
import { loadConfig } from './node/config.js';
import type { CommandContext, TargetFlags } from './node/commands.js';
import { check, generate, migrate, pull, push, up, verify } from './node/commands.js';

const USAGE = `d1zzle-migrate — migrations for d1zzle on Cloudflare D1

Usage
  d1zzle-migrate generate [--name <name>] [--accept-data-loss] [renames]
  d1zzle-migrate migrate  [--local | --remote]
  d1zzle-migrate push     [--local | --remote] [--accept-data-loss] [renames]
  d1zzle-migrate pull     [--local | --remote] [--schema-out <file>] [--force]
  d1zzle-migrate check    [--local | --remote]
  d1zzle-migrate verify
  d1zzle-migrate up

Commands
  check     does the live database match the snapshot? (drift, unapplied)
  verify    do the migrations still add up to the schema? (needs no database)

Options
  --config <path>       config file (default: d1zzle.config.ts)
  --local               act on the local .wrangler SQLite state (default)
  --remote              act on the remote D1 database over the HTTP API
  --accept-data-loss    allow destructive statements
  --name <name>         name for the generated migration
  --schema-out <file>   where \`pull\` writes the schema module
  --force               let \`pull\` overwrite an existing schema file

Renames — repeatable, and the alternative to dropping the data
  --rename-table old_table=new_table
  --rename-column table.old_column=new_column
`;

export type FlagValue = string | boolean | string[];

interface Args {
	command: string;
	flags: Record<string, FlagValue>;
}

/**
 * Flags meant to carry a boolean value. Spelled out rather than inferred,
 * because a flag's shape is fixed by the command it belongs to, not by
 * whatever a caller happens to pass on the command line.
 */
const BOOLEAN_FLAGS = new Set(['local', 'remote', 'accept-data-loss', 'force', 'help']);

export function parseArgs(argv: readonly string[]): Args {
	const [command = 'help', ...rest] = argv;
	const flags: Record<string, FlagValue> = {};

	/** Repeats accumulate — `--rename-column` is given once per column. */
	const set = (name: string, value: string | boolean): void => {
		const existing = flags[name];
		if (existing === undefined || typeof value === 'boolean') flags[name] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else if (typeof existing === 'string') flags[name] = [existing, value];
		else flags[name] = value;
	};

	// `--remote=true` and `--remote true` name a boolean flag but hand it a
	// *string* — `'true'`/`'false'` unless coerced here. Left as a string, it
	// compares unequal to the literal `true` every reader tests against
	// (`asTargetFlags`), so it silently fell through to that flag's default
	// instead of being honoured — or rejected.
	const coerce = (name: string, value: string): string | boolean =>
		BOOLEAN_FLAGS.has(name) && (value === 'true' || value === 'false') ? value === 'true' : value;

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]!;
		if (!token.startsWith('--')) continue;
		// Split on the *first* `=` only: a value may contain more of them,
		// and `--rename-column users.a=b` is exactly that shape.
		const body = token.slice(2);
		const equals = body.indexOf('=');
		const name = equals === -1 ? body : body.slice(0, equals);
		const inline = equals === -1 ? undefined : body.slice(equals + 1);
		const next = rest[i + 1];
		if (inline !== undefined) set(name, coerce(name, inline));
		else if (next && !next.startsWith('--')) {
			set(name, coerce(name, next));
			i++;
		} else set(name, true);
	}

	return { command, flags };
}

const asList = (value: FlagValue | undefined): string[] =>
	value === undefined || typeof value === 'boolean' ? [] : Array.isArray(value) ? value : [value];

/**
 * `--rename-table old=new` and `--rename-column table.old=new`, repeatable.
 *
 * Without these every rename is a drop plus an add: `generate` refuses because
 * the drop is destructive, and the only way past that — `--accept-data-loss` —
 * is the one option that actually throws the column's data away. Drizzle-kit
 * prompts interactively; flags are the same information without a TTY, which
 * also makes a rename reviewable in a shell history and usable from CI.
 */
const asRenames = (flags: Record<string, FlagValue>): DiffOptions | undefined => {
	const renamedTables: Record<string, string> = {};
	const renamedColumns: Record<string, string> = {};

	for (const entry of asList(flags['rename-table'])) {
		const [from, to] = splitPair(entry, '--rename-table', 'old_table=new_table');
		renamedTables[from] = to;
	}

	for (const entry of asList(flags['rename-column'])) {
		const [from, to] = splitPair(entry, '--rename-column', 'table.old_column=new_column');
		if (!from.includes('.')) {
			throw new Error(`--rename-column needs a table: "${entry}". Expected table.old_column=new_column.`);
		}
		renamedColumns[from] = to;
	}

	const hasTables = Object.keys(renamedTables).length > 0;
	const hasColumns = Object.keys(renamedColumns).length > 0;
	if (!hasTables && !hasColumns) return undefined;

	return {
		...(hasTables ? { renamedTables } : {}),
		...(hasColumns ? { renamedColumns } : {}),
	};
};

const splitPair = (entry: string, flag: string, shape: string): [string, string] => {
	const equals = entry.indexOf('=');
	const from = equals === -1 ? '' : entry.slice(0, equals).trim();
	const to = equals === -1 ? '' : entry.slice(equals + 1).trim();
	if (!from || !to) throw new Error(`${flag} expects ${shape}; received "${entry}".`);
	return [from, to];
};

/**
 * Reads a flag `parseArgs` was supposed to have already coerced to a boolean.
 * A string surviving to here means it was spelled in a way `coerce` does not
 * recognise (e.g. `--remote=yes`) — failing loudly beats silently treating it
 * as absent and running against the wrong database or skipping the
 * data-loss check it looks like it passed.
 */
const asBooleanFlag = (flags: Record<string, FlagValue>, name: string): boolean => {
	const value = flags[name];
	if (value === undefined) return false;
	if (typeof value === 'boolean') return value;
	throw new Error(`--${name} expects true or false; received "${String(value)}".`);
};

export const asTargetFlags = (flags: Record<string, FlagValue>): TargetFlags => {
	const renames = asRenames(flags);
	return {
		local: asBooleanFlag(flags, 'local'),
		remote: asBooleanFlag(flags, 'remote'),
		acceptDataLoss: asBooleanFlag(flags, 'accept-data-loss'),
		...(typeof flags['name'] === 'string' ? { name: flags['name'] } : {}),
		...(renames ? { renames } : {}),
	};
};

export async function run(argv: readonly string[]): Promise<number> {
	const { command, flags } = parseArgs(argv);

	// `--help`/`-h` in the *command* position (`d1zzle-migrate --help`) parses
	// as `command === '--help'`, not as a flag on some other command — there
	// is no command yet for it to be a flag of. Left unmatched, it fell
	// through to the config-loading path below and failed with "No d1zzle
	// config found" before the usage text ever printed.
	//
	// Matched by exact spelling, not `command.startsWith('-')`: that shape
	// also caught every *other* flag-looking first token — `--nope`,
	// `--remote` (flags-before-command) — and silently printed usage and
	// exited 0 for them instead of failing. Those fall through to the
	// `default:` case below like any other unrecognised command.
	if (command === 'help' || command === '-h' || command === '--help' || flags['help'] === true) {
		console.log(USAGE);
		return 0;
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd, typeof flags['config'] === 'string' ? flags['config'] : undefined);
	const ctx: CommandContext = { cwd, config, log: (message) => console.log(message), now: () => Date.now() };
	const target = asTargetFlags(flags);

	switch (command) {
		case 'generate':
			await generate(ctx, target);
			return 0;
		case 'migrate':
			await migrate(ctx, target);
			return 0;
		case 'push':
			await push(ctx, target);
			return 0;
		case 'pull': {
			const out = typeof flags['schema-out'] === 'string' ? flags['schema-out'] : './schema.ts';
			const path = resolve(cwd, out);

			// The default path is very likely to be the hand-written schema this
			// project already has, and the rendered module is not a substitute
			// for it — comments, `$type<…>()`, relations and `$defaultFn`s are
			// all lost. Refusing is consistent with how the rest of the tool
			// treats an irreversible write.
			if (existsSync(path) && flags['force'] !== true) {
				ctx.log(
					`${out} already exists. Re-run with --force to overwrite it, or pass --schema-out <file> `
						+ 'to write somewhere else. The rendered module has no relations, $type<…> or '
						+ '$defaultFn, so overwriting a hand-written schema loses them.',
				);
				return 1;
			}

			const result = await pull(ctx, target);
			await writeFile(path, result.schema);
			ctx.log(`Wrote ${out}.`);
			return 0;
		}
		case 'check': {
			const result = await check(ctx, target);
			// Non-zero so this belongs in CI.
			return result.ok ? 0 : 1;
		}
		case 'verify': {
			// Needs no database, so it runs in CI on a bare checkout.
			const result = await verify(ctx);
			return result.ok ? 0 : 1;
		}
		case 'up':
			await up(ctx);
			return 0;
		case 'studio':
			console.error(
				'd1zzle-migrate does not ship a studio. Use the Drizzle Studio browser extension — it\n'
					+ 'introspects the live database and works with d1zzle unchanged — or Cloudflare\'s\n'
					+ 'D1 console in the dashboard.',
			);
			return 1;
		default:
			console.error(`Unknown command "${command}".\n\n${USAGE}`);
			return 1;
	}
}

// Only run when invoked as a binary, so the module stays importable.
if (process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('d1zzle-migrate')) {
	run(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
