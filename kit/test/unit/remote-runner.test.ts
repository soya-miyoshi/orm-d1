/**
 * The D1 HTTP API runner.
 *
 * This was the kit's largest untested surface, and the one where a bug is
 * least recoverable: `--local` mistakes cost a file you can delete, `--remote`
 * mistakes cost production data. Every other module is covered against a real
 * database — this one talks to Cloudflare, so it is covered here against a
 * stubbed `fetch` that reproduces the API's documented response shapes.
 *
 * What a stub can prove: the request is addressed, authenticated and shaped
 * correctly, and every documented failure shape is turned into a thrown error
 * rather than being read as success. What it cannot prove is that Cloudflare
 * still behaves the way this file says it does — see the credential-gated
 * suite at the bottom, which runs against a real database when
 * `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN`
 * are present and skips when they are not.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteRunner } from '../../src/node/runners.js';

const CONFIG = { accountId: 'acc-1', databaseId: 'db-1', token: 'secret-token' };
const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/acc-1/d1/database/db-1/query';

interface Call {
	url: string;
	init: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Stub `fetch`, recording each call and replying with `payload`. */
const stubFetch = (payload: unknown, init: { ok?: boolean; statusText?: string } = {}) => {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (url: string, requestInit: Call['init']) => {
		calls.push({ url, init: requestInit });
		return {
			ok: init.ok ?? true,
			statusText: init.statusText ?? 'OK',
			json: async () => payload,
		};
	});
	return calls;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('addressing and authentication', () => {
	it('posts to the account/database query endpoint with a bearer token', async () => {
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await remoteRunner(CONFIG).all('select 1');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(ENDPOINT);
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.headers).toMatchObject({
			'Authorization': 'Bearer secret-token',
			'Content-Type': 'application/json',
		});
	});

	it('sends the statement as JSON in the documented field', async () => {
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await remoteRunner(CONFIG).all('select * from "users"');

		expect(JSON.parse(calls[0]!.init.body!)).toEqual({ sql: 'select * from "users"' });
	});
});

describe('reading results', () => {
	it('returns the rows of a single result group', async () => {
		stubFetch({ success: true, result: [{ results: [{ id: 1 }, { id: 2 }] }] });
		await expect(remoteRunner(CONFIG).all('select "id" from "t"')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
	});

	it('flattens several result groups, as a multi-statement reply carries', async () => {
		stubFetch({ success: true, result: [{ results: [{ a: 1 }] }, { results: [{ b: 2 }] }] });
		await expect(remoteRunner(CONFIG).all('select 1; select 2')).resolves.toEqual([{ a: 1 }, { b: 2 }]);
	});

	it('treats a reply with no result at all as no rows, not as a crash', async () => {
		stubFetch({ success: true });
		await expect(remoteRunner(CONFIG).all('select 1')).resolves.toEqual([]);
	});

	it('tolerates a result group that carries no results array', async () => {
		// A DDL statement replies with a group whose `results` is absent.
		stubFetch({ success: true, result: [{}, { results: [{ a: 1 }] }] });
		await expect(remoteRunner(CONFIG).all('create table "t" ("a" text); select 1'))
			.resolves.toEqual([{ a: 1 }]);
	});
});

describe('failures', () => {
	it('throws on `success: false` even when the HTTP status is 200', async () => {
		// The failure mode that matters most: D1's API answers a rejected query
		// with 200 OK and `success: false`, so a runner that trusted
		// `response.ok` alone would report a migration applied that never ran.
		stubFetch({ success: false, errors: [{ message: 'near "slect": syntax error' }] }, { ok: true });

		await expect(remoteRunner(CONFIG).all('slect 1')).rejects.toThrow(/near "slect": syntax error/);
	});

	it('throws on an HTTP error, joining every message the API returned', async () => {
		stubFetch(
			{ success: false, errors: [{ message: 'Authentication error' }, { message: 'no such database' }] },
			{ ok: false, statusText: 'Unauthorized' },
		);

		await expect(remoteRunner(CONFIG).all('select 1'))
			.rejects.toThrow(/Authentication error; no such database/);
	});

	it('falls back to the status text when the body carries no message', async () => {
		stubFetch({ success: false }, { ok: false, statusText: 'Internal Server Error' });
		await expect(remoteRunner(CONFIG).all('select 1')).rejects.toThrow(/Internal Server Error/);
	});

	it('does not put the API token in the error it throws', async () => {
		// The message reaches CI logs, which are very often public.
		stubFetch({ success: false, errors: [{ message: 'nope' }] }, { ok: false });
		await expect(remoteRunner(CONFIG).all('select 1')).rejects.not.toThrow(/secret-token/);
	});

	it('reports a failed batch rather than resolving quietly', async () => {
		stubFetch({ success: false, errors: [{ message: 'FOREIGN KEY constraint failed' }] });
		await expect(remoteRunner(CONFIG).batch(['delete from "users"']))
			.rejects.toThrow(/FOREIGN KEY constraint failed/);
	});
});

describe('batching', () => {
	it('sends one request, semicolon-joined, so D1 runs it as one transaction', async () => {
		// One request is the whole point: Cloudflare documents a multi-statement
		// `sql` field as a batch that "aborts or rolls back the entire sequence"
		// on failure. Splitting it into several requests would silently give up
		// atomicity, which is the guarantee migrations rest on.
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await remoteRunner(CONFIG).batch([
			'create table "a" ("id" text)',
			'create table "b" ("id" text)',
		]);

		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.init.body!)).toEqual({
			sql: 'create table "a" ("id" text);\ncreate table "b" ("id" text);',
		});
	});

	it('terminates every statement, including the last', async () => {
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await remoteRunner(CONFIG).batch(['select 1']);
		expect(JSON.parse(calls[0]!.init.body!).sql).toBe('select 1;');
	});

	it('sends nothing at all for an empty batch', async () => {
		// `{ sql: '' }` is a syntax error to D1, so posting one would turn a
		// no-op — a migration or push whose statements were all pragmas — into
		// a failure.
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await expect(remoteRunner(CONFIG).batch([])).resolves.toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

/**
 * Statements `/query` cannot carry.
 *
 * `/query` re-splits the `sql` string on semicolons with a splitter that does
 * not understand compound statements, so a trigger body is cut in half and D1
 * answers `incomplete input: SQLITE_ERROR` — measured against a real database
 * for a whole batch, for a lone `create trigger`, on one line, and with the
 * trailing semicolon removed. Every `appendOnly` table the kit generates emits
 * exactly that shape, so these go through the file-import endpoint instead.
 */
describe('statements that cannot go through /query', () => {
	const TRIGGER = `create trigger "t_no_update" before update on "t" begin
  select raise(abort, 't is append-only');
end`;

	/** Stub the four-step import handshake; returns the recorded calls. */
	const stubImport = (opts: { uploadUrl?: string | null; ingestStatus?: string; pollStatuses?: string[] } = {}) => {
		const calls: { url: string; body: unknown; method: string | undefined }[] = [];
		const polls = [...(opts.pollStatuses ?? [])];
		vi.stubGlobal('fetch', async (url: string, init: Call['init']) => {
			// The presigned upload is a plain PUT to R2 carrying the SQL bytes,
			// not JSON — so branch on the URL before trying to parse anything.
			const isApi = url.startsWith('https://api.cloudflare.com');
			const body = isApi && init.body ? JSON.parse(init.body) : undefined;
			calls.push({ url, body, method: init.method });

			if (!isApi) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"' + EXPECTED_ETAG + '"' : null) },
					json: async () => ({}),
				};
			}

			const action = (body as { action?: string } | undefined)?.action;
			const result = action === 'init'
				? (opts.uploadUrl === null
					? { filename: 'f.sql' }
					: { upload_url: opts.uploadUrl ?? 'https://upload.example/f.sql', filename: 'f.sql' })
				: action === 'ingest'
				? { status: opts.ingestStatus ?? 'complete', at_bookmark: 'bm-1' }
				: { status: polls.shift() ?? 'complete', at_bookmark: 'bm-2' };

			return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, result }) };
		});
		return calls;
	};

	// md5 of the exact bytes the runner uploads for [TRIGGER].
	const EXPECTED_ETAG = createHash('md5').update(Buffer.from(`${TRIGGER};`, 'utf8')).digest('hex');

	it('routes a batch containing a trigger body to /import, not /query', async () => {
		const calls = stubImport();
		await remoteRunner(CONFIG).batch([TRIGGER]);

		expect(calls.some((c) => c.url === ENDPOINT)).toBe(false);
		expect(calls.map((c) => (c.body as { action?: string } | undefined)?.action).filter(Boolean))
			.toEqual(['init', 'ingest']);
	});

	it('uploads the same bytes it announced, and says so with the md5', async () => {
		const calls = stubImport();
		await remoteRunner(CONFIG).batch([TRIGGER]);

		const init = calls.find((c) => (c.body as { action?: string })?.action === 'init');
		expect((init?.body as { etag: string }).etag).toBe(EXPECTED_ETAG);
		const upload = calls.find((c) => c.url === 'https://upload.example/f.sql');
		expect(upload?.method).toBe('PUT');
		const ingest = calls.find((c) => (c.body as { action?: string })?.action === 'ingest');
		expect(ingest?.body).toMatchObject({ action: 'ingest', filename: 'f.sql', etag: EXPECTED_ETAG });
	});

	it('skips the upload when D1 already holds the file', async () => {
		// `init` without an `upload_url` is the retry path after a failed
		// ingest: re-uploading identical bytes would just cost a round trip.
		const calls = stubImport({ uploadUrl: null });
		await remoteRunner(CONFIG).batch([TRIGGER]);
		expect(calls.some((c) => c.method === 'PUT')).toBe(false);
	});

	it('polls until the server reports complete', async () => {
		const calls = stubImport({ ingestStatus: 'processing', pollStatuses: ['processing', 'complete'] });
		await remoteRunner(CONFIG).batch([TRIGGER]);
		const actions = calls.map((c) => (c.body as { action?: string } | undefined)?.action).filter(Boolean);
		expect(actions).toEqual(['init', 'ingest', 'poll', 'poll']);
	});

	it('throws when ingestion reports an error instead of silently continuing', async () => {
		vi.stubGlobal('fetch', async (url: string, init: Call['init']) => {
			if (!url.startsWith('https://api.cloudflare.com')) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: { get: () => null },
					json: async () => ({}),
				};
			}
			const action = (JSON.parse(init.body!) as { action?: string }).action;
			const result = action === 'init'
				? { upload_url: 'https://upload.example/f.sql', filename: 'f.sql' }
				: { status: 'error', errors: ['near "end": syntax error'] };
			return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, result }) };
		});

		await expect(remoteRunner(CONFIG).batch([TRIGGER]))
			.rejects.toThrow('D1 import failed: near "end": syntax error');
	});

	it('refuses to ingest bytes whose etag does not match what it uploaded', async () => {
		vi.stubGlobal('fetch', async (url: string, init: Call['init']) => {
			if (!url.startsWith('https://api.cloudflare.com')) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"deadbeef"' : null) },
					json: async () => ({}),
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: true, result: { upload_url: 'https://upload.example/f.sql', filename: 'f.sql' } }),
			};
		});

		await expect(remoteRunner(CONFIG).batch([TRIGGER])).rejects.toThrow('corrupted');
	});

	it('leaves ordinary batches on /query', async () => {
		const calls = stubFetch({ success: true, result: [{ results: [] }] });
		await remoteRunner(CONFIG).batch(['create table "t" ("id" text primary key) strict']);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(ENDPOINT);
	});
});

/**
 * The ceiling the runner reports to `applyMigration`.
 *
 * `/query` caps a request at 100 statements and the apply layer used to split
 * under that number unconditionally — losing atomicity at every split, even
 * for migrations that were never going to touch `/query`.
 */
describe('atomicLimit', () => {
	const runner = remoteRunner(CONFIG);
	const plain = (n: number) => Array.from({ length: n }, (_, i) => `create table "t${i}" ("id" integer)`);
	const TRIGGER = 'create trigger "t_no_update" before update on "t" begin select raise(abort, \'no\'); end';

	it('reports /query\'s ceiling for a batch /query can carry', () => {
		expect(runner.atomicLimit?.(plain(10))).toBe(100);
	});

	it('reports no ceiling when a trigger body forces the import route', () => {
		expect(runner.atomicLimit?.([...plain(3), TRIGGER])).toBe(Infinity);
	});

	it('reports no ceiling past /query\'s limit, so a big migration stays one unit', () => {
		// Over the limit `/query` would have to be split; import would not, and
		// import rolls the whole script back on failure. Going wide beats going
		// split.
		expect(runner.atomicLimit?.(plain(101))).toBe(Infinity);
		expect(runner.atomicLimit?.(plain(100))).toBe(100);
	});

	it('sends an over-limit batch through import as a single script', async () => {
		const calls: { url: string; action: string | undefined }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: Call['init']) => {
			const isApi = url.startsWith('https://api.cloudflare.com');
			const action = isApi && init.body ? (JSON.parse(init.body) as { action?: string }).action : undefined;
			calls.push({ url, action });
			if (!isApi) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: { get: () => null },
					json: async () => ({}),
				};
			}
			const result = action === 'init'
				? { upload_url: 'https://upload.example/f.sql', filename: 'f.sql' }
				: { status: 'complete', at_bookmark: 'bm' };
			return { ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, result }) };
		});

		await runner.batch(plain(150));

		expect(calls.some((c) => c.url === ENDPOINT)).toBe(false);
		expect(calls.filter((c) => c.action === 'ingest')).toHaveLength(1);
	});
});

/**
 * The same runner against a real D1 database.
 *
 * Skipped unless all three credentials are set, so a normal `npm test` never
 * needs network or an account. In CI, set them as secrets against a scratch
 * database — never one holding data you would miss, since this creates and
 * drops tables.
 *
 * This is what the stubbed suite above cannot do: prove Cloudflare still
 * answers the way the stubs claim. Run it before trusting `--remote` with
 * anything, and on a schedule after that, since it is the API contract rather
 * than our code that drifts.
 */
const credentials = {
	accountId: process.env['CLOUDFLARE_ACCOUNT_ID'],
	databaseId: process.env['CLOUDFLARE_D1_DATABASE_ID'],
	token: process.env['CLOUDFLARE_API_TOKEN'],
};
const hasCredentials = Boolean(credentials.accountId && credentials.databaseId && credentials.token);

describe.skipIf(!hasCredentials)('against a real D1 database', () => {
	const runner = () =>
		remoteRunner({
			accountId: credentials.accountId!,
			databaseId: credentials.databaseId!,
			token: credentials.token!,
		});

	const TABLE = '_d1zzle_remote_test';

	afterEach(async () => {
		await runner().batch([`drop table if exists "${TABLE}"`]);
	});

	it('creates, writes and reads back', async () => {
		await runner().batch([
			`drop table if exists "${TABLE}"`,
			`create table "${TABLE}" ("id" text primary key, "n" integer not null) strict`,
			`insert into "${TABLE}" ("id", "n") values ('a', 1), ('b', 2)`,
		]);

		const rows = await runner().all<{ id: string; n: number }>(
			`select "id", "n" from "${TABLE}" order by "id"`,
		);
		expect(rows).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
	});

	it('rolls the whole batch back when one statement fails', async () => {
		// The guarantee migrations depend on. If this ever regresses, a failed
		// migration leaves the database half-applied.
		await runner().batch([
			`drop table if exists "${TABLE}"`,
			`create table "${TABLE}" ("id" text primary key) strict`,
		]);

		await expect(runner().batch([
			`insert into "${TABLE}" ("id") values ('x')`,
			'this is not valid sql',
		])).rejects.toThrow();

		const rows = await runner().all(`select "id" from "${TABLE}"`);
		expect(rows).toEqual([]);
	});

	it('creates a trigger, which /query cannot express', async () => {
		// The regression this whole import path exists for: every `appendOnly`
		// table the kit generates carries a trigger whose body contains a
		// semicolon, and `/query` cuts it in half.
		await runner().batch([
			`drop table if exists "${TABLE}"`,
			`create table "${TABLE}" ("id" text primary key) strict`,
			`create trigger "${TABLE}_no_update" before update on "${TABLE}" begin\n  select raise(abort, 'append-only');\nend`,
		]);

		const triggers = await runner().all<{ name: string }>(
			`select name from sqlite_master where type = 'trigger' and name = '${TABLE}_no_update'`,
		);
		expect(triggers).toEqual([{ name: `${TABLE}_no_update` }]);

		await runner().batch([`insert into "${TABLE}" ("id") values ('a')`]);
		await expect(runner().batch([`update "${TABLE}" set "id" = 'b'`])).rejects.toThrow();
	});

	it('enforces STRICT, so the remote path agrees with the local one', async () => {
		await runner().batch([
			`drop table if exists "${TABLE}"`,
			`create table "${TABLE}" ("id" text primary key, "n" integer not null) strict`,
		]);

		await expect(runner().batch([`insert into "${TABLE}" ("id", "n") values ('a', 'not-an-integer')`]))
			.rejects.toThrow();
	});
});
