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
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
 * sits in. Keyed by the shim's own file URL, valued with the *original*
 * module's path, and set right before importing the shim.
 */
const shimOrigins = new Map<string, string>();

/**
 * A relative import spelled with a JavaScript extension that only exists as
 * TypeScript on disk — `./schema.js` for `schema.ts`.
 *
 * This is what TypeScript's `moduleResolution: nodenext` requires a relative
 * import to be spelled as (`TS2835`), and what the `tableOptions` sidecar
 * `pull` writes therefore has to say about the `.ts` schema module next to it
 * (`cli.ts`'s `relativeSpecifier`). Node's own resolver would reject it: the
 * `.js` file is not there. Mapped back to the real source extension here, the
 * same way the extension-less case below is.
 */
const JS_TO_TS_SUFFIXES: Record<string, readonly string[]> = {
	'.js': ['.ts', '.tsx'],
	'.mjs': ['.mts'],
	'.cjs': ['.cts'],
};

const registerResolveHook = (): void => {
	if (hooksRegistered) return;
	hooksRegistered = true;

	registerHooks({
		resolve(specifier, context, nextResolve) {
			const relative = specifier.startsWith('./') || specifier.startsWith('../');
			const parentUrl = context.parentURL;
			const origin = parentUrl ? shimOrigins.get(parentUrl) : undefined;

			// [F-038 follow-up] A *bare* specifier is still Node's business —
			// rewriting one would shadow a real package — but when the importer is
			// a shim sitting in a scratch directory, the node_modules walk Node
			// starts from that directory never reaches the project's own
			// node_modules, so every bare import in a schema loaded through the
			// shim failed with `Cannot find package`. Forward it with the
			// *original* file as the parent instead, so the walk starts where the
			// module really lives; Node still does the resolving.
			if (!relative) {
				if (origin) return nextResolve(specifier, { ...context, parentURL: pathToFileURL(origin).href });
				return nextResolve(specifier, context);
			}

			if (!parentUrl?.startsWith('file:')) return nextResolve(specifier, context);
			const parentDir = origin ? dirname(origin) : dirname(fileURLToPath(parentUrl));

			// A relative specifier that already names a *TypeScript* extension is
			// resolvable as written.
			if (/\.[cm]?tsx?$/.test(specifier)) return nextResolve(specifier, context);

			const jsExtension = Object.keys(JS_TO_TS_SUFFIXES).find((ext) => specifier.endsWith(ext));
			if (jsExtension) {
				const base = join(parentDir, specifier);
				// Only when the file it names is genuinely absent: a project with
				// real emitted `.js` next to its `.ts` must keep resolving to the
				// `.js` Node would have picked.
				if (existsSync(base)) return nextResolve(pathToFileURL(base).href, context);
				const stem = base.slice(0, base.length - jsExtension.length);
				for (const suffix of JS_TO_TS_SUFFIXES[jsExtension]!) {
					if (existsSync(stem + suffix)) return nextResolve(pathToFileURL(stem + suffix).href, context);
				}
				return nextResolve(specifier, context);
			}

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
		// `mkdtemp`, not a fixed `join(tmpdir(), 'orm-d1-kit-import')`: on a shared
		// `/tmp` a fixed name plus a `<pid>-<counter>` file name is entirely
		// predictable, and neither `mkdir(recursive)` nor `copyFile` is safe
		// there — `mkdir` accepts (and does not re-mode) a directory another user
		// already owns, and `copyFile` follows a symlink planted at the
		// destination, so an attacker could win the race between the write and
		// the `import()` on the next line to get arbitrary file write and code
		// execution. `mkdtemp` creates a fresh, unguessable directory owned by
		// this process at mode 0700, and the write below is exclusive
		// (`flag: 'wx'`, which is `O_EXCL|O_NOFOLLOW`-equivalent for this
		// purpose: it fails rather than following or truncating anything that is
		// already there). It also removes the availability failure of the fixed
		// path — an `orm-d1-kit-import` left behind by another user made every
		// shim import fail with EACCES.
		const scratchDir = await mkdtemp(join(tmpdir(), 'orm-d1-kit-import-'));
		// `tmpdir()` is a symlink on macOS (`/var` -> `/private/var`); Node's ESM
		// loader reports `context.parentURL` against the resolved real path, so
		// `shimOrigins` has to be keyed the same way or the lookup below misses.
		const realScratchDir = await realpath(scratchDir);
		const shim = join(realScratchDir, `shim-${shimCounter++}.mts`);
		await writeFile(shim, await readFile(path), { flag: 'wx' });
		const shimUrl = pathToFileURL(shim).href;
		shimOrigins.set(shimUrl, path);
		try {
			return await import(shimUrl) as T;
		} finally {
			shimOrigins.delete(shimUrl);
			await rm(scratchDir, { recursive: true, force: true });
		}
	}
}
