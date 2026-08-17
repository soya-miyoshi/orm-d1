/**
 * The zero-diff migration recipe, bundled for real.
 *
 * The README tells a project to keep its `drizzle-orm` imports and redirect
 * them with `paths`. Whether that actually works is a question about
 * **esbuild's** resolution — wrangler's bundler — not TypeScript's, and the two
 * do not agree: TypeScript is happy with a mapping to a `.d.ts`, and esbuild
 * cannot bundle one, so it falls through to node resolution and finds the real
 * `drizzle-orm`. Which is installed, by definition, for everyone following this
 * recipe.
 *
 * That failure is silent in every direction a user can look. The build
 * succeeds, the types are orm-d1's, the editor is happy — and the Worker ships
 * Drizzle's runtime, with none of the positional read path, none of the insert
 * chunking, and none of the session support. Nothing in the rest of the suite
 * exercises module resolution, so this file exists to make the recipe a tested
 * claim rather than a plausible one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url).href);
const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
const dist = join(root, 'dist');

/**
 * The recipe redirects to `dist/`, so this can only run against a build. `npm
 * run check` builds first; a bare `vitest` may not have. Skipped rather than
 * failed, but never silently — a skip that reads as a pass is the same class of
 * problem this file is about.
 */
const built = existsSync(join(dist, 'index.js')) && existsSync(join(dist, 'sqlite-core.js'));
const ready = built && existsSync(esbuild);

let workspace: string;

/** A Worker written entirely in Drizzle's specifiers — the migration input. */
const WORKER = `
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

export default {
  async fetch(_req, env) {
    const db = drizzle(env.DB);
    return Response.json(await db.select().from(users).all());
  },
};
`;

const tsconfig = (target: 'js' | 'dts', withBaseUrl: boolean) => {
	const ext = target === 'js' ? 'js' : 'd.ts';
	return JSON.stringify({
		compilerOptions: {
			...(withBaseUrl ? { baseUrl: '.' } : {}),
			paths: {
				'drizzle-orm': [`./node_modules/orm-d1/dist/index.${ext}`],
				'drizzle-orm/d1': [`./node_modules/orm-d1/dist/index.${ext}`],
				'drizzle-orm/sqlite-core': [`./node_modules/orm-d1/dist/sqlite-core.${ext}`],
			},
		},
	});
};

/** Bundle the fixture and report what actually ended up in it. */
const bundle = (config: string): { bytes: number; ormD1: boolean } => {
	writeFileSync(join(workspace, 'tsconfig.bundle.json'), config);
	const out = execFileSync(esbuild, [
		join(workspace, 'worker.js'),
		'--bundle',
		'--format=esm',
		`--tsconfig=${join(workspace, 'tsconfig.bundle.json')}`,
		'--log-level=error',
	], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

	// `orm-d1:IsTable` is our own symbol and appears in no other package, which
	// makes its presence the definitive signal. Deliberately not a check for
	// some Drizzle-only identifier: those are version-specific and a renamed one
	// would turn this test green for the wrong reason.
	return { bytes: out.length, ormD1: out.includes('ormD1:IsTable') };
};

beforeAll(() => {
	if (!ready) return;
	workspace = mkdtempSync(join(tmpdir(), 'orm-d1-resolution-'));
	writeFileSync(join(workspace, 'worker.js'), WORKER);

	// The situation the recipe is written for: both packages installed, because
	// the project is mid-migration off Drizzle.
	const modules = join(workspace, 'node_modules');
	mkdirSync(modules, { recursive: true });
	symlinkSync(root, join(modules, 'orm-d1'), 'dir');
	symlinkSync(join(root, 'node_modules', 'drizzle-orm'), join(modules, 'drizzle-orm'), 'dir');
});

afterAll(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(!ready)('the zero-diff migration recipe', () => {
	it('bundles orm-d1', () => {
		expect(bundle(tsconfig('js', true)).ormD1).toBe(true);
	});

	it('a .d.ts target silently bundles the real drizzle-orm instead', () => {
		// The failure this file was written for. TypeScript accepts the mapping,
		// esbuild cannot bundle a declaration file, and node resolution then
		// finds the package the user is migrating away from. Nothing errors.
		const redirected = bundle(tsconfig('js', true));
		const fallenThrough = bundle(tsconfig('dts', true));

		expect(fallenThrough.ormD1).toBe(false);
		// Roughly 80 kb against 172 kb when this was written. The ratio is the
		// robust part; the absolute numbers are not pinned.
		expect(fallenThrough.bytes).toBeGreaterThan(redirected.bytes * 1.5);
	});

	it('redirects all three entry points, not just the bare specifier', () => {
		// `drizzle-orm`, `drizzle-orm/d1` and `drizzle-orm/sqlite-core` are three
		// separate mappings, and the fixture imports from two of them. Dropping
		// the sqlite-core mapping must be visible.
		const partial = JSON.stringify({
			compilerOptions: {
				baseUrl: '.',
				paths: {
					'drizzle-orm': ['./node_modules/orm-d1/dist/index.js'],
					'drizzle-orm/d1': ['./node_modules/orm-d1/dist/index.js'],
				},
			},
		});
		expect(bundle(partial).bytes).toBeGreaterThan(bundle(tsconfig('js', true)).bytes);
	});
});

it.skipIf(ready)('SKIPPED: module resolution needs `npm run build` and esbuild', () => {
	// Deliberately visible. See the note at the top of this file.
	expect(built || existsSync(esbuild)).toBeDefined();
});
