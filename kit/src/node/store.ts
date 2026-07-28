/**
 * The migrations folder, in wrangler's layout:
 *
 * ```
 * migrations/
 *   0000_lively_moon.sql
 *   meta/_journal.json
 *   meta/0000_snapshot.json
 * ```
 *
 * Wrangler reads the `.sql` files; the kit reads `meta/`. Both appliers agree
 * because they share the same table and the same file names.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTableOptionsMap } from 'd1zzle/ddl';
import type { TableOptionsMap } from 'd1zzle/ddl';
import { importModule } from './import.js';
import type { Journal } from '../core/journal.js';
import { emptyJournal } from '../core/journal.js';
import type { Snapshot } from '../core/snapshot.js';
import { emptySnapshot } from '../core/snapshot.js';

export const metaDir = (out: string): string => join(out, 'meta');
export const journalPath = (out: string): string => join(metaDir(out), '_journal.json');
export const snapshotPath = (out: string, index: number): string =>
	join(metaDir(out), `${String(index).padStart(4, '0')}_snapshot.json`);

export async function readJournal(out: string): Promise<Journal> {
	const path = journalPath(out);
	if (!existsSync(path)) return emptyJournal();
	return JSON.parse(await readFile(path, 'utf8')) as Journal;
}

export async function writeJournal(out: string, journal: Journal): Promise<void> {
	await mkdir(metaDir(out), { recursive: true });
	await writeFile(journalPath(out), `${JSON.stringify(journal, null, '\t')}\n`);
}

/** The snapshot the last migration left behind — the diff's starting point. */
export async function readLatestSnapshot(out: string): Promise<Snapshot> {
	if (!existsSync(metaDir(out))) return emptySnapshot();
	const files = (await readdir(metaDir(out)))
		.filter((f) => f.endsWith('_snapshot.json'))
		.sort();
	const last = files.at(-1);
	if (!last) return emptySnapshot();
	return JSON.parse(await readFile(join(metaDir(out), last), 'utf8')) as Snapshot;
}

/** One specific snapshot, by journal index. `undefined` when it is missing. */
export async function readSnapshot(out: string, index: number): Promise<Snapshot | undefined> {
	const path = snapshotPath(out, index);
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}

export async function writeSnapshot(out: string, index: number, snapshot: Snapshot): Promise<void> {
	await mkdir(metaDir(out), { recursive: true });
	await writeFile(snapshotPath(out, index), `${JSON.stringify(snapshot, null, '\t')}\n`);
}

export async function writeMigration(out: string, tag: string, sql: string): Promise<string> {
	await mkdir(out, { recursive: true });
	const path = join(out, `${tag}.sql`);
	await writeFile(path, `${sql}\n`);
	return path;
}

export async function readMigration(out: string, tag: string): Promise<string> {
	return readFile(join(out, `${tag}.sql`), 'utf8');
}

/**
 * Entries in `out` that look like migrations but are not in wrangler's layout.
 *
 * Used to tell "this project has no migrations" apart from "this project's
 * migrations are in a layout the kit does not read" — the second must not be
 * reported as up to date. drizzle-kit's `<tag>/migration.sql` directories are
 * the case that actually shows up.
 */
export async function unreadableMigrations(out: string): Promise<string[]> {
	if (!existsSync(out)) return [];
	const entries = await readdir(out, { withFileTypes: true });
	const found: string[] = [];

	for (const entry of entries) {
		if (entry.name === 'meta') continue;
		if (entry.isDirectory()) {
			if (existsSync(join(out, entry.name, 'migration.sql'))) found.push(`${entry.name}/migration.sql`);
			continue;
		}
		// A flat `.sql` file is the kit's own layout; it would be in the journal
		// if it were ours, so an unjournalled one still counts as unread.
		if (entry.name.endsWith('.sql')) found.push(entry.name);
	}

	return found.sort();
}

/**
 * Load the sidecar `tableOptions()` module.
 *
 * Accepts the map as the default export or as any named one, so the file can be
 * written either way. A module that exports no map at all is an error rather
 * than an empty map: the config named it, so silently hardening nothing is the
 * one outcome nobody wants.
 */
export async function loadTableOptions(cwd: string, path: string): Promise<TableOptionsMap> {
	const resolved = resolve(cwd, path);
	if (!existsSync(resolved)) throw new Error(`tableOptions module not found: ${resolved}`);

	const exports = await importModule(resolved);
	for (const value of [exports.default, ...Object.values(exports)]) {
		if (isTableOptionsMap(value)) return value;
	}

	throw new Error(
		`${resolved} exports no tableOptions() map. Expected \`export default tableOptions([[table, {...}], ...])\` `
			+ "from 'd1zzle/ddl'.",
	);
}

/** Load a schema module (or several) and return their exports. */
export async function loadSchema(cwd: string, schema: string | string[]): Promise<Record<string, unknown>> {
	const paths = Array.isArray(schema) ? schema : [schema];
	const exports: Record<string, unknown> = {};

	for (const path of paths) {
		const resolved = resolve(cwd, path);
		if (!existsSync(resolved)) throw new Error(`Schema file not found: ${resolved}`);

		// Node caches ES modules by URL. Each CLI run is a fresh process, so this
		// only matters for programmatic callers, who should pass distinct paths.
		Object.assign(exports, await importModule(resolved));
	}

	return exports;
}
