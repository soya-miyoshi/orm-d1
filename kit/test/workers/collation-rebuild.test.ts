/**
 * [F-101]/[F-107] follow-up: `diff.ts`'s column-COLLATE carry-forward on a
 * table rebuild — `carryForwardCollation` at `kit/src/core/diff.ts:255`,
 * consulted from `recreateTable` (line ~470) so the rebuilt table's rendered
 * `CREATE TABLE` still states the live collation — is thoroughly covered at
 * the unit level (`kit/test/unit/diff.test.ts`, hand-built snapshots,
 * `diffSnapshots` output asserted as a string) but never *applied*. Nothing
 * in this suite drives a real rebuild through `diffSnapshots` against an
 * actual D1 database and then confirms SQLite itself still honours the
 * carried-forward collation afterwards — including `large-synthetic-schema
 * .test.ts`'s big harness, whose `beforeEach` always creates a fresh schema
 * from scratch and never diffs against a live table that needs rebuilding.
 * Comment out `carryForwardCollation`'s call site (or the line inside it)
 * and every existing test stays green; this file is what actually goes red.
 *
 * The schema DSL has no `.collate()` spelling (`docs/04`), so the "live"
 * collation here can only be produced by hand-writing the original table in
 * raw SQL — exactly the `pull`-adopted-database situation this carry-forward
 * exists for.
 */
import { env } from 'cloudflare:test';
import { integer, sqliteTable, text } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sqlText: string) => (await DB.prepare(sqlText).all<T>()).results as T[],
	batch: async (statements) => {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

const TABLE = 'collate_rebuild_t';

beforeEach(async () => {
	await DB.prepare(`drop table if exists "${TABLE}"`).run();
	// Written by hand, not through orm-d1's DDL — the schema DSL has no way to
	// state `collate nocase` on a column, so this is the only way to get a
	// live table with one.
	await DB.prepare(
		`create table "${TABLE}" ("id" integer primary key, "label" text collate nocase not null)`,
	).run();
	await DB.prepare(`insert into "${TABLE}" ("id", "label") values (1, 'Abc')`).run();
});

it(
	'a rebuild forced by an unrelated change (id integer -> text) still carries the live '
		+ 'NOCASE collation into the rebuilt table, verified by SQLite\'s own comparison',
	async () => {
		const before = await introspect(runner);
		expect(before.tables[TABLE]?.columns['label']?.collate?.toLowerCase()).toBe('nocase');

		// Forces a rebuild: SQLite cannot ALTER a column's declared type in
		// place. `label` is declared with no collation — the schema DSL simply
		// cannot state one — so rendering `after` as-is would silently drop
		// the live NOCASE collation the moment nothing else changed it.
		const afterTable = sqliteTable(TABLE, {
			id: text('id').primaryKey(),
			label: text('label').notNull(),
		});
		const after = snapshotFromSchema([afterTable]);

		const { statements, errors } = diffSnapshots(before, after);
		expect(errors).toEqual([]);

		const rebuild = statements.find((s) => s.sql.includes(`create table "__new_${TABLE}"`));
		expect(rebuild).toBeDefined();
		// The rendered rebuild statement itself must state the carried-forward
		// collation — the same assertion `diff.test.ts`'s unit-level sibling
		// makes, kept here as a sanity check before the behavioral one below.
		expect(rebuild!.sql).toContain('"label" text collate nocase not null');

		await DB.batch(statements.map((s) => DB.prepare(s.sql)));

		// Behavioral proof, not text inspection: a comparison with no explicit
		// `collate` in the query only matches case-insensitively if the
		// rebuilt column's *declared* collation is still NOCASE. If
		// `carryForwardCollation` were skipped, `label` would rebuild as plain
		// BINARY-collated TEXT and this query would return zero rows.
		const rows = await runner.all<{ id: string; label: string }>(
			`select "id", "label" from "${TABLE}" where "label" = 'ABC'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.label).toBe('Abc');

		// And the rebuilt table still reports NOCASE back through
		// introspection, closing the loop `[F-107]` describes for `generate`'s
		// persisted baseline.
		const after2 = await introspect(runner);
		expect(after2.tables[TABLE]?.columns['label']?.collate?.toLowerCase()).toBe('nocase');
	},
);
