/**
 * A reviewer's fresh 1200-seed differential corpus (real D1, HEAD vs `main`
 * side by side) found three collation-parsing holes, all in the same family
 * — a collation spelled as a string literal (`collate 'nocase'`), which
 * SQLite's grammar accepts wherever a name is expected (`ids ::= ID|STRING`)
 * and D1 stores and enforces exactly like the bare/quoted-identifier
 * spellings:
 *
 *  1. REGRESSION: `parseIndexCollations` (round 6's `[F-069]` fix) scanned
 *     `blankLiterals(member)`, whose alternation still had a `'…'` branch
 *     that could only ever capture blanks — an index member's own
 *     `collate 'nocase'` came back as six spaces and re-rendered as
 *     unappliable DDL (`collate       )`, syntax error).
 *  2. `parseTablePrimaryKeyClause`/`parseTableUniqueConstraints` had the
 *     same hole for a PK/unique-constraint member's `collate 'nocase'`.
 *  3. The `binary` exclusion on a single-column PK-clause member
 *     (`introspect.ts`, "collate binary is inert") is wrong: `collate
 *     binary` on the PK's own automatic index overrides a *different*
 *     column-level collation (unlike a plain column's `collate binary`,
 *     which really is inert), so folding it away silently loosened —  or,
 *     against a populated table, made unappliable — the rebuilt PK index.
 *
 * All three are exercised here against a real D1, the same way
 * `collation-rebuild.test.ts` proves the plain-`nocase` carry-forward: hand-
 * write the "live" table (the schema DSL has no `.collate()` spelling,
 * `docs/04`), introspect it, force a rebuild with an unrelated schema-side
 * change, apply it, and assert SQLite's own comparison behavior survived —
 * not just that the parsed snapshot looks right.
 */
import { env } from 'cloudflare:test';
import { index, sql, sqliteTable, text, unique } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { createTableFromSnapshot, normalizeIndexColumn, snapshotFromSchema } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sqlText: string) => (await DB.prepare(sqlText).all<T>()).results as T[],
	batch: async (statements) => {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

describe('a collation spelled as a string literal', () => {
	const TABLE = 'collate_lit_idx_t';

	beforeEach(async () => {
		await DB.prepare(`drop table if exists "${TABLE}"`).run();
		await DB.prepare(`create table "${TABLE}" ("id" integer primary key, "code" text not null)`).run();
		await DB.prepare(`create index "${TABLE}_code_idx" on "${TABLE}" ("code" collate 'nocase')`).run();
		await DB.prepare(`insert into "${TABLE}" ("id", "code") values (1, 'Abc')`).run();
	});

	it('is read by parseIndexCollations, survives a forced rebuild, and the rebuilt index still applies', async () => {
		const before = await introspect(runner);
		const idx = before.tables[TABLE]?.indexes[`${TABLE}_code_idx`];
		expect(normalizeIndexColumn(idx!.columns[0]!).collate).toBe('nocase');

		// Forces a rebuild via an unrelated change (id integer -> text), the same
		// way `collation-rebuild.test.ts` does. The index has to be *restated* in
		// the schema side too — `pull` expresses an index's own `collate` as a raw
		// `sql` expression (`snapshot.ts`'s `parseIndexExpression`), which is
		// exactly how a real `pull`-then-`generate` round-trip carries it, and is
		// what makes the regression reachable: without it here the index would
		// just be dropped for being schema-absent, not rebuilt.
		const afterTable = sqliteTable(TABLE, {
			id: text('id').primaryKey(),
			code: text('code').notNull(),
		}, (c) => [index(`${TABLE}_code_idx`).on(sql`"code" collate nocase`)]);
		const after = snapshotFromSchema([afterTable]);
		const { statements, errors } = diffSnapshots(before, after);
		expect(errors).toEqual([]);

		// The regression: a fabricated six-space collation renders as
		// `collate       )`, which D1 rejects outright — this `batch` throwing
		// is exactly the "migration cannot apply" failure the corpus found.
		await DB.batch(statements.map((s) => DB.prepare(s.sql)));

		const after2 = await introspect(runner);
		const rebuiltIdx = after2.tables[TABLE]?.indexes[`${TABLE}_code_idx`];
		expect(normalizeIndexColumn(rebuiltIdx!.columns[0]!).collate).toBe('nocase');
	});
});

describe('a unique-constraint member collation spelled as a string literal ([F-111] hole)', () => {
	const TABLE = 'collate_lit_uniq_t';

	beforeEach(async () => {
		await DB.prepare(`drop table if exists "${TABLE}"`).run();
		await DB.prepare(
			`create table "${TABLE}" ("id" integer primary key, "email" text not null, `
				+ `constraint "${TABLE}_email_u" unique ("email" collate 'nocase'))`,
		).run();
		await DB.prepare(`insert into "${TABLE}" ("id", "email") values (1, 'x@example.com')`).run();
	});

	it('is read by parseTableUniqueConstraints and the rebuilt table still enforces NOCASE uniqueness', async () => {
		const before = await introspect(runner);
		// SQLite names the automatic index for a table-level `constraint …
		// unique (…)` itself (`sqlite_autoindex_<table>_<n>`), not after the
		// constraint's own name — so look the clause up by value, not by key.
		const uc = Object.values(before.tables[TABLE]?.uniqueConstraints ?? {})[0];
		expect(uc?.columns).toEqual([{ name: 'email', collate: 'nocase' }]);

		const afterTable = sqliteTable(TABLE, {
			id: text('id').primaryKey(),
			email: text('email').notNull(),
		}, (c) => [unique(`${TABLE}_email_u`).on(c.email)]);
		const after = snapshotFromSchema([afterTable]);
		const { statements, errors } = diffSnapshots(before, after);
		expect(errors).toEqual([]);
		await DB.batch(statements.map((s) => DB.prepare(s.sql)));

		// Behavioral proof: the live table enforces NOCASE uniqueness (a second
		// row differing only in case collides). If the member's collation had
		// been dropped, the rebuilt constraint would be plain BINARY and this
		// insert would succeed instead of throwing.
		await expect(
			DB.prepare(`insert into "${TABLE}" ("id", "email") values (2, 'X@EXAMPLE.COM')`).run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});
});

describe('collate binary on a single-column primary-key clause member overrides the column\'s own collation', () => {
	const TABLE = 'collate_pk_binary_t';

	beforeEach(async () => {
		await DB.prepare(`drop table if exists "${TABLE}"`).run();
		// The column itself is NOCASE, but the PK clause's own member overrides
		// that to BINARY for the primary key's automatic index — legal SQLite,
		// and not equivalent to leaving the member unstated.
		await DB.prepare(
			`create table "${TABLE}" ("a" text collate nocase, `
				+ `constraint "${TABLE}_pk" primary key ("a" collate binary))`,
		).run();
		await DB.prepare(`insert into "${TABLE}" ("a") values ('x')`).run();
	});

	it('is recorded (not folded away as inert), and re-rendering + re-applying the snapshot still enforces BINARY on the PK', async () => {
		const before = await introspect(runner);
		const table = before.tables[TABLE]!;
		expect(table.columns['a']?.collate).toBe('nocase');
		const pk = Object.values(table.compositePrimaryKeys)[0];
		// This is the exclusion under test: with it in place, a single-column
		// PK-clause member whose collate is `binary` was dropped entirely
		// (`compositePrimaryKeys` came back `{}`), folding the member back into
		// the column-level `collate nocase primary key` rendering — silently
		// loosening the PK's own index from BINARY to NOCASE.
		expect(pk?.columns).toEqual([{ name: 'a', collate: 'binary' }]);

		// Render the introspected snapshot back out as DDL for a fresh table and
		// apply it — the same `createTableFromSnapshot` a rebuild uses — and
		// prove the *live* index behaves like the original: BINARY, so both
		// cases of the same letter coexist under the PK.
		const rebuiltName = `${TABLE}_rebuilt`;
		await DB.prepare(`drop table if exists "${rebuiltName}"`).run();
		const ddl = createTableFromSnapshot({ ...table, name: rebuiltName });
		await DB.prepare(ddl).run();
		await DB.prepare(`insert into "${rebuiltName}" ("a") values ('x')`).run();
		await DB.prepare(`insert into "${rebuiltName}" ("a") values ('X')`).run();
		const rows = await runner.all<{ a: string }>(`select "a" from "${rebuiltName}" order by "a"`);
		expect(rows.map((r) => r.a).sort()).toEqual(['X', 'x']);
	});
});
