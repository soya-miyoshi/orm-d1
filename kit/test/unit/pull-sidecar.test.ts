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
	// notice only by diffing the file. Nothing in the live snapshot needs a
	// sidecar at all here (the only options were the stale, dropped ones), so
	// — consistent with "no sidecar written when nothing needs one" — the
	// hand-written file is left exactly as it was; `pull` does not go on to
	// delete or rewrite a file it decided has nothing new to say.
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
		expect(readFileSync(join(dir, 'table-options.ts'), 'utf8')).toBe(stale);
		expect(log).toMatch(/declares strict, appendOnly for "people", but the live database does not have/);
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
