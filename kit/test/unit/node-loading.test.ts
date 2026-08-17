/**
 * The Node-side surface: loading a project's modules, and reading its folders.
 *
 * Everything here was a real failure against a 64-table schema rather than a
 * hypothesis — an extension-less relative import that Node's resolver rejects,
 * a `tableOptions` sidecar named by config, a migrations folder in the wrong
 * layout — so each gets a test rather than a comment saying it was fixed.
 */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { importModule } from '../../src/node/import.js';
import { loadTableOptions, unreadableMigrations } from '../../src/node/store.js';
import { findLocalDatabase } from '../../src/node/runners.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'orm-d1-kit-'));

/**
 * `importModule(target)` in a child process running plain Node.
 *
 * vitest's own loader (vite-node) transforms every `.ts` it imports before
 * Node's CommonJS-vs-ESM detection runs, so an in-process call never reaches
 * the CJS-forcing `.mts` shim at all — `import()` on the original path just
 * succeeds. Only a child process under plain Node exercises the shim, which is
 * the code path every test naming `[F-038]` is about.
 */
const runImportUnderPlainNode = (dir: string, target: string): unknown => {
	const importPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/node/import.ts');
	const scriptPath = join(dir, '.run-import.mjs');
	writeFileSync(
		scriptPath,
		`import { importModule } from ${JSON.stringify(importPath)};\n`
			+ `const m = await importModule(${JSON.stringify(target)});\n`
			+ `console.log(JSON.stringify(m.users));\n`,
	);
	return JSON.parse(execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' }).trim());
};

describe('importModule', () => {
	it('resolves extension-less relative imports', async () => {
		const dir = scratch();
		writeFileSync(join(dir, 'users.ts'), "export const users = 'users-table';\n");
		// What `moduleResolution: 'bundler'` produces, and what Node's own
		// resolver rejects with `Cannot find module` before any kit code runs.
		writeFileSync(join(dir, 'schema.ts'), "export { users } from './users';\n");

		const module = await importModule<{ users: string }>(join(dir, 'schema.ts'));
		expect(module.users).toBe('users-table');
	});

	it('resolves a directory to its index', async () => {
		const dir = scratch();
		mkdirSync(join(dir, 'schema'));
		writeFileSync(join(dir, 'schema', 'index.ts'), "export const marker = 'index';\n");
		writeFileSync(join(dir, 'entry.ts'), "export { marker } from './schema';\n");

		const module = await importModule<{ marker: string }>(join(dir, 'entry.ts'));
		expect(module.marker).toBe('index');
	});

	// [F-038]: the CJS-forcing-ESM shim used to be written into the same
	// directory as the module it copies. A crash between the write and the
	// `finally` cleanup left an importable duplicate there that a `**/*.mts`
	// glob in a build or test config would pick up. It now goes under the OS
	// temp directory instead, so the source directory never gains a file.
	// vitest's own module loader (vite-node) transforms every `.ts` it imports
	// before Node's own CommonJS-vs-ESM detection ever runs, so calling
	// `importModule` in-process here never actually reaches the CJS-forcing
	// shim fallback — `import()` on the original path just succeeds. The real
	// CLI runs under plain Node, where a `.ts` file in a project with no
	// `"type": "module"` genuinely hits it. A child process is what makes this
	// test exercise the same code path production does.
	it('[F-038] never writes the ESM shim into the source directory, under plain Node', () => {
		const dir = scratch();
		// Node 22+ auto-detects ES module syntax even with no package.json, so
		// an explicit `"type": "commonjs"` is what actually forces the `export
		// const` syntax below to fail to parse — the real trigger for the shim
		// fallback this test is about. Deliberately one self-contained file, not
		// a schema importing a sibling: a *sibling* `.ts` file under an explicit
		// `"type": "commonjs"` has its own, unrelated problem (it is not itself
		// shimmed, so it stays CommonJS-typed and cannot serve a named ESM
		// export either way) that has nothing to do with where the shim for
		// *this* file is written, which is the only thing this test is about.
		writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
		writeFileSync(join(dir, 'schema.ts'), "export const users = 'users-table';\n");

		const importPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/node/import.ts');
		const scriptPath = join(dir, '.run-import.mjs');
		writeFileSync(
			scriptPath,
			`import { importModule } from ${JSON.stringify(importPath)};\n`
				+ `const m = await importModule(${JSON.stringify(join(dir, 'schema.ts'))});\n`
				+ `console.log(JSON.stringify(m.users));\n`,
		);

		// `finally`-block cleanup removes the shim on every ordinary path, so a
		// before/after directory listing alone would pass whether the shim was
		// ever written into `dir` or not — the loss `[F-038]` is about only
		// shows up if the process is killed between the write and that cleanup.
		// Making `dir` read-only turns "was it written into `dir`?" into a
		// pass/fail signal directly: a shim written there would fail outright
		// with EACCES, so a clean run is itself the proof it went to the OS
		// temp directory instead.
		try {
			chmodSync(dir, 0o555);
			const output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
			expect(JSON.parse(output.trim())).toBe('users-table');
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	// [F-038 follow-up] The shim's whole reason to exist is a project with
	// `"type": "commonjs"` (Node >= 22.7 auto-detects ESM when `type` is absent,
	// so a typeless project never reaches the fallback) — and in exactly that
	// project shape, moving the shim to a scratch directory broke every *bare*
	// specifier in the schema: Node walks node_modules upward from the importer,
	// and the importer was now in the OS temp directory. `shimOrigins` restored
	// relative resolution only.
	it('[F-038] resolves a bare specifier from the project node_modules, under plain Node', () => {
		const dir = scratch();
		writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
		const pkg = join(dir, 'node_modules', 'marker-pkg');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, 'package.json'), '{"name":"marker-pkg","type":"module","main":"index.js"}\n');
		writeFileSync(join(pkg, 'index.js'), "export const marker = 'from-node-modules';\n");
		writeFileSync(
			join(dir, 'schema.ts'),
			"import { marker } from 'marker-pkg';\nexport const users = marker;\n",
		);

		expect(runImportUnderPlainNode(dir, join(dir, 'schema.ts'))).toBe('from-node-modules');
	});

	// [F-038 security] The shim used to be written to a fixed, guessable path
	// (`<tmp>/orm-d1-kit-import/.orm-d1-<pid>-<counter>.mts`) via
	// `mkdir(recursive)` + `copyFile`, neither of which is safe on a shared
	// `/tmp`: another user can own that directory (EACCES for everyone else) or
	// plant a symlink at the destination that `copyFile` follows. `mkdtemp` gives
	// a private, unguessable directory instead. Squatting the old fixed path with
	// a plain *file* is the cheapest observable proxy: the old code cannot
	// `mkdir` over it and fails outright, the new code never looks there.
	it('[F-038] does not use a fixed, squattable scratch path', (ctx) => {
		const dir = scratch();
		writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
		writeFileSync(join(dir, 'schema.ts'), "export const users = 'users-table';\n");

		// On the shared `/tmp` this test is about, `orm-d1-kit-import` can
		// already exist and be owned by a different user — in which case
		// neither the cleanup below nor the squat that follows can succeed,
		// and this test cannot say anything about the *current* run (it would
		// have failed on setup regardless of which scratch-path strategy
		// `importModule` uses). Skip rather than let an ownership problem this
		// test does not exercise report as a failure of the property it does.
		const squatted = join(tmpdir(), 'orm-d1-kit-import');
		try {
			if (existsSync(squatted)) rmSync(squatted, { recursive: true, force: true });
			writeFileSync(squatted, 'not a directory\n');
		} catch {
			ctx.skip();
			return;
		}
		try {
			expect(runImportUnderPlainNode(dir, join(dir, 'schema.ts'))).toBe('users-table');
		} finally {
			try {
				rmSync(squatted, { force: true });
			} catch {
				// Best-effort: see the setup comment above.
			}
		}
	});

	// [F-038 security cont'd] The property `mkdtemp`/`O_EXCL` actually buys —
	// a private (`0700`), unguessable-named scratch directory that never
	// reuses a fixed name — pinned directly rather than only through the
	// squatting proxy above. `TMPDIR` is redirected to a scratch directory of
	// this test's own so the poll below only ever sees directories this test
	// created. The schema module blocks on a sentinel file so the scratch
	// directory is guaranteed to still exist at the moment its mode is
	// checked — without that, the `finally` in `importModule` can have already
	// removed it before this test gets to look.
	it('[F-038 security] the scratch directory is private, unguessable, and cleaned up', async () => {
		const tmpRoot = scratch();
		const dir = scratch();
		writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
		const sentinel = join(dir, 'release.sentinel');
		writeFileSync(
			join(dir, 'schema.ts'),
			// Plain `import`/`export` syntax forces the CJS-detection failure that
			// triggers the shim path, the same way every other `[F-038]` test does
			// — see `isModuleSyntaxError` in `node/import.ts`.
			'import { existsSync } from \'node:fs\';\n'
				+ `while (!existsSync(${JSON.stringify(sentinel)})) { /* poll */ }\n`
				+ "export const users = 'users-table';\n",
		);

		const importPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/node/import.ts');
		const scriptPath = join(dir, '.run-import.mjs');
		writeFileSync(
			scriptPath,
			`import { importModule } from ${JSON.stringify(importPath)};\n`
				+ `const m = await importModule(${JSON.stringify(join(dir, 'schema.ts'))});\n`
				+ `console.log(JSON.stringify(m.users));\n`,
		);

		const child = execFile(
			process.execPath,
			[scriptPath],
			{ encoding: 'utf8', env: { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot } },
		);

		try {
			// Poll the parent's view of `tmpRoot` for the scratch directory the
			// child creates — this is the one property `O_EXCL` genuinely resists
			// a clean, non-racy test of, so it is polled for rather than assumed.
			let scratchDir: string | undefined;
			for (let attempt = 0; attempt < 200 && !scratchDir; attempt++) {
				const found = existsSync(tmpRoot)
					? readdirSync(tmpRoot).find((n) => n.startsWith('orm-d1-kit-import-'))
					: undefined;
				if (found) scratchDir = join(tmpRoot, found);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(scratchDir).toBeDefined();
			expect(existsSync(join(tmpRoot, 'orm-d1-kit-import'))).toBe(false);
			const mode = statSync(scratchDir!).mode & 0o777;
			expect(mode).toBe(0o700);

			writeFileSync(sentinel, 'go\n');
			const [stdout] = await once(child, 'close');
			void stdout;
			expect(existsSync(scratchDir!)).toBe(false);
		} finally {
			if (!existsSync(sentinel)) writeFileSync(sentinel, 'go\n');
			child.kill();
		}
	});

	// The shim's origin lookup is keyed by a file URL, so anything that needs
	// percent-encoding on the way in and out is where it breaks.
	it('[F-038] resolves the shim\'s relative imports through a path with spaces and non-ASCII', () => {
		const dir = mkdtempSync(join(tmpdir(), 'orm-d1 kit 日本語-'));
		writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n');
		// `.mts`, not `.ts`: under an explicit `"type": "commonjs"` a sibling
		// `.ts` is itself CommonJS-typed and cannot serve a named ESM export
		// (the pre-existing limitation the `[F-038]` test above documents) —
		// unrelated to the path encoding this test is about.
		writeFileSync(join(dir, 'users.mts'), "export const users = 'users-table';\n");
		writeFileSync(join(dir, 'schema.ts'), "export { users } from './users';\n");

		expect(runImportUnderPlainNode(dir, join(dir, 'schema.ts'))).toBe('users-table');
	});

	// [F-107] `pull`'s sidecar imports the schema module as `./schema.js` — the
	// only spelling that typechecks under `moduleResolution: nodenext` (TS2835)
	// — for a file that is `schema.ts` on disk. The resolve hook has to map it
	// back, or the sidecar the kit writes is a file the kit itself cannot load.
	// Under plain Node, not in-process: vitest's own resolver maps `./schema.js`
	// to `schema.ts` itself, so an in-process assertion passes whether the kit's
	// hook does anything or not — it proves nothing about the CLI.
	it('resolves a relative .js specifier to the .ts file behind it', () => {
		const dir = scratch();
		writeFileSync(join(dir, 'schema.ts'), "export const users = 'users-table';\n");
		writeFileSync(join(dir, 'options.ts'), "export { users } from './schema.js';\n");

		expect(runImportUnderPlainNode(dir, join(dir, 'options.ts'))).toBe('users-table');
	});

	// …but never over a real emitted `.js` sitting next to the `.ts`, which is
	// what Node would have resolved on its own.
	it('prefers a real .js file over the .ts beside it', () => {
		const dir = scratch();
		writeFileSync(join(dir, 'schema.ts'), "export const users = 'from-ts';\n");
		writeFileSync(join(dir, 'schema.js'), "export const users = 'from-js';\n");
		writeFileSync(join(dir, 'options.ts'), "export { users } from './schema.js';\n");

		expect(runImportUnderPlainNode(dir, join(dir, 'options.ts'))).toBe('from-js');
	});

	it('leaves bare specifiers to Node, so a real package is not shadowed', async () => {
		const dir = scratch();
		// A sibling file named like the package: if the hook rewrote bare
		// specifiers it would win, and `node:path` would resolve to this.
		writeFileSync(join(dir, 'node:path.ts'), "export const join = 'wrong';\n");
		writeFileSync(join(dir, 'bare.ts'), "import { sep } from 'node:path';\nexport const marker = sep;\n");

		const module = await importModule<{ marker: string }>(join(dir, 'bare.ts'));
		expect(module.marker).toBe('/');
	});
});

describe('loadTableOptions', () => {
	const sidecar = (body: string): string => {
		const dir = scratch();
		writeFileSync(join(dir, 'options.ts'), body);
		return dir;
	};

	// The map is built here rather than by importing `tableOptions()`, because
	// a module loaded from a temp folder cannot resolve the in-repo package —
	// and building it by hand pins the part that actually matters across that
	// boundary: the brand is `Symbol.for`, so a map made by a *different* copy
	// of `orm-d1/ddl` than the kit's own is still recognised. A registered
	// symbol is the only spelling for which that holds.
	const source = (exported: string) =>
		"const brand = Symbol.for('ormD1:TableOptions');\n"
		+ `${exported} { [brand]: true, byTable: { events: { strict: true, appendOnly: true } } };\n`;

	it('accepts the map as the default export', async () => {
		const dir = sidecar(source('export default'));
		const map = await loadTableOptions(dir, './options.ts');
		expect(map.byTable.events).toEqual({ strict: true, appendOnly: true });
	});

	it('accepts the map as a named export', async () => {
		const dir = sidecar(source('export const perTable ='));
		const map = await loadTableOptions(dir, './options.ts');
		expect(map.byTable.events?.strict).toBe(true);
	});

	// The config named the module, so hardening nothing on the quiet is the one
	// outcome nobody wants: every STRICT / WITHOUT ROWID / append-only guard in
	// the schema would silently stop being emitted.
	it('refuses a module that exports no map', async () => {
		const dir = sidecar('export const nope = 1;\n');
		await expect(loadTableOptions(dir, './options.ts')).rejects.toThrow(/exports no tableOptions\(\)/);
	});

	it('refuses a module that is not there', async () => {
		await expect(loadTableOptions(scratch(), './missing.ts')).rejects.toThrow(/not found/);
	});
});

describe('unreadableMigrations', () => {
	it('is empty for a folder that does not exist', async () => {
		expect(await unreadableMigrations(join(scratch(), 'nope'))).toEqual([]);
	});

	// drizzle-kit's directory layout. Reporting "already up to date" for a
	// database these were never applied to is the failure being prevented.
	it('reports drizzle-kit directories and unjournalled flat files', async () => {
		const dir = scratch();
		mkdirSync(join(dir, 'meta'), { recursive: true });
		writeFileSync(join(dir, 'meta', '_journal.json'), '{}');
		mkdirSync(join(dir, '0000_init'));
		writeFileSync(join(dir, '0000_init', 'migration.sql'), 'select 1;');
		writeFileSync(join(dir, '0001_later.sql'), 'select 1;');
		writeFileSync(join(dir, 'README.md'), 'not a migration');

		expect(await unreadableMigrations(dir)).toEqual(['0000_init/migration.sql', '0001_later.sql']);
	});
});

describe('findLocalDatabase', () => {
	const state = (files: string[]): string => {
		const dir = scratch();
		const root = join(dir, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
		mkdirSync(root, { recursive: true });
		for (const file of files) writeFileSync(join(root, file), '');
		return dir;
	};

	it('explains how to create the state when there is none', () => {
		expect(() => findLocalDatabase(scratch())).toThrow(/No local D1 state/);
	});

	// Miniflare's own bookkeeping file sits beside the databases; counting it
	// made a project with exactly one binding look ambiguous.
	it('ignores metadata.sqlite', () => {
		const dir = state(['metadata.sqlite', `${'a'.repeat(64)}.sqlite`]);
		expect(findLocalDatabase(dir)).toMatch(/a{64}\.sqlite$/);
	});

	// Not keyed on the 64-hex durable-object id: that shape is Miniflare's
	// business, and an allow-list on it would fail closed the day it changes.
	it('accepts a database file whatever it is named', () => {
		expect(findLocalDatabase(state(['my-db.sqlite']))).toMatch(/my-db\.sqlite$/);
	});

	it('refuses to guess between several', () => {
		const dir = state(['one.sqlite', 'two.sqlite']);
		expect(() => findLocalDatabase(dir)).toThrow(/2 local D1 databases/);
	});
});
