import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asTargetFlags, parseArgs, run } from '../../src/cli.js';
import { appendEntry, emptyJournal, migrationName, migrationTag, nextIndex, pendingMigrations } from '../../src/core/journal.js';
import { applicableStatements, isPragma, splitStatements } from '../../src/core/sql.js';
import { loadConfig, parseJsonc, readWranglerConfig } from '../../src/node/config.js';

const temp = () => mkdtemp(join(tmpdir(), 'd1zzle-migrate-'));

describe('splitting a migration into statements', () => {
	it('splits on semicolons', () => {
		expect(splitStatements('create table a (id integer);\ncreate table b (id integer);'))
			.toEqual(['create table a (id integer)', 'create table b (id integer)']);
	});

	it('ignores semicolons inside strings and identifiers', () => {
		expect(splitStatements(`insert into t values ('a;b');select "we;ird" from t;`))
			.toEqual([`insert into t values ('a;b')`, `select "we;ird" from t`]);
	});

	it('handles doubled quotes as escapes', () => {
		expect(splitStatements(`insert into t values ('it''s; fine');`))
			.toEqual([`insert into t values ('it''s; fine')`]);
	});

	it('strips line and block comments', () => {
		expect(splitStatements('-- a comment; not a statement\ncreate table a (id integer); /* also; here */'))
			.toEqual(['create table a (id integer)']);
	});

	it('tolerates a missing trailing semicolon', () => {
		expect(splitStatements('create table a (id integer)')).toEqual(['create table a (id integer)']);
	});

	it('filters PRAGMAs, which a D1 batch neither needs nor accepts', () => {
		const sql = 'PRAGMA foreign_keys = OFF;\ncreate table a (id integer);\nPRAGMA foreign_keys = ON;';
		expect(isPragma('PRAGMA foreign_keys = OFF')).toBe(true);
		expect(applicableStatements(sql)).toEqual(['create table a (id integer)']);
	});
});

describe('the journal', () => {
	it('numbers migrations from zero and keeps them ordered', () => {
		let journal = emptyJournal();
		expect(nextIndex(journal)).toBe(0);

		journal = appendEntry(journal, migrationTag(0, migrationName(0)), 1);
		journal = appendEntry(journal, migrationTag(1, migrationName(1)), 2);

		expect(journal.entries.map((e) => e.tag)).toEqual(['0000_brave_anchor', '0001_calm_harbor']);
		expect(nextIndex(journal)).toBe(2);
	});

	it('reports only what the database has not recorded', () => {
		let journal = emptyJournal();
		journal = appendEntry(journal, '0000_a', 1);
		journal = appendEntry(journal, '0001_b', 2);

		expect(pendingMigrations(journal, ['0000_a']).map((e) => e.tag)).toEqual(['0001_b']);
		expect(pendingMigrations(journal, ['0000_a.sql']).map((e) => e.tag)).toEqual(['0001_b']);
		expect(pendingMigrations(journal, [])).toHaveLength(2);
	});
});

describe('config', () => {
	it('parses JSONC with comments and trailing commas', () => {
		expect(parseJsonc<{ a: number; b: string }>(`{
			// a comment
			"a": 1, /* inline */
			"b": "https://example.com", // not a comment
		}`)).toEqual({ a: 1, b: 'https://example.com' });
	});

	it('reads the D1 binding out of wrangler.jsonc', async () => {
		const dir = await temp();
		await writeFile(
			join(dir, 'wrangler.jsonc'),
			`{
				// the binding
				"name": "app",
				"d1_databases": [
					{ "binding": "DB", "database_name": "app-db", "database_id": "abc-123" },
				],
			}`,
		);

		expect(await readWranglerConfig(dir)).toMatchObject({
			d1_databases: [{ binding: 'DB', database_name: 'app-db', database_id: 'abc-123' }],
		});
	});

	it('reads wrangler.toml too', async () => {
		const dir = await temp();
		await writeFile(
			join(dir, 'wrangler.toml'),
			'name = "app"\naccount_id = "acc"\n\n[[d1_databases]]\nbinding = "DB"\n'
				+ 'database_name = "app-db"\ndatabase_id = "abc-123"\n',
		);

		expect(await readWranglerConfig(dir)).toMatchObject({
			account_id: 'acc',
			d1_databases: [{ binding: 'DB', database_name: 'app-db', database_id: 'abc-123' }],
		});
	});

	it('defaults the database from wrangler and the output to its layout', async () => {
		const dir = await temp();
		await writeFile(
			join(dir, 'wrangler.jsonc'),
			'{"d1_databases":[{"binding":"DB","database_name":"app-db","database_id":"abc-123"}]}',
		);
		await writeFile(
			join(dir, 'd1zzle.config.ts'),
			`export default { schema: './schema.ts' };\n`,
		);

		const config = await loadConfig(dir);
		expect(config.out).toBe('./migrations');
		expect(config.migrationsTable).toBe('d1_migrations');
		expect(config.d1).toMatchObject({ databaseName: 'app-db', databaseId: 'abc-123', binding: 'DB' });
	});

	it('explains itself when there is no config at all', async () => {
		const dir = await temp();
		await expect(loadConfig(dir)).rejects.toThrow(/d1zzle.config.ts/);
	});
});

describe('argument parsing', () => {
	it('reads commands, boolean flags and values', () => {
		expect(parseArgs(['generate', '--name', 'add_users', '--accept-data-loss'])).toEqual({
			command: 'generate',
			flags: { name: 'add_users', 'accept-data-loss': true },
		});
		expect(parseArgs(['migrate', '--remote'])).toEqual({ command: 'migrate', flags: { remote: true } });
		expect(parseArgs(['pull', '--schema-out=./db.ts'])).toEqual({
			command: 'pull',
			flags: { 'schema-out': './db.ts' },
		});
		expect(parseArgs([])).toEqual({ command: 'help', flags: {} });
	});

	it('splits a flag value on the first = only', () => {
		// `--rename-column users.a=b` is exactly this shape, and `split('=')`
		// used to drop everything after the second one.
		expect(parseArgs(['generate', '--name=a=b']).flags).toEqual({ name: 'a=b' });
	});

	it('coerces an =-spelled boolean flag to an actual boolean', () => {
		// `--remote=true` used to be stored as the *string* `'true'`, which
		// `asTargetFlags`'s `=== true` check silently treated as absent — the
		// command ran against the local database while looking like it had
		// asked for remote.
		expect(asTargetFlags(parseArgs(['migrate', '--remote=true']).flags)).toMatchObject({ remote: true });
		expect(asTargetFlags(parseArgs(['migrate', '--remote=false']).flags)).toMatchObject({ remote: false });
	});

	it('coerces the space-separated boolean form too', () => {
		expect(asTargetFlags(parseArgs(['migrate', '--remote', 'true']).flags)).toMatchObject({ remote: true });
	});

	it('honours a genuinely coerced --accept-data-loss=true', () => {
		// The coercion that fixes `--remote=true` must not turn
		// `--accept-data-loss=true` into something less than a real `true` —
		// the whole point of `=true` failing closed *before* this fix was that
		// a string can never accidentally grant it.
		expect(asTargetFlags(parseArgs(['push', '--accept-data-loss=true']).flags))
			.toMatchObject({ acceptDataLoss: true });
	});

	it('rejects a boolean flag spelled in a way parseArgs does not coerce', () => {
		// Anything parseArgs did not turn into an actual boolean must fail
		// loudly in asTargetFlags rather than silently default to false —
		// failing closed beats quietly running against the wrong database.
		expect(() => asTargetFlags({ remote: 'yes' })).toThrow(/--remote expects true or false/);
		expect(() => asTargetFlags({ 'accept-data-loss': 'yes' })).toThrow(/--accept-data-loss expects true or false/);
	});

	it('accumulates a repeated flag', () => {
		expect(parseArgs(['generate', '--rename-column', 'users.a=b', '--rename-column', 'posts.c=d']).flags)
			.toEqual({ 'rename-column': ['users.a=b', 'posts.c=d'] });
	});
});

describe('--help in the command position', () => {
	it('prints usage instead of looking for a config', async () => {
		await expect(run(['--help'])).resolves.toBe(0);
	});

	it('does not treat every other flag-shaped first token as --help', async () => {
		// `command.startsWith('-')` used to match ANY leading-dash first token,
		// so `--nope`, `-x`, and flags-before-command invocations like
		// `d1zzle-migrate --remote migrate` all silently printed usage and
		// exited 0 instead of failing. None of those are `-h`/`--help`/`help`,
		// so they must fall through to the normal (non-zero) unrecognised-input
		// path instead of resolving to 0.
		// Past the help check, both fall through to the normal command path,
		// which (with no d1zzle config in this test's cwd) rejects rather than
		// resolving — the point is only that neither resolves to 0.
		await expect(run(['--nope'])).rejects.toThrow();
		await expect(run(['--remote', 'migrate'])).rejects.toThrow();
	});
});

describe('BOOLEAN_FLAGS coercion', () => {
	it('parses --force and --force=true as real booleans, not strings', () => {
		expect(parseArgs(['pull', '--force']).flags['force']).toBe(true);
		expect(parseArgs(['pull', '--force=true']).flags['force']).toBe(true);
		expect(parseArgs(['pull', '--force=false']).flags['force']).toBe(false);
	});

	it('parses --help=true as a real boolean', () => {
		expect(parseArgs(['generate', '--help=true']).flags['help']).toBe(true);
	});
});

describe('rename flags', () => {
	it('turns repeated flags into the diff options generate already reads', () => {
		const { flags } = parseArgs([
			'generate',
			'--rename-table=users=people',
			'--rename-column=people.name=full_name',
			'--rename-column=people.email=address',
		]);

		expect(asTargetFlags(flags).renames).toEqual({
			renamedTables: { users: 'people' },
			renamedColumns: { 'people.name': 'full_name', 'people.email': 'address' },
		});
	});

	it('omits renames entirely when none were given', () => {
		expect(asTargetFlags(parseArgs(['generate']).flags).renames).toBeUndefined();
	});

	it('rejects a malformed pair rather than half-applying it', () => {
		expect(() => asTargetFlags(parseArgs(['generate', '--rename-table=users']).flags))
			.toThrow(/expects old_table=new_table/);
		// A column rename without its table would be ambiguous across tables.
		expect(() => asTargetFlags(parseArgs(['generate', '--rename-column=name=full_name']).flags))
			.toThrow(/needs a table/);
	});
});

describe('generate, end to end on disk', () => {
	it('writes a migration, a snapshot and a journal entry', async () => {
		const dir = await temp();
		const { generate } = await import('../../src/node/commands.js');

		await writeFile(
			join(dir, 'schema.ts'),
			`import { integer, sqliteTable, text } from '${schemaImport()}';\n`
				+ `export const users = sqliteTable('users', {\n`
				+ `\tid: integer('id').primaryKey(),\n`
				+ `\temail: text('email').notNull(),\n`
				+ `});\n`,
		);

		const ctx = {
			cwd: dir,
			config: {
				schema: './schema.ts',
				out: join(dir, 'migrations'),
				d1: {},
				migrationsTable: 'd1_migrations',
			},
			log: () => {},
			now: () => 1,
		};

		const first = await generate(ctx);
		expect(first.tag).toBe('0000_brave_anchor');
		expect(await readFile(first.path!, 'utf8')).toContain('create table "users"');

		const journal = JSON.parse(await readFile(join(dir, 'migrations/meta/_journal.json'), 'utf8')) as {
			entries: { tag: string }[];
		};
		expect(journal.entries.map((e) => e.tag)).toEqual(['0000_brave_anchor']);

		// Running again with an unchanged schema produces nothing.
		expect((await generate(ctx)).tag).toBeUndefined();
	});

	it('tells the user why a constraint rename produced no migration', async () => {
		const dir = await temp();
		const { generate } = await import('../../src/node/commands.js');
		const out = join(dir, 'migrations');
		const logged: string[] = [];

		const write = (file: string, constraintName: string) =>
			writeFile(
				join(dir, file),
				`import { integer, sqliteTable, text, unique } from '${schemaImport()}';\n`
					+ `export const users = sqliteTable('users', {\n`
					+ `\tid: integer('id').primaryKey(),\n`
					+ `\temail: text('email').notNull(),\n`
					+ `}, (t) => [unique('${constraintName}').on(t.email)]);\n`,
			);

		await write('before.ts', 'users_email_uq');
		await write('after.ts', 'users_email_unique');

		const ctx = (schema: string) => ({
			cwd: dir,
			config: { schema, out, d1: {}, migrationsTable: 'd1_migrations' },
			log: (message: string) => logged.push(message),
			now: () => 1,
		});

		await generate(ctx('./before.ts'));
		logged.length = 0;

		// SQLite does not store the declared name, so there is nothing to emit —
		// but an empty migration with no explanation reads like a bug.
		const result = await generate(ctx('./after.ts'));
		expect(result.tag).toBeUndefined();
		expect(logged.join('\n')).toMatch(/"users_email_uq" was renamed/);
	});

	it('refuses to drop a column without --accept-data-loss', async () => {
		const dir = await temp();
		const { generate } = await import('../../src/node/commands.js');
		const out = join(dir, 'migrations');

		// Two files rather than one edited in place: Node caches modules by URL,
		// and a real CLI run is always a fresh process.
		const write = (file: string, columns: string) =>
			writeFile(
				join(dir, file),
				`import { integer, sqliteTable, text } from '${schemaImport()}';\n`
					+ `export const users = sqliteTable('users', { ${columns} });\n`,
			);

		await write('before.ts', `id: integer('id').primaryKey(), old: text('old')`);
		await write('after.ts', `id: integer('id').primaryKey()`);

		const ctx = (schema: string) => ({
			cwd: dir,
			config: { schema, out, d1: {}, migrationsTable: 'd1_migrations' },
			log: () => {},
			now: () => 1,
		});

		await generate(ctx('./before.ts'));
		await expect(generate(ctx('./after.ts'))).rejects.toThrow(/would lose data/);
		expect((await generate(ctx('./after.ts'), { acceptDataLoss: true })).tag).toBe('0001_calm_harbor');
	});
});

describe('rendering a schema module from a snapshot', () => {
	const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
		name,
		type,
		primaryKey: false,
		notNull: false,
		autoincrement: false,
		unique: false,
		...extra,
	});

	const snapshotOf = (columns: Record<string, unknown>, indexes: Record<string, unknown> = {}) => ({
		version: '1',
		dialect: 'sqlite' as const,
		id: 'x',
		prevId: '',
		tables: {
			things: {
				name: 'things',
				columns,
				indexes,
				foreignKeys: {},
				compositePrimaryKeys: {},
				uniqueConstraints: {},
				checkConstraints: {},
			},
		},
	});

	it('imports every factory it uses, blob included', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const rendered = renderSchemaModule(snapshotOf({
			id: column('id', 'integer', { primaryKey: true }),
			payload: column('payload', 'blob'),
		}) as never);

		expect(rendered.split('\n')[0]).toBe(`import { blob, integer, sqliteTable } from 'd1zzle';`);
		// blob() defaults to mode 'json'; an introspected BLOB-affinity column
		// must round-trip as raw bytes, so pull emits explicit buffer mode.
		expect(rendered).toContain(`payload: blob("payload", { mode: 'buffer' })`);
	});

	it('keeps the constraints the snapshot has, so the next generate has nothing to remove', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const snapshot = {
			version: '1',
			dialect: 'sqlite' as const,
			id: 'x',
			prevId: '',
			tables: {
				// Declared child-first, to prove the renderer orders by reference.
				scores: {
					name: 'scores',
					columns: {
						user_id: column('user_id', 'integer', {
							references: { name: 'fk', columns: ['user_id'], tableTo: 'users', columnsTo: ['id'], onDelete: 'cascade' },
						}),
						slot: column('slot', 'integer'),
					},
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {
						scores_pk: { name: 'scores_pk', columns: ['user_id', 'slot'] },
					},
					uniqueConstraints: {},
					checkConstraints: { slot_check: { name: 'slot_check', value: '"slot" >= 0' } },
				},
				users: {
					name: 'users',
					columns: {
						id: column('id', 'integer', { primaryKey: true }),
						email: column('email', 'text', { notNull: true, unique: true }),
					},
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {},
					uniqueConstraints: {},
					checkConstraints: {},
				},
			},
		};

		const rendered = renderSchemaModule(snapshot as never);

		expect(rendered).toContain(`email: text("email").notNull().unique()`);
		expect(rendered).toContain(`.references(() => users.id, { onDelete: "cascade" })`);
		expect(rendered).toContain(`primaryKey({ columns: [t.userId, t.slot] })`);
		expect(rendered).toContain(`check("slot_check", sql.raw("\\"slot\\" >= 0"))`);
		// `users` is referenced by `scores`, so it has to be declared first.
		expect(rendered.indexOf('export const users')).toBeLessThan(rendered.indexOf('export const scores'));
	});

	it('imports only what it uses', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const rendered = renderSchemaModule(snapshotOf(
			{ name: column('name', 'text', { default: `(unixepoch())` }) },
			{ things_name: { name: 'things_name', columns: ['name'], isUnique: true } },
		) as never);

		expect(rendered.split('\n')[0])
			.toBe(`import { sql, sqliteTable, text, uniqueIndex } from 'd1zzle';`);
	});
});

describe('renderSchemaModule never interpolates raw text into generated code', () => {
	// Every string that reaches the renderer from introspected SQL — a table
	// name, a check body, a default, a partial-index predicate — is attacker
	// data the moment `pull` runs against a database someone else can write
	// to. `` sql`${text}` `` and `'${text}'` both let it break out of the
	// template literal / string literal the renderer writes and run as code
	// the moment the generated module is imported.
	const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
		name,
		type,
		primaryKey: false,
		notNull: false,
		autoincrement: false,
		unique: false,
		...extra,
	});

	// One string carrying all four dangerous characters at once: a backtick, a
	// `${` template-interpolation opener, a single quote, and a backslash.
	const poison = `back\`tick \${dollar} 'quote' back\\slash`;

	const poisonedSnapshot = (tableName: string) => ({
		version: '1',
		dialect: 'sqlite' as const,
		id: 'x',
		prevId: '',
		tables: {
			[tableName]: {
				name: tableName,
				columns: {
					id: column('id', 'integer', { primaryKey: true }),
					val: column('val', 'text', { default: `'${poison}'` }),
				},
				indexes: {
					[`${tableName}_idx`]: {
						name: `${tableName}_idx`,
						columns: [{ expression: poison, isExpression: true }],
						isUnique: false,
						where: poison,
					},
				},
				foreignKeys: {},
				compositePrimaryKeys: {},
				uniqueConstraints: {},
				checkConstraints: {
					[poison]: { name: poison, value: poison },
				},
			},
		},
	});

	it('escapes a table name, index name, check name/body, default and partial-index where', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const rendered = renderSchemaModule(poisonedSnapshot('things') as never);

		// Everything dangerous went through JSON.stringify or
		// sql.raw(JSON.stringify(...)), so it is JS string-literal *data* now,
		// not live template syntax — the raw poison string legitimately still
		// appears in the output (inside quotes), which is fine; what matters is
		// that it never opens a real template literal or closes a real string.
		expect(rendered).toContain(JSON.stringify(poison));
		// No backtick in the output is un-escaped into starting a template
		// literal: every backtick that survives is a plain character sitting
		// inside a JSON.stringify'd "..." string, never a `` ` `` token.
		expect(rendered).not.toMatch(/sql`/);

		const { transform } = await import('esbuild');
		const result = await transform(rendered, { loader: 'ts' });
		expect(result.code).toBeTruthy();

		// Re-parsing reproduces the value: `JSON.parse` on the exact escaped
		// literal the renderer wrote gets the original poison text back, byte
		// for byte — which is only meaningful because the previous assertion
		// already pinned that literal as present in the output verbatim.
		expect(JSON.parse(JSON.stringify(poison))).toBe(poison);

		// Exactly one binding was declared — no extra `export const` sneaked
		// in via the table name, check name, or any other field.
		expect((result.code.match(/^export const /gm) ?? []).length).toBe(1);
	});

	it('regression: a DEFAULT payload cannot execute as a top-level side effect', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const payload = `'\${globalThis.__PWNED__ = 1}'`;
		const rendered = renderSchemaModule({
			version: '1',
			dialect: 'sqlite' as const,
			id: 'x',
			prevId: '',
			tables: {
				t: {
					name: 't',
					columns: { val: column('val', 'text', { default: payload }) },
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {},
					uniqueConstraints: {},
					checkConstraints: {},
				},
			},
		} as never);

		// The raw payload text is expected to still appear — as escaped string
		// *data* inside `sql.raw(JSON.stringify(...))`. What must not appear is
		// a *live* `${globalThis.__PWNED__ = 1}` template-interpolation slot,
		// which is what let it execute before this fix.
		expect(rendered).toContain(JSON.stringify(payload));
		expect(rendered).not.toMatch(/`[^`]*\$\{globalThis\.__PWNED__[^`]*`/);

		const { transform } = await import('esbuild');
		const result = await transform(rendered, { loader: 'ts' });
		expect(result.code).toBeTruthy();
		// Exactly one binding was declared — the payload never became a second
		// top-level statement.
		expect((result.code.match(/^export const /gm) ?? []).length).toBe(1);
	});

	it('regression: a table name cannot close the sqliteTable(...) call and inject a new statement', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const evilName = "a', {}); globalThis.__PWNED3__ = 3; export const zz = sqliteTable('b";
		const rendered = renderSchemaModule({
			version: '1',
			dialect: 'sqlite' as const,
			id: 'x',
			prevId: '',
			tables: {
				[evilName]: {
					name: evilName,
					columns: { id: column('id', 'integer', { primaryKey: true }) },
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {},
					uniqueConstraints: {},
					checkConstraints: {},
				},
			},
		} as never);

		// The evil name legitimately still shows up — as an escaped string
		// argument to `sqliteTable(...)`.
		expect(rendered).toContain(JSON.stringify(evilName));

		const { transform } = await import('esbuild');
		const result = await transform(rendered, { loader: 'ts' });
		expect(result.code).toBeTruthy();
		// Only one binding was declared — no `export const zz` was injected as
		// a second top-level statement.
		expect((result.code.match(/^export const /gm) ?? []).length).toBe(1);
	});

	it('leaves ordinary, benign input producing the same DDL shape as before — only quoting style changed', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const rendered = renderSchemaModule({
			version: '1',
			dialect: 'sqlite' as const,
			id: 'x',
			prevId: '',
			tables: {
				users: {
					name: 'users',
					columns: {
						id: column('id', 'integer', { primaryKey: true }),
						email: column('email', 'text', { notNull: true, unique: true }),
					},
					indexes: {},
					foreignKeys: {},
					compositePrimaryKeys: {},
					uniqueConstraints: {},
					checkConstraints: {},
				},
			},
		} as never);

		expect(rendered).toContain(`export const users = sqliteTable("users", {`);
		expect(rendered).toContain(`id: integer("id").primaryKey()`);
		expect(rendered).toContain(`email: text("email").notNull().unique()`);
	});
});

describe('up', () => {
	it('rewrites each historical snapshot in place, not the latest over all of them', async () => {
		const dir = await temp();
		const out = join(dir, 'migrations');
		const { up } = await import('../../src/node/commands.js');
		const { writeJournal, writeSnapshot, readSnapshot } = await import('../../src/node/store.js');

		let journal = emptyJournal();
		journal = appendEntry(journal, '0000_a', 1);
		journal = appendEntry(journal, '0001_b', 2);
		await writeJournal(out, journal);

		// Both stale, and distinguishable — the old implementation would have
		// written whichever one sorted last over both indices.
		await writeSnapshot(out, 0, { version: '0', dialect: 'sqlite', id: '0000_a', prevId: '', tables: {} });
		await writeSnapshot(out, 1, { version: '0', dialect: 'sqlite', id: '0001_b', prevId: '0000_a', tables: {} });

		const ctx = { cwd: dir, config: { schema: '', out, d1: {}, migrationsTable: 'd1_migrations' }, log: () => {}, now: () => 1 };
		expect(await up(ctx)).toBe(2);

		// Against the current version, not a literal: what `up` promises is
		// "brings every snapshot to the format this kit reads", so pinning the
		// number here just breaks the test on each bump without testing more.
		const { SNAPSHOT_VERSION } = await import('../../src/core/snapshot.js');
		expect(await readSnapshot(out, 0)).toMatchObject({ version: SNAPSHOT_VERSION, id: '0000_a' });
		expect(await readSnapshot(out, 1)).toMatchObject({ version: SNAPSHOT_VERSION, id: '0001_b' });

		// Current snapshots are left alone.
		expect(await up(ctx)).toBe(0);
	});
});

/** The temp schema imports d1zzle from this checkout, not from node_modules. */
const schemaImport = (): string => new URL('../../../src/index.ts', import.meta.url).pathname;

describe('parseJsonc edge cases', () => {
	it('leaves commas inside strings alone', async () => {
		// The trailing-comma pass used to be a regex over the whole text, which
		// cannot tell a separator from a comma in a value.
		expect(parseJsonc<{ a: string }>('{"a": "a, }b"}')).toEqual({ a: 'a, }b' });
	});

	it('handles a value ending in a backslash', async () => {
		// `text[i - 1] !== '\\'` read the escaped backslash as escaping the
		// quote, leaving the scanner inside a string for the rest of the file —
		// which silently disabled comment stripping from there on.
		const text = '{\n\t"path": "C:\\\\dir\\\\", // trailing comment\n\t"b": 1,\n}';
		expect(parseJsonc<{ path: string; b: number }>(text)).toEqual({ path: 'C:\\dir\\', b: 1 });
	});

	it('still strips genuinely trailing commas, including before a comment', () => {
		expect(parseJsonc<{ a: number[] }>('{"a": [1, 2, ] /* done */, }')).toEqual({ a: [1, 2] });
	});
});

describe('renderSchemaModule identifiers', () => {
	const table = (name: string, columns: string[]) => ({
		name,
		columns: Object.fromEntries(columns.map((c) => [c, {
			name: c,
			type: 'text',
			primaryKey: false,
			notNull: false,
			autoincrement: false,
			unique: false,
		}])),
		indexes: {},
		foreignKeys: {},
		compositePrimaryKeys: {},
		uniqueConstraints: {},
		checkConstraints: {},
	});

	it('does not emit two consts with the same name', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		// All three collapse to `userRoles` under the old naming.
		const rendered = renderSchemaModule({
			version: '1',
			dialect: 'sqlite' as const,
			id: '',
			prevId: '',
			tables: {
				user_roles: table('user_roles', ['id']),
				userRoles: table('userRoles', ['id']),
				'user-roles': table('user-roles', ['id']),
			},
		} as never);

		const names = [...rendered.matchAll(/export const (\w+)/g)].map((m) => m[1]);
		expect(new Set(names).size).toBe(names.length);
	});

	it('does not emit a reserved word as a binding', async () => {
		const { renderSchemaModule } = await import('../../src/node/commands.js');
		const rendered = renderSchemaModule({
			version: '1',
			dialect: 'sqlite' as const,
			id: '',
			prevId: '',
			tables: { new: table('new', ['id']) },
		} as never);

		expect(rendered).not.toMatch(/export const new\b/);
		expect(rendered).toMatch(/export const new_ = sqliteTable\("new"/);
	});
});

describe('check drift classification', () => {
	const column = (name: string, type: string, rest: Record<string, unknown> = {}) => ({
		name,
		type,
		primaryKey: false,
		notNull: false,
		autoincrement: false,
		unique: false,
		...rest,
	});

	const table = (name: string, columns: Record<string, unknown>) => ({
		name,
		columns,
		indexes: {},
		foreignKeys: {},
		compositePrimaryKeys: {},
		uniqueConstraints: {},
		checkConstraints: {},
	});

	const snapshot = (origin: 'schema' | 'introspection', parentType: string) => ({
		version: '1',
		dialect: 'sqlite' as const,
		id: 'x',
		prevId: '',
		origin,
		tables: {
			parent: table('parent', {
				id: column('id', 'integer', { primaryKey: true }),
				v: column('v', parentType),
			}),
			child: table('child', {
				id: column('id', 'integer', { primaryKey: true }),
				pid: column('pid', 'integer', {
					references: { name: 'fk', columns: ['pid'], tableTo: 'parent', columnsTo: ['id'] },
				}),
			}),
		},
	});

	it('counts a refused rebuild as drift, not as nothing to do', async () => {
		const { driftBetween } = await import('../../src/node/commands.js');

		// The rebuild is refused because `child` references `parent`, so it
		// produces an error and zero statements. Counting only statements let
		// this pass CI silently.
		const { drift, blocked } = driftBetween(
			snapshot('introspection', 'text') as never,
			snapshot('schema', 'integer') as never,
		);

		expect(drift).toEqual([]);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toMatch(/has to be recreated/);
	});

	it('reports no drift of either kind when the two agree', async () => {
		const { driftBetween } = await import('../../src/node/commands.js');
		const { drift, blocked } = driftBetween(
			snapshot('introspection', 'text') as never,
			snapshot('schema', 'text') as never,
		);

		expect(drift).toEqual([]);
		expect(blocked).toEqual([]);
	});
});

describe('verify', () => {
	/** A project on disk with one generated migration, ready to be tampered with. */
	const project = async (schemaBody: string) => {
		const dir = await temp();
		const out = join(dir, 'migrations');
		await writeFile(
			join(dir, 'schema.ts'),
			`import { integer, sqliteTable, text } from '${schemaImport()}';\n${schemaBody}`,
		);
		const ctx = {
			cwd: dir,
			config: { schema: './schema.ts', out, d1: {}, migrationsTable: 'd1_migrations' },
			log: () => {},
			now: () => 1,
		};
		const { generate } = await import('../../src/node/commands.js');
		const result = await generate(ctx);
		return { dir, out, ctx, path: result.path! };
	};

	const SCHEMA = `export const users = sqliteTable('users', {\n`
		+ `\tid: integer('id').primaryKey(),\n`
		+ `\temail: text('email').notNull().unique(),\n`
		+ `});\n`;

	it('passes when the migrations replay into the schema', async () => {
		const { ctx } = await project(SCHEMA);
		const { verify } = await import('../../src/node/commands.js');

		const result = await verify(ctx);
		expect(result.ok).toBe(true);
		expect(result.differences).toEqual([]);
		expect(result.applied).toBe(1);
	});

	it('catches a constraint the migration SQL lost', async () => {
		// The docs/35 failure mode, reproduced: the migration and its snapshot
		// agree with each other and disagree with the schema, so a check that
		// compares the database against the snapshot stays green. Replaying
		// against the *schema* is what catches it.
		const { ctx, path } = await project(SCHEMA);
		await writeFile(path, (await readFile(path, 'utf8')).replace(' unique', ''));

		const { verify } = await import('../../src/node/commands.js');
		const result = await verify(ctx);

		expect(result.ok).toBe(false);
		expect(result.differences.join('\n')).toMatch(/unique constraint changes/);
	});

	it('catches a column the migration never created', async () => {
		const { ctx, path } = await project(SCHEMA);
		await writeFile(path, (await readFile(path, 'utf8')).replace(/,\n\t"email"[^\n]*\n/, '\n'));

		const { verify } = await import('../../src/node/commands.js');
		expect((await verify(ctx)).ok).toBe(false);
	});

	it('reports a migration that cannot even be applied, rather than throwing', async () => {
		const { ctx, path } = await project(SCHEMA);
		await writeFile(path, 'create table "users" ( this is not sql;');

		const { verify } = await import('../../src/node/commands.js');
		const result = await verify(ctx);

		expect(result.ok).toBe(false);
		expect(result.differences[0]).toMatch(/failed to apply/);
	});

	it('replays a migration containing a trigger', async () => {
		// `verify` splits the file itself, so the trigger-body split bug would
		// have made every append-only project unverifiable.
		const { ctx, path } = await project(SCHEMA);
		const sql = await readFile(path, 'utf8');
		await writeFile(
			path,
			`${sql}\ncreate trigger "users_no_update"\nbefore update on "users"\nbegin\n`
				+ `\tselect raise(abort, 'users is append-only: UPDATE is prohibited');\nend;\n`,
		);

		const { verify } = await import('../../src/node/commands.js');
		const result = await verify(ctx);

		// The trigger is not in the schema's table options, so it is extra —
		// but it must at least have applied without a syntax error.
		expect(result.differences.join('\n')).not.toMatch(/failed to apply/);
	});
});

/**
 * `--name` becomes the migration's file name.
 *
 * `migrationTag` builds the tag, `writeMigration` joins it onto the output
 * folder and `readMigration` joins it back — so an unvalidated name is a path,
 * not a label. `--name ../../../tmp/pwned` produced the tag
 * `0003_../../../tmp/pwned` and wrote outside the migrations folder entirely.
 * The name is normally hand-typed, which is why this survived; a CI job
 * deriving it from a branch or PR title is the case nobody reads.
 */
describe('migration name validation', () => {
	it('accepts the names the tool generates for itself', () => {
		for (let i = 0; i < 20; i++) {
			expect(() => migrationTag(i, migrationName(i))).not.toThrow();
		}
		expect(migrationTag(3, 'add_users')).toBe('0003_add_users');
		expect(migrationTag(12, 'add-users-2')).toBe('0012_add-users-2');
	});

	it.each([
		['../../../tmp/pwned', 'parent traversal'],
		['..', 'bare parent'],
		['a/b', 'forward slash'],
		['a\\b', 'backslash'],
		['a.sql', 'a dot, which also reaches `..`'],
		['has space', 'a space'],
		['', 'empty'],
		[String.fromCharCode(0) + 'null', 'a NUL byte'],
	])('refuses %j (%s)', (name) => {
		expect(() => migrationTag(0, name)).toThrow(/Invalid migration name/);
	});

	it('refuses before anything is written, so the tag never reaches a path join', () => {
		// The tag is what `join(out, `${tag}.sql`)` receives; asserting the throw
		// rather than a sanitised value is deliberate — silently rewriting a name
		// the caller chose would put the migration somewhere they did not ask for.
		expect(() => migrationTag(0, '../escape')).toThrow(/only letters, digits, underscores and hyphens/);
	});
});
