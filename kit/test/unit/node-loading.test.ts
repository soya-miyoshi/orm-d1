/**
 * The Node-side surface: loading a project's modules, and reading its folders.
 *
 * Everything here was a real failure against a 64-table schema rather than a
 * hypothesis — an extension-less relative import that Node's resolver rejects,
 * a `tableOptions` sidecar named by config, a migrations folder in the wrong
 * layout — so each gets a test rather than a comment saying it was fixed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importModule } from '../../src/node/import.js';
import { loadTableOptions, unreadableMigrations } from '../../src/node/store.js';
import { findLocalDatabase } from '../../src/node/runners.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'orm-d1-kit-'));

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
