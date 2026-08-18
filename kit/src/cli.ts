#!/usr/bin/env node
/**
 * `orm-d1-kit <command>`.
 *
 * The command surface deliberately mirrors drizzle-kit, so existing muscle
 * memory and CI scripts transfer unchanged.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { DiffOptions } from './core/diff.js';
import { loadConfig } from './node/config.js';
import type { CommandContext, TargetFlags } from './node/commands.js';
import {
	backfillCommand,
	check,
	EMPTY_TABLE_OPTIONS_MODULE,
	generate,
	impact,
	journalPulledBaseline,
	migrate,
	pullSnapshot,
	push,
	up,
	verify,
} from './node/commands.js';

const USAGE = `orm-d1-kit — migrations for orm-d1 on Cloudflare D1

Usage
  orm-d1-kit generate [--name <name>] [--accept-data-loss] [--emit-roundtrip] [renames]
  orm-d1-kit migrate  [--env <name>] [--local | --remote]
  orm-d1-kit push     [--env <name>] [--local | --remote] [--accept-data-loss] [renames]
  orm-d1-kit pull     [--env <name>] [--local | --remote] [--schema-out <file>]
                          [--table-options-out <file>] [--force]
  orm-d1-kit check    [--env <name>] [--local | --remote]
  orm-d1-kit verify
  orm-d1-kit up
  orm-d1-kit backfill --table <name> [--table <name>…] --file <path.sql>
                          [--env <name>] [--local | --remote]
  orm-d1-kit impact   [--table <name>] [--env <name>] [--local | --remote]

Commands
  check     does the live database match the snapshot? (drift, unapplied)
  verify    do the migrations still add up to the schema? (needs no database)
  backfill  run one-off statements against append-only tables, guards suspended
              and put back verbatim, all in one batch. Use it to fill a column
              added to a table whose UPDATE is blocked by a trigger.
  impact    how many tables a rebuild of one table drags with it. Reads the
              schema, so it answers before the change exists; --local/--remote
              adds row counts, the other half of what a rebuild costs.

Options
  --config <path>       config file (default: orm-d1.config.ts)
  --env <name>          wrangler environment: the [env.<name>] block whose
                          d1_databases this run resolves. Spelled as wrangler
                          spells it, and never falls back to the top-level
                          block. Also read from CLOUDFLARE_ENV, or d1.env in
                          orm-d1.config.ts.
  --local               act on the local .wrangler SQLite state (default)
  --remote              act on the remote D1 database over the HTTP API
  --accept-data-loss    allow destructive statements
  --emit-roundtrip      when generate refuses because a table has children, write a
                          three-pass draft to <out>/roundtrip/. Not a migration.
  --name <name>         name for the generated migration
  --schema-out <file>   where \`pull\` writes the schema module
  --table-options-out <file>
                        where \`pull\` writes the tableOptions() sidecar (default:
                          table-options.ts next to --schema-out), when the live
                          database has STRICT, WITHOUT ROWID, appendOnly or a
                          non-BINARY column collation to state
  --force               let \`pull\` overwrite an existing schema or tableOptions
                          file. Lossy for a hand-maintained tableOptions file:
                          the live database wins on every option it can state, so
                          comments, options for tables it no longer has, and any
                          declaration it disagrees with are all dropped. The one
                          thing carried over is a \`collate: { column: null }\`
                          retirement — and only for a column that still exists —
                          because introspection cannot state it; everything else
                          is re-derived from live.

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
const BOOLEAN_FLAGS = new Set(['local', 'remote', 'accept-data-loss', 'emit-roundtrip', 'force', 'help']);

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
	// `Object.create(null)`, not `{}` — these flow straight into `diffSnapshots`
	// as `options.renamedTables`/`renamedColumns`, keyed by a table/column name
	// an operator can spell as `constructor`, `__proto__`, etc. Passing a plain
	// object here defeats `diffSnapshots`'s own `?? Object.create(null)`
	// fallback (a plain `{}` is truthy, so the fallback never fires) and
	// reintroduces the prototype hazard one call up.
	const renamedTables: Record<string, string> = Object.create(null);
	const renamedColumns: Record<string, string> = Object.create(null);

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
		emitRoundtrip: asBooleanFlag(flags, 'emit-roundtrip'),
		...(typeof flags['name'] === 'string' ? { name: flags['name'] } : {}),
		...(renames ? { renames } : {}),
	};
};

/**
 * `--env` names a value, always. A bare `--env` parses as `true`, which is the
 * shape that would otherwise be read as "no environment given" and silently
 * resolve the top-level block — the wrong-database path this flag exists to
 * close.
 */
export const environmentFlag = (flags: Record<string, FlagValue>): string | undefined => {
	const value = flags['env'];
	if (value === undefined) return undefined;
	if (typeof value === 'string' && value !== '') return value;
	throw new Error('--env expects an environment name, as in `--env stg`.');
};

/**
 * A relative `import`-style specifier from `fromFile` to `toFile`, with a
 * leading `./` (Node's ESM resolver rejects a bare `schema` as a relative
 * specifier without it).
 *
 * A TypeScript extension is rewritten to the JavaScript one it compiles to:
 * `./schema.ts` is emitted as `./schema.js`. It looks wrong and is not — this
 * is exactly what `moduleResolution: 'node16'`/`'nodenext'` requires (a
 * relative import of a `.ts` file is `TS2835`: "did you mean './schema.js'?"),
 * so the sidecar `pull` writes has to say `.js` to typecheck in the project
 * shape a Workers/D1 codebase most often has. An extension-*less* specifier
 * (what this used to emit) fails the same rule, and the kit's own resolve hook
 * maps `./schema.js` back to `schema.ts` on the way in
 * (`node/import.ts`'s `JS_TO_TS_SUFFIXES`), so both loaders agree.
 */
const TS_TO_JS_EXTENSION: Record<string, string> = { '.ts': '.js', '.tsx': '.js', '.mts': '.mjs', '.cts': '.cjs' };

const relativeSpecifier = (fromFile: string, toFile: string): string => {
	const rel = relative(dirname(fromFile), toFile).replaceAll('\\', '/');
	const ext = extname(rel);
	const spelled = TS_TO_JS_EXTENSION[ext] ? rel.slice(0, rel.length - ext.length) + TS_TO_JS_EXTENSION[ext] : rel;
	return spelled.startsWith('.') ? spelled : `./${spelled}`;
};

export async function run(argv: readonly string[]): Promise<number> {
	const { command, flags } = parseArgs(argv);

	// `--help`/`-h` in the *command* position (`orm-d1-kit --help`) parses
	// as `command === '--help'`, not as a flag on some other command — there
	// is no command yet for it to be a flag of. Left unmatched, it fell
	// through to the config-loading path below and failed with "No orm-d1
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
	const config = await loadConfig(
		cwd,
		typeof flags['config'] === 'string' ? flags['config'] : undefined,
		environmentFlag(flags),
	);
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
			const tableOptionsOut = typeof flags['table-options-out'] === 'string'
				? flags['table-options-out']
				: join(dirname(out), 'table-options.ts');
			const tableOptionsPath = resolve(cwd, tableOptionsOut);

			// `--table-options-out` pointed at the same file as `--schema-out`
			// would otherwise write the schema module, then immediately overwrite
			// it with the sidecar — which self-imports and is not valid schema
			// module syntax — printing "Wrote …" twice while quietly destroying
			// the schema module it just wrote.
			if (tableOptionsPath === path) {
				ctx.log(
					`--schema-out and --table-options-out both resolve to ${out} — they have to be different `
						+ 'files; the sidecar imports the schema module by path and cannot also replace it.',
				);
				return 1;
			}

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
			// [F-100] The specifier the *sidecar* imports the schema module through
			// — relative to where the sidecar itself is written, and spelled with
			// the JavaScript extension `moduleResolution: nodenext` demands (see
			// `relativeSpecifier`); the kit's own resolve hook (`node/import.ts`)
			// maps it back to the real `.ts`.
			const schemaModuleSpecifier = relativeSpecifier(tableOptionsPath, path);

			// [F-097 cont'd] Computed but not journalled yet — `pullSnapshot` only
			// introspects, renders and warns. Every precondition (this check, and
			// the table-options one right below) has to pass before anything
			// touches disk, or a refusal here still leaves a pulled baseline
			// behind, and following the refusal's own "re-run with --force" advice
			// produces a second, redundant one.
			const result = await pullSnapshot(ctx, { ...target, schemaModuleSpecifier });

			// The table-options existence check happens *here*, after
			// introspection, rather than up front with the schema one: whether
			// there is a sidecar to write at all is not known until the live
			// database has been read, and checking unconditionally refused a
			// perfectly ordinary `pull` (skipping `schema.ts` with it) over a file
			// nothing was going to touch. Still before any write: `pullSnapshot`
			// above is read-only, so a refusal here leaves nothing on disk either.
			// Nothing live needs a sidecar, but the file on disk declares options
			// this pull is dropping — and `pullSnapshot` has already printed "the
			// rendered sidecar drops them". Leaving the file alone would make that
			// line false in the way that matters: its declarations stay
			// authoritative for the next `generate`, which keeps proposing the
			// rebuild the operator was just told had been dropped. So the stale
			// file is rewritten as an empty `tableOptions([])` — emptied rather
			// than deleted, because `config.tableOptions` still names it and
			// `loadTableOptions` throws on a missing file.
			//
			// Only for the file the declarations were actually *read* from: if
			// `--table-options-out` points somewhere else, whatever sits at that
			// path is not the stale sidecar and emptying it would destroy an
			// unrelated file.
			const staleTableOptionsFile = !result.tableOptions
				&& result.droppedDeclarations.length > 0
				&& ctx.config.tableOptions !== undefined
				&& resolve(cwd, ctx.config.tableOptions) === tableOptionsPath
				&& existsSync(tableOptionsPath);

			if ((result.tableOptions || staleTableOptionsFile) && existsSync(tableOptionsPath) && flags['force'] !== true) {
				ctx.log(
					`${tableOptionsOut} already exists. Re-run with --force to overwrite it, or pass `
						+ '--table-options-out <file> to write somewhere else. The live database wins on every option '
						+ 'it can state: only a `collate: { column: null }` retirement (for a column that still '
						+ 'exists) is carried over from config.tableOptions when it points at that file; comments, '
						+ 'options for tables the live database no longer has, and any declaration it disagrees with '
						+ 'are lost.',
				);
				return 1;
			}

			await writeFile(path, result.schema);
			ctx.log(`Wrote ${out}.`);
			if (result.tableOptions || staleTableOptionsFile) {
				await writeFile(tableOptionsPath, result.tableOptions ?? EMPTY_TABLE_OPTIONS_MODULE);
				ctx.log(
					result.tableOptions
						? `Wrote ${tableOptionsOut}.`
						: `Emptied ${tableOptionsOut} — nothing in the live database needs a sidecar, and its `
							+ `declarations for ${result.droppedDeclarations.map((t) => `"${t}"`).join(', ')} are `
							+ 'dropped.',
				);
				// Wire it up, so the rest of *this* process (and any command run
				// through `run()` after it) reads the file that was just written
				// instead of guessing from the last introspection — and say so,
				// since only an edit to `orm-d1.config.ts` makes it stick for the
				// next process.
				const configured = ctx.config.tableOptions
					&& resolve(cwd, ctx.config.tableOptions) === tableOptionsPath;
				ctx.config.tableOptions = `./${relative(cwd, tableOptionsPath).replaceAll('\\', '/')}`;
				if (!configured) {
					ctx.log(
						`  ! Add \`tableOptions: '${ctx.config.tableOptions}'\` to orm-d1.config.ts — until it is `
							+ 'named there, generate/check keep guessing at STRICT, WITHOUT ROWID, appendOnly and '
							+ 'column collation instead of reading what this pull just wrote.',
					);
				}
			}

			// Journalled last, once every write above has actually succeeded —
			// see `pullSnapshot`'s doc comment for why the ordering matters.
			await journalPulledBaseline(ctx, result.snapshot, { ...target, schemaModuleSpecifier });
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
		case 'impact': {
			await impact(ctx, {
				...target,
				...(typeof flags['table'] === 'string' ? { table: flags['table'] } : {}),
			});
			return 0;
		}
		case 'backfill': {
			const tables = asList(flags['table']);
			const file = typeof flags['file'] === 'string' ? flags['file'] : undefined;
			if (tables.length === 0 || !file) {
				console.error(
					'backfill needs at least one --table and a --file.\n'
						+ '  orm-d1-kit backfill --table transactions --file ./drizzle/manual/fees.sql',
				);
				return 1;
			}
			await backfillCommand(ctx, { ...target, tables, file });
			return 0;
		}
		case 'studio':
			console.error(
				'orm-d1-kit does not ship a studio. Use the Drizzle Studio browser extension — it\n'
					+ 'introspects the live database and works with orm-d1 unchanged — or Cloudflare\'s\n'
					+ 'D1 console in the dashboard.',
			);
			return 1;
		default:
			console.error(`Unknown command "${command}".\n\n${USAGE}`);
			return 1;
	}
}

// Only run when invoked as a binary, so the module stays importable.
if (process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('orm-d1-kit')) {
	run(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
