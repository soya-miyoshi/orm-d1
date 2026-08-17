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
	// schema.ts either: a refusal writes nothing.
	it('refuses to overwrite an existing table-options file, and leaves schema.ts alone', async () => {
		const dir = project('create table users (id integer primary key, email text collate nocase);');
		writeFileSync(join(dir, 'table-options.ts'), '// hand written\n');

		const { code, log } = await inProject(dir, ['pull', '--local']);
		expect(code).toBe(1);
		expect(log).toMatch(/table-options\.ts already exists/);
		expect(existsSync(join(dir, 'schema.ts'))).toBe(false);
		expect(readFileSync(join(dir, 'table-options.ts'), 'utf8')).toBe('// hand written\n');
	});

	// `--force` used to overwrite a hand-maintained sidecar with the live-derived
	// set alone, throwing away the half introspection cannot reproduce — a
	// `collate: null` retirement above all, which exists precisely to state
	// something the live database shows by *absence*.
	it('--force keeps config-declared options the live database cannot express', async () => {
		const dir = project(
			'create table users (id integer primary key, email text collate nocase, legacy_id text);',
			{ tableOptions: './table-options.ts' },
		);
		writeFileSync(
			join(dir, 'table-options.ts'),
			`const brand = Symbol.for('ormD1:TableOptions');\n`
				+ 'export default { [brand]: true, byTable: { users: { collate: { legacy_id: null } } } };\n',
		);

		const { code } = await inProject(dir, ['pull', '--local', '--force']);
		expect(code).toBe(0);
		const sidecar = readFileSync(join(dir, 'table-options.ts'), 'utf8');
		expect(sidecar).toContain('"legacy_id": null');
		expect(sidecar).toContain('"email": "nocase"');
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
