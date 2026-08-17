/**
 * Importing a project's TypeScript modules from the CLI.
 *
 * Node runs TypeScript directly, so no bundler is needed — the schema is a
 * value, not something to parse. One wrinkle: a `.ts` file in a project
 * without `"type": "module"` is loaded as CommonJS, and its `import`
 * statements fail. Copying it to a `.mts` shim forces the ESM loader. The
 * shim is written under the OS temp directory (`[F-038]`) rather than next to
 * the original — a copy left inside the user's source tree by a crash between
 * the write and cleanup becomes an importable duplicate a `**\/*.mts` glob in
 * a build or test config would pick up — and `shimOrigins` in
 * `registerResolveHook` below is what still lets the shim's own relative
 * imports resolve against the original file's directory.
 */
import { copyFile, mkdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
// `registerHooks` is Node 22.15+, which is why the package's `engines` says so:
// a missing named export from a builtin is a link-time SyntaxError, so an older
// runtime would fail to load the CLI at all rather than fail on first use.
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Extension-less relative imports, which Node's ESM resolver rejects.
 *
 * A TypeScript project on `"moduleResolution": "bundler"` — the default for
 * anything built with Vite, and what a Workers project almost always uses —
 * writes `import { users } from './users'`. That is not a resolvable ES module
 * specifier: Node requires the extension, and the schema failed to load with
 * `Cannot find module '.../schema/users'` before any of the kit's own code ran.
 *
 * drizzle-kit solves this by bundling the schema with esbuild. A resolve hook
 * is smaller and keeps "the schema is a value, not something to parse" true:
 * only the specifier is rewritten, and Node still does the loading and the
 * type stripping.
 *
 * Registered once, lazily, so importing this module has no effect on a caller
 * that never loads a schema.
 */
let hooksRegistered = false;

const CANDIDATE_SUFFIXES = ['.ts', '.mts', '.cts', '.js', '.mjs', '/index.ts', '/index.mts', '/index.js'];

/**
 * [F-038] A `.mts` shim (see {@link importModule}) lives in a scratch
 * directory outside the user's source tree, so a sibling relative import it
 * makes (`./helpers`) has to resolve as though the shim were still sitting
 * next to the file it copies — not against the scratch directory it actually
 * sits in. Keyed by the shim's own file URL, set right before importing it.
 */
const shimOrigins = new Map<string, string>();

const registerResolveHook = (): void => {
	if (hooksRegistered) return;
	hooksRegistered = true;

	registerHooks({
		resolve(specifier, context, nextResolve) {
			const relative = specifier.startsWith('./') || specifier.startsWith('../');
			// Anything with an extension, and every bare specifier, is left to
			// Node — rewriting those would shadow real packages.
			if (!relative || /\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(specifier, context);

			const parentUrl = context.parentURL;
			if (!parentUrl?.startsWith('file:')) return nextResolve(specifier, context);

			const parentDir = shimOrigins.get(parentUrl) ?? dirname(fileURLToPath(parentUrl));
			const base = join(parentDir, specifier);
			for (const suffix of CANDIDATE_SUFFIXES) {
				if (existsSync(base + suffix)) {
					return nextResolve(pathToFileURL(base + suffix).href, context);
				}
			}
			return nextResolve(specifier, context);
		},
	});
};

const isModuleSyntaxError = (error: unknown): boolean =>
	error instanceof Error
	&& /import statement outside a module|Unexpected token 'export'|require\(\) of ES Module/.test(error.message);

let shimCounter = 0;

export async function importModule<T = Record<string, unknown>>(path: string): Promise<T> {
	registerResolveHook();
	try {
		return await import(pathToFileURL(path).href) as T;
	} catch (error) {
		if (!isModuleSyntaxError(error) || !/\.[cm]?ts$/.test(path)) throw error;

		// [F-038] Written under the OS temp directory, not next to the original —
		// a copy inside the user's source tree left there by a crash or SIGKILL
		// between the write and the `finally` below (which never runs) becomes an
		// importable duplicate of the schema that a `**/*.mts` glob in a build or
		// test config picks up. `shimOrigins` (above) is what lets a relative
		// import from *inside* the shim still resolve as though it were sitting
		// next to the original.
		const scratchDir = join(tmpdir(), 'orm-d1-kit-import');
		await mkdir(scratchDir, { recursive: true });
		// `tmpdir()` is a symlink on macOS (`/var` -> `/private/var`); Node's ESM
		// loader reports `context.parentURL` against the resolved real path, so
		// `shimOrigins` has to be keyed the same way or the lookup below misses.
		const realScratchDir = await realpath(scratchDir);
		const shim = join(realScratchDir, `.orm-d1-${process.pid}-${shimCounter++}.mts`);
		await copyFile(path, shim);
		const shimUrl = pathToFileURL(shim).href;
		shimOrigins.set(shimUrl, dirname(path));
		try {
			return await import(shimUrl) as T;
		} finally {
			shimOrigins.delete(shimUrl);
			await rm(shim, { force: true });
		}
	}
}
