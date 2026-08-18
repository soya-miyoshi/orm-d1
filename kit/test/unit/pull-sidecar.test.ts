/**
 * `orm-d1-kit pull`, end to end through the CLI: what it writes, what it
 * refuses to overwrite, and what it tells the operator afterwards.
 *
 * Driven through `run()` rather than `pull()` because every defect here lives
 * in the wiring between the two — which file is checked before which, what the
 * sidecar's own `import` says, and whether the guidance is printed at all.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integer, sqliteTable, text } from 'orm-d1';
import { tableOptions, validateTableOptions } from 'orm-d1/ddl';
import type { TableOptions } from 'orm-d1/ddl';
import { sidecarDisagreementWarnings } from '../../src/node/commands.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';
import { run } from '../../src/cli.js';

const project = (ddl: string, config: Record<string, unknown> = {}): string => {
	const dir = mkdtempSync(join(tmpdir(), 'orm-d1-pull-'));
	const db = new DatabaseSync(join(dir, 'local.sqlite'));
	db.exec(ddl);
	db.close();
	writeFileSync(
		join(dir, 'orm-d1.config.ts'),
		`export default ${
			JSON.stringify({
				schema: './schema.ts',
				out: './migrations',
				d1: { localFile: './local.sqlite' },
				...config,
			})
		};\n`,
	);
	return dir;
};

const inProject = async (dir: string, argv: string[]): Promise<{ code: number; log: string }> => {
	const lines: string[] = [];
	const spy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => void lines.push(String(message)));
	const cwd = process.cwd();
	try {
		process.chdir(dir);
		const code = await run([...argv, '--config', join(dir, 'orm-d1.config.ts')]);
		return { code, log: lines.join('\n') };
	} finally {
		process.chdir(cwd);
		spy.mockRestore();
	}
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('pull', () => {
	// [F-100] The sidecar has to be loadable *and* typecheckable. An
	// extension-less `./schema` is neither under `moduleResolution: nodenext`
	// (TS2835); `./schema.js` is what TypeScript demands for a `.ts` file, and
	// the kit's own resolve hook maps it back.
	it('writes a sidecar importing the schema module with an explicit .js extension', async () => {
		const dir = project('create table users (id integer primary key, email text collate nocase);');

		const { code } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);
		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).toContain('from "./schema.js"');
		expect(sidecar).toContain(`collate: { "email": "nocase" }`);
	});

	// The warnings used to be printed only when *no* sidecar was rendered — and
	// the two predicates are the same four conditions, so that branch could
	// never be taken. The operator was told nothing at all, about a file whose
	// existence is only half the job: `config.tableOptions` has to name it.
	it('tells the operator what the schema module cannot express, and to wire the sidecar up', async () => {
		const dir = project('create table users (id integer primary key, email text collate nocase);');

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);
		expect(log).toMatch(/collate nocase in the live database/);
		expect(log).toMatch(/Add `tableOptions: '\.\/table-options\.ts'`/);
	});

	it('says nothing about wiring when the config already points at the file it wrote', async () => {
		const dir = project(
			'create table users (id integer primary key, email text collate nocase);',
			{ tableOptions: './table-options.ts' },
		);

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);
		expect(log).not.toMatch(/Add `tableOptions:/);
	});

	// The existence check used to run before introspection, so a `table-options.ts`
	// in the project blocked every `pull` — including one that had nothing to
	// write there — and took `schema.ts` down with it.
	it('does not refuse over a table-options file it was never going to write', async () => {
		const dir = project('create table users (id integer primary key, email text);');
		writeFileSync(join(dir, 'table-options.ts'), '// hand written, untouched\n');

		const { code } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);
		expect(existsSync(join(dir, 'schema.ts'))).toBe(true);
		expect(readFileSync(join(dir, 'table-options.ts'), 'utf8')).toBe('// hand written, untouched\n');
	});

	// …and still refuses when there *is* one to write, without having written
	// schema.ts either: a refusal writes nothing — not schema.ts, not the
	// table-options file, and not a journalled baseline either. [F-097 cont'd]
	// the existence refusal used to run *after* `pull` had already written the
	// migration, snapshot and journal entry — so following the refusal's own
	// "re-run with --force" advice produced a second, redundant baseline on
	// top of the first.
	it('refuses to overwrite an existing table-options file, and leaves schema.ts and the journal alone', async () => {
		const dir = project('create table users (id integer primary key, email text collate nocase);');
		writeFileSync(join(dir, 'table-options.ts'), '// hand written\n');

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(1);
		expect(log).toMatch(/table-options\.ts already exists/);
		expect(existsSync(join(dir, 'schema.ts'))).toBe(false);
		expect(readFileSync(join(dir, 'table-options.ts'), 'utf8')).toBe('// hand written\n');
		expect(existsSync(join(dir, 'migrations'))).toBe(false);
	});

	// `--force` used to overwrite a hand-maintained sidecar with the live-derived
	// set alone, throwing away the half introspection cannot reproduce — a
	// `collate: null` retirement above all, which exists precisely to state
	// something the live database shows by *absence*.
	//
	// `legacy_id` has no live collation, so a `null` retirement for it was
	// already inert (nothing to overwrite) before this test was fixed — it
	// passed for the wrong reason. `email` is the case the whole batch exists
	// for: the live column *still has* `collate nocase` (the migration that
	// would actually drop it has not been applied to this database yet), and
	// the retirement has to survive `--force` anyway — that is the entire
	// point of `collate: null` as a spelling.
	it('--force keeps a declared collate: null retirement even when the live column still has the collation', async () => {
		const dir = project(
			'create table users (id integer primary key, email text collate nocase, legacy_id text);',
			{ tableOptions: './table-options.ts' },
		);
		writeFileSync(
			join(dir, 'table-options.ts'),
			`const brand = Symbol.for('ormD1:TableOptions');\n`
				+ 'export default { [brand]: true, byTable: { users: { collate: { email: null, legacy_id: null } } } };\n',
		);

		const { code, log } = await inProject(dir, ['pull', '--local', '--force']);
		expect(code).toBe(0);
		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).toContain('"email": null');
		expect(sidecar).toContain('"legacy_id": null');
		expect(sidecar).not.toContain('"email": "nocase"');
		expect(log).toMatch(/retires collate for "users"\."email".*live database still has collate nocase/);
	});

	// The mirror image: `strict`/`withoutRowid`/`appendOnly` declared in the
	// config but no longer true of the live database are stale, not a second
	// unintrospectable spelling like `collate: null` — they do not survive
	// into a rendered sidecar, and the operator is warned rather than left to
	// notice only by diffing the file.
	//
	// [Round 4, finding 4] Nothing in the live snapshot needs a sidecar at all
	// here (the only options were the stale, dropped ones), and `pull` used to
	// leave the hand-written file exactly as it was — while printing "the
	// rendered sidecar drops them". Both cannot be true: the file it left alone
	// is what `config.tableOptions` names, so the "dropped" declarations stayed
	// authoritative and the very next `generate` proposed rebuilding the table
	// to put them back. The file is emptied instead (not deleted —
	// `config.tableOptions` still names the path), which is what makes the
	// message true.
	it('--force drops a declared strict/appendOnly the live database no longer backs, and warns', async () => {
		const dir = project(
			'create table people (id integer primary key, email text);',
			{ tableOptions: './table-options.ts' },
		);
		const stale = `const brand = Symbol.for('ormD1:TableOptions');\n`
			+ 'export default { [brand]: true, byTable: { people: { strict: true, appendOnly: true } } };\n';
		writeFileSync(join(dir, 'table-options.ts'), stale);

		const { code, log } = await inProject(dir, ['pull', '--local', '--force']);
		expect(code).toBe(0);
		expect(log).toMatch(/declares strict, appendOnly for "people", but the live database does not have/);

		const written = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(written).not.toBe(stale);
		expect(written).toContain('tableOptions([])');
		expect(log).toMatch(/Emptied table-options\.ts/);

		// The point of emptying it: what `config.tableOptions` names now declares
		// nothing, so the next `generate` has nothing to reconcile — no rebuild
		// of "people" to put `strict`/`appendOnly` back. Asserted on the file
		// rather than by running `generate` here: Node caches an ES module by
		// URL, and this suite runs every CLI invocation in one process, so a
		// `generate` in the same test would re-read the *stale* module object
		// `pull` already imported from that path rather than what is now on disk
		// (each real CLI run is a fresh process — see `store.ts`'s note).
		expect(readFileSync(join(dir, 'table-options.ts'), 'utf8')).not.toMatch(/strict|appendOnly/);
	});

	// [Round 4, finding 4, other half] The file is only emptied when it is the
	// one the declarations were read from. A `--table-options-out` pointing
	// somewhere else must not clear an unrelated file.
	it('leaves a file --table-options-out points at alone when it is not the declared sidecar', async () => {
		const dir = project(
			'create table people (id integer primary key, email text);',
			{ tableOptions: './table-options.ts' },
		);
		const stale = `const brand = Symbol.for('ormD1:TableOptions');\n`
			+ 'export default { [brand]: true, byTable: { people: { strict: true } } };\n';
		writeFileSync(join(dir, 'table-options.ts'), stale);
		writeFileSync(join(dir, 'other.ts'), '// unrelated\n');

		const { code } = await inProject(dir, ['pull', '--local', '--force', '--table-options-out', './other.ts']);
		expect(code).toBe(0);
		expect(readFileSync(join(dir, 'other.ts'), 'utf8')).toBe('// unrelated\n');
	});

	// [Round 4, finding 2] A `collate: null` retirement naming a column the live
	// table no longer has used to be carried into the rendered sidecar
	// unconditionally — the table-level analogue is existence-checked, this was
	// not. The file `pull` wrote was then rejected by `validateTableOptions`
	// ("collate names ... which is not a column"), so every later command failed
	// on the file `pull` itself had just produced.
	it('--force drops a collate: null retirement for a column the live table no longer has', async () => {
		const dir = project(
			'create table users (id integer primary key, email text collate nocase);',
			{ tableOptions: './table-options.ts' },
		);
		const stale = `const brand = Symbol.for('ormD1:TableOptions');\n`
			+ 'export default { [brand]: true, byTable: { users: { collate: { legacy_id: null } } } };\n';
		writeFileSync(join(dir, 'table-options.ts'), stale);

		const { code, log } = await inProject(dir, ['pull', '--local', '--force']);
		expect(code).toBe(0);
		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).not.toContain('legacy_id');
		expect(sidecar).toContain(`"email": "nocase"`);
		expect(log).toMatch(/declares collate for "users"\."legacy_id", which the live table does not have/);

		// And the file it wrote is one `validateTableOptions` accepts — that check
		// is over the *columns a collate map names*, and the rendered map now
		// names only live columns. Asserted directly rather than by running
		// `generate` in this process, for the module-caching reason above.
		const users = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email') });
		// The shape `pull` used to write is exactly the one that check rejects…
		expect(validateTableOptions(users, { collate: { legacy_id: null, email: 'nocase' } })).toMatch(/legacy_id/);
		// …and the shape it writes now passes.
		expect(validateTableOptions(users, { collate: { email: 'nocase' } })).toBeUndefined();
	});

	// [F-097 cont'd] A stale `table-options.ts` that imports a binding the
	// current schema module no longer exports used to fail *after* `pull` had
	// already journalled a baseline — repeatedly, since the failure recurred
	// on every retry, with no schema module and no sidecar ever produced.
	// `pullSnapshot` loads the declared sidecar before anything is written, so
	// the same failure now leaves nothing behind to clean up.
	// The real-world trigger is a stale `table-options.ts` that `import`s a
	// binding a since-renamed/dropped schema module no longer exports — Node's
	// ESM loader turns that into a link-time `SyntaxError` when the sidecar is
	// actually loaded through a real `import()` (verified by hand outside this
	// suite; the module runner this suite's own `import()` calls go through
	// resolves a missing named binding as `undefined` instead of throwing,
	// so it cannot be used to pin the exact error text here). What has to hold
	// regardless of *why* loading the declared sidecar throws is the ordering:
	// nothing is written until it has been loaded successfully. A module that
	// throws on evaluation exercises exactly that ordering.
	it('fails cleanly, before writing anything, when the declared sidecar fails to load', async () => {
		const dir = project(
			'create table people (id integer primary key);',
			{ tableOptions: './table-options.ts' },
		);
		writeFileSync(join(dir, 'schema.ts'), `export const people = 'not a real export, just needs to exist';\n`);
		writeFileSync(
			join(dir, 'table-options.ts'),
			`throw new Error('stale sidecar: does not provide an export named "events"');\n`,
		);

		let error: Error | undefined;
		const cwd = process.cwd();
		try {
			process.chdir(dir);
			await run(['pull', '--local', '--force', '--config', join(dir, 'orm-d1.config.ts')]);
		} catch (caught) {
			error = caught as Error;
		} finally {
			process.chdir(cwd);
		}

		expect(error?.message).toMatch(/events/);
		expect(existsSync(join(dir, 'migrations'))).toBe(false);
		expect(readFileSync(join(dir, 'schema.ts'), 'utf8')).toContain('not a real export');
	});

	it('names a declared table the live database no longer has, instead of dropping it silently', async () => {
		const dir = project(
			'create table users (id integer primary key, email text collate nocase);',
			{ tableOptions: './table-options.ts' },
		);
		writeFileSync(
			join(dir, 'table-options.ts'),
			`const brand = Symbol.for('ormD1:TableOptions');\n`
				+ 'export default { [brand]: true, byTable: { gone: { strict: true } } };\n',
		);

		const { code, log } = await inProject(dir, ['pull', '--local', '--force']);
		expect(code).toBe(0);
		expect(log).toMatch(/declares "gone", which the live database does not have/);
	});
});

/**
 * [Round 4, finding 3] `sidecarDisagreementWarnings` used to cover only the
 * null-vs-non-null edges — "declared and live has none" for the booleans and
 * for `collate`, plus a kept `null` retirement live contradicts. Every other
 * way the two sides can disagree (both stating a value, and not the same one)
 * was resolved in favour of live and reported to nobody, which is the shape
 * most likely to be a mistake rather than staleness: the operator wrote
 * something down and silently got something else back.
 */
describe('sidecarDisagreementWarnings covers both directions', () => {
	const live = (options: Parameters<typeof tableOptionsMap>[0]): Snapshot =>
		snapshotFromSchema([liveTable], '', tableOptionsMap(options));
	const liveTable = sqliteTable('t', { id: integer('id').primaryKey(), email: text('email') });
	const tableOptionsMap = (options: TableOptions) => tableOptions([[liveTable, options]]);

	it('warns when both sides state a collation and they differ', () => {
		const warnings = sidecarDisagreementWarnings(live({ collate: { email: 'nocase' } }), {
			t: { collate: { email: 'rtrim' } },
		});
		expect(warnings.join('\n')).toMatch(/declares collate rtrim for "t"\."email".*has collate nocase/);
	});

	it('says nothing when both sides state the same collation', () => {
		expect(sidecarDisagreementWarnings(live({ collate: { email: 'nocase' } }), {
			t: { collate: { email: 'NOCASE' } },
		})).toEqual([]);
	});

	it('warns when the config declares strict/withoutRowid/appendOnly off and the live database has them on', () => {
		const warnings = sidecarDisagreementWarnings(
			live({ strict: true, withoutRowid: true, appendOnly: true }),
			{ t: { strict: false, withoutRowid: false, appendOnly: false } },
		);
		expect(warnings.join('\n')).toMatch(/declares strict, withoutRowid, appendOnly off for "t"/);
	});

	it('says nothing when the config simply omits an option the live database has', () => {
		// Omission states nothing, so it is not a disagreement — only an
		// explicit `false` is.
		expect(sidecarDisagreementWarnings(live({ strict: true }), { t: {} })).toEqual([]);
	});

	it('warns when a declared appendOnly column list is narrower than the live guard', () => {
		const warnings = sidecarDisagreementWarnings(live({ appendOnly: true }), {
			t: { appendOnly: ['email'] },
		});
		expect(warnings.join('\n')).toMatch(/appendOnly for "t" over "email".*live guard covers the whole table/);
	});

	it('warns when both sides state a column list and they differ', () => {
		const warnings = sidecarDisagreementWarnings(live({ appendOnly: ['id', 'email'] }), {
			t: { appendOnly: ['email'] },
		});
		expect(warnings.join('\n')).toMatch(/appendOnly for "t" over "email".*live guard covers "email", "id"/);
	});

	it('says nothing when both sides state the same column list, in any order', () => {
		expect(sidecarDisagreementWarnings(live({ appendOnly: ['id', 'email'] }), {
			t: { appendOnly: ['email', 'id'] },
		})).toEqual([]);
	});
});

describe('pull against a live append-only guard naming a column the table does not have', () => {
	// [round 5] SQLite accepts (and simply never fires) `before update of
	// nosuchcol on t` — verified by hand, and the same failure shape as
	// `docs/35`. `appendOnlyTriggerGuard` (`core/introspect.ts`) reads that
	// column list back verbatim, with no existence check, so a stale trigger
	// (left over from a dropped/renamed column, or hand-written outside
	// orm-d1) hands `renderTableOptionsModule` a ghost column name. Writing it
	// into the sidecar used to succeed silently — `pull --local --force`
	// exited 0 and printed only the generic "Wrote table-options.ts" line —
	// and the very next `generate`/`check` threw uncaught out of `run()`,
	// because `assertAppendOnlyColumns` (`src/ddl.ts`) rejects a column list
	// naming something the schema does not have.
	it('drops the ghost column from the rendered sidecar and warns about it', async () => {
		const dir = project(
			'create table users (id integer primary key, at integer);\n'
				+ 'create trigger users_no_update before update of "at", "ghost" on users\n'
				+ 'begin\n'
				+ "\tselect raise(abort, 'users is append-only: UPDATE is prohibited');\n"
				+ 'end;',
		);

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);

		// Warned, not silent.
		expect(log).toMatch(/live append-only guard names "ghost".*does not have/);

		// The ghost column does not make it into the written sidecar…
		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).not.toContain('ghost');
		expect(sidecar).toContain(`appendOnly: ["at"]`);

		// …so `validateTableOptions` (what `generate`/`check` run the sidecar
		// through before doing anything else) accepts what was written, instead
		// of rejecting it the way it rejects the raw live column list.
		const before = sqliteTable('users', { id: integer('id').primaryKey(), at: integer('at') });
		expect(validateTableOptions(before, { appendOnly: ['at'] })).toBeUndefined();
		expect(validateTableOptions(before, { appendOnly: ['at', 'ghost'] })).toBeUndefined();
		// (validateTableOptions itself only checks `collate` against the table's
		// columns — `appendOnly`'s existence check lives in
		// `assertAppendOnlyColumns`, exercised via `createSchema` at
		// `generate`/`check` time, which is the uncaught throw this fix
		// prevents.)
	});

	it('drops the whole appendOnly key when every guarded column is a ghost', async () => {
		// `email collate nocase` forces a sidecar to be written at all (a
		// table-less-`appendOnly` `tableOptions()` sidecar is otherwise not
		// worth writing) — the assertion is that `appendOnly` itself does not
		// appear in it, not that nothing does.
		const dir = project(
			'create table users (id integer primary key, email text collate nocase);\n'
				+ 'create trigger users_no_update before update of "ghost1", "ghost2" on users\n'
				+ 'begin\n'
				+ "\tselect raise(abort, 'users is append-only: UPDATE is prohibited');\n"
				+ 'end;',
		);

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(0);
		expect(log).toMatch(/live append-only guard names "ghost1", "ghost2".*does not have/);

		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).not.toContain('appendOnly');
		expect(sidecar).toContain('nocase');
	});
});
