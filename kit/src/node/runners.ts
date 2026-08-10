/**
 * The two places a migration can land: the local Miniflare SQLite file, and a
 * remote D1 database over the HTTP API. Both are exposed as the same
 * `SqlRunner`, which is what keeps `--local` and `--remote` from drifting.
 */
import { createHash } from 'node:crypto';
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
		// node:sqlite wraps the whole batch in one real transaction, however
		// long it is — `/query`'s ceiling is not this path's problem, and
		// splitting under it would give away atomicity for nothing.
		atomicLimit: () => Infinity,
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
		atomicLimit: () => Infinity,
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

	/**
	 * POST to the API and hand back `result` untouched. `/query` returns an
	 * array of per-statement results; `/import` returns a single object, so the
	 * shaping belongs to the caller.
	 */
	const postRaw = async (path: string, body: unknown): Promise<unknown> => {
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
			result?: unknown;
		};

		if (!response.ok || !payload.success) {
			const message = payload.errors?.map((e) => e.message).join('; ') ?? response.statusText;
			throw new Error(`D1 API error: ${message}`);
		}

		return payload.result;
	};

	const post = async (path: string, body: unknown): Promise<unknown[]> => {
		const result = await postRaw(path, body) as { results?: unknown[] }[] | undefined;
		return result?.flatMap((r) => r.results ?? []) ?? [];
	};

	/**
	 * Import a whole SQL script through D1's file-ingestion endpoint.
	 *
	 * Four steps, the same ones wrangler's `d1 execute --file` uses:
	 * `init` (announce the md5 and get a presigned URL) → `PUT` the bytes →
	 * `ingest` → `poll` until the server says `complete`. Cloudflare rolls the
	 * database back to its original state if ingestion fails part-way, so this
	 * is atomic for the whole script — including scripts too large for one
	 * `/query` batch.
	 */
	const importSql = async (sql: string): Promise<void> => {
		const body = Buffer.from(sql, 'utf8');
		const etag = createHash('md5').update(body).digest('hex');

		const init = await postRaw('/import', { action: 'init', etag }) as {
			upload_url?: string;
			filename: string;
		};

		// No `upload_url` means D1 already has a file with this etag — the
		// retry path after a failed ingest. Skip straight to ingesting it.
		if (init.upload_url) {
			const upload = await fetch(init.upload_url, {
				method: 'PUT',
				headers: { 'Content-Length': String(body.byteLength) },
				body,
			});
			if (!upload.ok) {
				throw new Error(`D1 import upload failed: ${upload.status} ${upload.statusText}`);
			}
			// The presigned PUT answers with the stored object's md5. A mismatch
			// means the bytes on the far side are not the bytes we meant to run,
			// and ingesting them would apply a script nobody wrote.
			const returned = upload.headers.get('etag')?.replaceAll('"', '');
			if (returned && returned !== etag) {
				throw new Error(`D1 import upload corrupted: expected etag ${etag}, got ${returned}`);
			}
		}

		let state = await postRaw('/import', {
			action: 'ingest',
			filename: init.filename,
			etag,
		}) as ImportState;

		// The server answers `ingest` immediately for a small script and leaves
		// a larger one processing; poll until it settles either way.
		for (let attempt = 0; state.status !== 'complete'; attempt++) {
			if (state.status === 'error') {
				throw new Error(`D1 import failed: ${state.errors?.join('; ') ?? 'unknown error'}`);
			}
			if (attempt >= IMPORT_POLL_LIMIT) {
				throw new Error(`D1 import did not finish after ${IMPORT_POLL_LIMIT} polls (status: ${state.status})`);
			}
			await new Promise((r) => setTimeout(r, IMPORT_POLL_INTERVAL_MS));
			state = await postRaw('/import', {
				action: 'poll',
				current_bookmark: state.at_bookmark,
			}) as ImportState;
		}
	};

	return {
		// `/query` caps a batch at QUERY_STATEMENT_LIMIT and loses atomicity at
		// every split. Import has no such cap and rolls back as a unit, so a
		// migration that has to use it — or that would not fit in one `/query`
		// batch anyway — is better off going in whole.
		atomicLimit: (statements) => (viaImport(statements) ? Infinity : QUERY_STATEMENT_LIMIT),
		all: async <T>(sql: string) => await post('/query', { sql }) as T[],
		// Cloudflare documents the `sql` field as "Supports multiple statements,
		// joined by semicolons, which will be executed as a batch", and a batch
		// as a SQL transaction that "aborts or rolls back the entire sequence"
		// when a statement fails — so this is the same atomicity the local path
		// gives. (The Worker `exec()` API is *not* equivalent: it stops on error
		// and leaves earlier statements applied. Hence `/query`.)
		// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
		batch: async (statements) => {
			// Nothing to send is not the same as sending nothing: `{ sql: '' }`
			// is a syntax error to D1, so an empty batch — a migration or push
			// whose statements were all pragmas, which the caller filters out —
			// would fail instead of being the no-op it is.
			if (statements.length === 0) return;
			const sql = statements.map((s) => `${s};`).join('\n');
			if (viaImport(statements)) {
				await importSql(sql);
				return;
			}
			await post('/query', { sql });
		},
	};
}

interface ImportState {
	readonly status: string;
	readonly at_bookmark?: string;
	readonly errors?: string[];
}

const IMPORT_POLL_LIMIT = 60;
const IMPORT_POLL_INTERVAL_MS = 1000;

/**
 * Whether a statement has to go through the import endpoint instead of
 * `/query`.
 *
 * `/query` re-splits the `sql` string it is given on semicolons, with a
 * splitter that does not know about compound statements. A trigger body is the
 * one place a statement legitimately contains one:
 *
 *     create trigger "t" before update on "x" begin
 *       select raise(abort, 'append-only');   ← /query cuts here
 *     end;
 *
 * and the halves are not valid SQL, so D1 answers `incomplete input:
 * SQLITE_ERROR` — for the whole batch, and for a lone `create trigger` sent by
 * itself, on one line, with or without a trailing semicolon (all four measured
 * against a real database). The kit emits exactly this shape for every
 * `appendOnly` table, so without this route `--remote` cannot apply a schema
 * the kit itself generated.
 *
 * The test is deliberately blunt: `splitStatements` already stripped the
 * terminators, so any surviving `;` is inside a trigger body or a string
 * literal. Both are safe to send through import — it costs a slower round trip,
 * never a wrong result.
 */
const needsImport = (statement: string): boolean => statement.includes(';');

/**
 * `/query`'s ceiling on statements per request. Mirrors
 * `MAX_STATEMENTS_PER_BATCH`, but stated here because it belongs to this
 * endpoint rather than to D1 — import has no equivalent limit.
 */
const QUERY_STATEMENT_LIMIT = 100;

/**
 * Whether a batch goes through file import rather than `/query`: because
 * `/query` cannot express one of its statements, or because it cannot carry
 * that many at once. The second case is not a workaround but an improvement —
 * `/query` would force a split, and a split is where atomicity is lost.
 */
const viaImport = (statements: readonly string[]): boolean =>
	statements.length > QUERY_STATEMENT_LIMIT || statements.some(needsImport);
