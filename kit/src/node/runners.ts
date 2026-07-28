/**
 * The two places a migration can land: the local Miniflare SQLite file, and a
 * remote D1 database over the HTTP API. Both are exposed as the same
 * `SqlRunner`, which is what keeps `--local` and `--remote` from drifting.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SqlRunner } from '../core/apply.js';

/**
 * Wrangler keeps local D1 state as SQLite files under `.wrangler/state`.
 * `node:sqlite` reads them directly — no native dependency to install.
 */
export async function localRunner(cwd: string, databaseName?: string, localFile?: string): Promise<SqlRunner> {
	const { DatabaseSync } = await import('node:sqlite');
	// An explicit path wins over discovery. Miniflare's state is the usual local
	// database, but it is not the only one: a project whose dev server and test
	// suites run in Node — against a plain SQLite file through a D1-shaped
	// adapter — has no `.wrangler` directory to find, and pointing the kit at
	// the file is better than leaving it unable to migrate the database its own
	// tests read.
	const file = localFile ? resolve(cwd, localFile) : findLocalDatabase(cwd, databaseName);
	const db = new DatabaseSync(file);

	// SQLite defaults foreign keys *off*; D1 behaves as though every
	// transaction set `foreign_keys = on` and gives no way to opt out. Without
	// this line an FK-violating migration passes `--local` and fails
	// `--remote`, which is the exact drift this module exists to prevent. It
	// has to be set outside a transaction, so it goes here rather than in
	// `batch`.
	db.exec('pragma foreign_keys = on');

	return {
		all: async <T>(sql: string) => db.prepare(sql).all() as T[],
		batch: async (statements) => {
			// node:sqlite has real transactions, so local apply is atomic too.
			db.exec('begin');
			try {
				for (const statement of statements) db.exec(statement);
				db.exec('commit');
			} catch (error) {
				db.exec('rollback');
				throw error;
			}
		},
	};
}

/**
 * A throwaway in-memory database, for `verify`.
 *
 * Deliberately not a `SqlRunner` over anything persistent: the question
 * `verify` asks is what a *brand new* environment gets, so it has to start
 * from nothing every time.
 *
 * `foreign_keys = on` matches D1, which behaves as though every transaction
 * set it and gives no way to opt out — without it a migration with an FK
 * violation verifies clean and then fails on deploy.
 */
export async function scratchRunner(): Promise<SqlRunner> {
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(':memory:');
	db.exec('pragma foreign_keys = on');

	return {
		all: async <T>(sql: string) => db.prepare(sql).all() as T[],
		// Atomic like every other runner, and for one concrete reason beyond the
		// contract: a rebuild's first statement is `pragma defer_foreign_keys =
		// ON`, which is scoped to the current transaction. Outside one it is
		// cleared at the next autocommit — i.e. immediately — and the drop of a
		// still-referenced table fails.
		batch: async (statements) => {
			db.exec('begin');
			try {
				for (const statement of statements) db.exec(statement);
				db.exec('commit');
			} catch (error) {
				db.exec('rollback');
				throw error;
			}
		},
	};
}

export function findLocalDatabase(cwd: string, databaseName?: string): string {
	const root = resolve(cwd, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
	if (!existsSync(root)) {
		throw new Error(
			`No local D1 state at ${root}. Run the Worker (or \`wrangler d1 execute <db> --local\`) once `
				+ 'to create it.',
		);
	}

	// Miniflare keeps its own `metadata.sqlite` bookkeeping file alongside the
	// databases. Matching on `.sqlite` alone counted it as a database, so a
	// project with exactly one real D1 binding still looked ambiguous and the
	// command refused to run — so it is excluded by name. Excluded by *name*
	// rather than by requiring the 64-hex durable-object id the files happen to
	// be called today: that shape is Miniflare's business, and an allow-list
	// keyed on it fails closed the day it changes.
	const files = readdirSync(root).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	if (files.length === 0) throw new Error(`No local D1 database file under ${root}.`);
	if (files.length === 1) return join(root, files[0]!);

	// Miniflare names the file after the database's durable-object id, not
	// after the database, so matching on the configured name almost never
	// succeeds. Falling back to the first file meant silently migrating
	// whichever database happened to sort first — the exact incident this
	// module exists to prevent. With more than one, say so and stop.
	const named = databaseName ? files.filter((f) => f.includes(databaseName)) : [];
	if (named.length === 1) return join(root, named[0]!);

	throw new Error(
		`${files.length} local D1 databases under ${root}:\n`
			+ files.map((f) => `  - ${f}`).join('\n')
			+ `\n\nMiniflare names each file after its durable-object id, so "${databaseName ?? '<unset>'}" `
			+ 'cannot be matched against them. Remove the ones you do not want, or run against --remote.',
	);
}

export interface RemoteConfig {
	readonly accountId: string;
	readonly databaseId: string;
	readonly token: string;
}

/** The D1 HTTP API, used directly rather than shelling out to wrangler. */
export function remoteRunner(config: RemoteConfig): SqlRunner {
	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;

	const post = async (path: string, body: unknown): Promise<unknown[]> => {
		const response = await fetch(`${endpoint}${path}`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		const payload = await response.json() as {
			success: boolean;
			errors?: { message: string }[];
			result?: { results?: unknown[] }[];
		};

		if (!response.ok || !payload.success) {
			const message = payload.errors?.map((e) => e.message).join('; ') ?? response.statusText;
			throw new Error(`D1 API error: ${message}`);
		}

		return payload.result?.flatMap((r) => r.results ?? []) ?? [];
	};

	return {
		all: async <T>(sql: string) => await post('/query', { sql }) as T[],
		// Cloudflare documents the `sql` field as "Supports multiple statements,
		// joined by semicolons, which will be executed as a batch", and a batch
		// as a SQL transaction that "aborts or rolls back the entire sequence"
		// when a statement fails — so this is the same atomicity the local path
		// gives. (The Worker `exec()` API is *not* equivalent: it stops on error
		// and leaves earlier statements applied. Hence `/query`.)
		// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
		batch: async (statements) => {
			await post('/query', { sql: statements.map((s) => `${s};`).join('\n') });
		},
	};
}
