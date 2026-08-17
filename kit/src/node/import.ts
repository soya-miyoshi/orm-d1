/**
 * Importing a project's TypeScript modules from the CLI.
 *
 * Node runs TypeScript directly, so no bundler is needed — the schema is a
 * value, not something to parse. One wrinkle: a `.ts` file in a project
 * without `"type": "module"` is loaded as CommonJS, and its `import`
 * statements fail. Copying it to a sibling `.mts` forces the ESM loader while
 * keeping bare and relative specifiers resolving from the project — which is
 * why the copy has to sit next to the original.
 */
import { copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
// `registerHooks` is Node 22.15+, which is why the package's `engines` says so:
// a missing named export from a builtin is a link-time SyntaxError, so an older
// runtime would fail to load the CLI at all rather than fail on first use.
import { registerHooks } from 'node:module';
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

			const base = join(dirname(fileURLToPath(parentUrl)), specifier);
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

		const shim = join(dirname(path), `.orm-d1-${process.pid}-${shimCounter++}.mts`);
		await copyFile(path, shim);
		try {
			return await import(pathToFileURL(shim).href) as T;
		} finally {
			await rm(shim, { force: true });
		}
	}
}
