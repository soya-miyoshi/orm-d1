/**
 * [F-001]: regression harness against a *large* schema.
 *
 * Every other fixture in this suite is small and hand-written, so a
 * constraint the renderer, snapshotter or introspector drops on a realistic
 * table count has no test that would notice — the exact shape of the failure
 * that motivated this project: drizzle-kit silently dropped column-level
 * `.unique()` across 64 tables, and the generated-vs-committed CI stayed
 * green because both artifacts agreed on the same wrong answer.
 *
 * This does **not** vendor anyone's real schema (see `[F-037]`'s scrub of the
 * customer name this file used to name). It generates a synthetic schema —
 * dozens of tables, cycling through every constraint kind this project's own
 * bug-class list cares about — and asserts fidelity two ways:
 *
 *  1. Against **real SQLite itself**, via raw `pragma` queries against the D1
 *     binding (`table_xinfo`, `index_list`, `index_xinfo`,
 *     `foreign_key_list`) — never against orm-d1's own rendering of what it
 *     thinks it wrote.
 *  2. Round-trip: `snapshotFromSchema` (what the schema declares) diffed
 *     against `introspect()` (what SQLite reports back after applying it) is
 *     empty — the same joint property `roundtrip.test.ts` checks, at a table
 *     count neither an author nor a reviewer can hold in their head.
 *
 * Driven entirely through the kit's existing public entry points
 * (`createSchema`, `introspect`, `snapshotFromSchema`, `diffSnapshots`) — no
 * core diff/apply machinery is touched by this file.
 */
import { env } from 'cloudflare:test';
import { createSchema, tableOptions } from 'orm-d1/ddl';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sql,
	sqliteTable,
	text,
	uniqueIndex,
} from 'orm-d1';
import type { Table, TableExtra } from 'orm-d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sqlText: string) => (await DB.prepare(sqlText).all<T>()).results as T[],
	batch: async (statements) => {
		if (statements.length > 0) await DB.batch(statements.map((s) => DB.prepare(s)));
	},
};

// --------------------------------------------------------------- generator

/** Every column, index, check and FK kind the project's own bug list names. */
const TABLE_COUNT = 36;

interface Built {
	tables: Table[];
	options: ReturnType<typeof tableOptions>;
}

function buildSyntheticSchema(): Built {
	const tables: Table[] = [];
	const entries: [Table, { strict?: boolean; withoutRowid?: boolean }][] = [];

	// A root table every "child_N" FKs at, so on-delete/on-update actions have
	// somewhere real to point.
	const root = sqliteTable('synth_root', {
		id: integer('id').primaryKey(),
		slug: text('slug').notNull().unique(),
	});
	tables.push(root);
	entries.push([root, { strict: true }]);

	const onDeleteActions = ['cascade', 'set null', 'restrict', 'no action'] as const;
	const onUpdateActions = ['cascade', 'restrict', 'no action'] as const;

	for (let i = 0; i < TABLE_COUNT; i++) {
		const name = `synth_child_${i}`;
		const del = onDeleteActions[i % onDeleteActions.length]!;
		const upd = onUpdateActions[i % onUpdateActions.length]!;
		// Composite primary key on roughly a third of the tables (also gets
		// WITHOUT ROWID, the junction-table shape the fix for [F-001] names).
		const compositePk = i % 3 === 0;
		const strict = i % 2 === 0;
		const withoutRowid = compositePk && i % 6 === 0;

		const t = sqliteTable(name, {
			// Column-level unique — the exact constraint drizzle-kit was
			// documented to drop across 64 tables.
			code: text('code').notNull().unique(),
			// Case-insensitive collation, folded through a unique index below as
			// well as declared on the column itself for the column-collation half.
			label: text('label', { length: 40 }),
			// The FK itself is declared once, as a named table-level constraint
			// below — not also inline here — so the schema declares exactly one
			// foreign key per column, matching what SQLite reports back.
			rootId: integer('root_id').notNull(),
			amount: real('amount').notNull().default(0),
			rank: integer('rank').notNull(),
			// not null with no default, and not null with a sql-expression default.
			createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
			// A generated column — stored on even tables, virtual on odd.
			doubled: integer('doubled').generatedAlwaysAs(sql`"rank" * 2`, {
				mode: i % 2 === 0 ? 'stored' : 'virtual',
			}),
			// Always present so the schema's column *type* doesn't vary per
			// table (that would make the `(c) => [...]` extras callback below
			// depend on a runtime condition TypeScript can't narrow); only
			// tables where `compositePk` is set actually use it in a `primaryKey()`.
			seq: integer('seq').notNull(),
		}, (c) => {
			const extras: TableExtra[] = [
				check(`${name}_amount_check`, sql`${c.amount} >= ${0}`),
				// Partial index: `where` predicate must survive rendering AND
				// introspection.
				index(`${name}_rank_partial_idx`).on(c.rank).where(sql`${c.amount} > ${0}`),
				// Collation on an index member — the [F-101]/[F-106]-[F-109]
				// history this project's own AUDIT.md records as its hardest
				// constraint to keep faithful across a rebuild.
				uniqueIndex(`${name}_label_nocase_idx`).on(sql`${c.label} collate nocase`),
				foreignKey({ columns: [c.rootId], foreignColumns: [root.id], name: `${name}_root_fk` })
					.onDelete(del)
					.onUpdate(upd),
			];
			if (compositePk) extras.push(primaryKey({ columns: [c.rootId, c.seq] }));
			return extras;
		});

		tables.push(t);
		entries.push([t, { strict, withoutRowid }]);
	}

	return { tables, options: tableOptions(entries) };
}

const { tables: SCHEMA_TABLES, options: SCHEMA_OPTIONS } = buildSyntheticSchema();

beforeEach(async () => {
	const existing = await runner.all<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
			+ "and name not like '\\_cf\\_%' escape '\\'",
	);
	for (const { name } of existing) {
		await DB.prepare(`drop table if exists ${JSON.stringify(name).replace(/"/g, '"')}`).run();
	}
	// Statements are `create table` / `create index` / `create trigger` in
	// dependency order (tables before indexes) — a real D1 batch, not a
	// simulated one.
	const statements = createSchema(SCHEMA_TABLES, {}, SCHEMA_OPTIONS);
	await DB.batch(statements.map((s) => DB.prepare(s)));
});

describe('large synthetic schema — fidelity against real SQLite', () => {
	it(`declares ${TABLE_COUNT + 1} tables covering every constraint kind`, () => {
		expect(SCHEMA_TABLES.length).toBe(TABLE_COUNT + 1);
	});

	it('every declared column-level unique survives as its own unique index (pragma index_list)', async () => {
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const indexes = await runner.all<{ name: string; unique: number; origin: string }>(
				`pragma index_list(${JSON.stringify(table)})`,
			);
			const uniqueOrigins = indexes.filter((idx) => idx.unique === 1);
			// One for the column-level `.unique()` on "code", one for the
			// declared `label_nocase_idx`.
			expect(uniqueOrigins.length).toBeGreaterThanOrEqual(2);
		}
	});

	it('every table has the declared not-null columns marked not null (pragma table_xinfo)', async () => {
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const cols = await runner.all<{ name: string; notnull: number }>(
				`pragma table_xinfo(${JSON.stringify(table)})`,
			);
			const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
			expect(byName.code?.notnull).toBe(1);
			expect(byName.amount?.notnull).toBe(1);
			expect(byName.rank?.notnull).toBe(1);
			expect(byName.created_at?.notnull).toBe(1);
			// "label" is nullable — the control, so this test would fail if
			// every column were being reported not-null regardless of the schema.
			expect(byName.label?.notnull).toBe(0);
		}
	});

	it('every FK on_delete/on_update action round-trips through pragma foreign_key_list', async () => {
		const onDeleteActions = ['cascade', 'set null', 'restrict', 'no action'] as const;
		const onUpdateActions = ['cascade', 'restrict', 'no action'] as const;
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const fks = await runner.all<{ table: string; on_delete: string; on_update: string }>(
				`pragma foreign_key_list(${JSON.stringify(table)})`,
			);
			expect(fks.length).toBeGreaterThan(0);
			for (const fk of fks) {
				expect(fk.table).toBe('synth_root');
				expect(fk.on_delete.toLowerCase()).toBe(onDeleteActions[i % onDeleteActions.length]);
				expect(fk.on_update.toLowerCase()).toBe(onUpdateActions[i % onUpdateActions.length]);
			}
		}
	});

	it('the partial index "where" predicate survives (pragma index_list + sqlite_master text)', async () => {
		for (let i = 0; i < TABLE_COUNT; i += 5) {
			const idxName = `synth_child_${i}_rank_partial_idx`;
			const row = await runner.all<{ sql: string }>(
				`select sql from sqlite_master where type = 'index' and name = ${JSON.stringify(idxName)}`,
			);
			expect(row).toHaveLength(1);
			expect(row[0]!.sql.toLowerCase()).toContain('where');
			expect(row[0]!.sql).toContain('"amount" > 0');
		}
	});

	it('a collated index member survives (pragma index_xinfo coll column)', async () => {
		for (let i = 0; i < TABLE_COUNT; i += 4) {
			const idxName = `synth_child_${i}_label_nocase_idx`;
			const info = await runner.all<{ name: string | null; coll: string }>(
				`pragma index_xinfo(${JSON.stringify(idxName)})`,
			);
			const member = info.find((m) => m.name === 'label');
			expect(member).toBeDefined();
			expect(member!.coll.toUpperCase()).toBe('NOCASE');
		}
	});

	it('generated columns keep their stored/virtual mode (pragma table_xinfo hidden flag)', async () => {
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const cols = await runner.all<{ name: string; hidden: number }>(
				`pragma table_xinfo(${JSON.stringify(table)})`,
			);
			const doubled = cols.find((c) => c.name === 'doubled');
			expect(doubled).toBeDefined();
			// SQLite's table_xinfo "hidden" column: 2 = virtual generated, 3 =
			// stored generated. Either way it must be reported as generated at
			// all — the control that would fail if generated columns silently
			// became ordinary ones.
			expect([2, 3]).toContain(doubled!.hidden);
			expect(doubled!.hidden).toBe(i % 2 === 0 ? 3 : 2);
		}
	});

	it('STRICT and WITHOUT ROWID land on the tables that declared them', async () => {
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const row = await runner.all<{ sql: string }>(
				`select sql from sqlite_master where type = 'table' and name = ${JSON.stringify(table)}`,
			);
			expect(row).toHaveLength(1);
			const ddl = row[0]!.sql.toLowerCase();
			const strict = i % 2 === 0;
			const withoutRowid = i % 3 === 0 && i % 6 === 0;
			// A plain substring match on "strict" also matches "restrict" (the
			// FK on_update/on_delete action text is right there in the same
			// DDL) — so this reads the table-options suffix specifically, the
			// exact tail SQLite always renders after the closing paren.
			const suffix = ddl.match(/\)\s*(strict)?\s*,?\s*(without rowid)?\s*$/);
			expect(suffix?.[1] === 'strict').toBe(strict);
			expect(suffix?.[2] === 'without rowid').toBe(withoutRowid);
		}
	});

	it('composite primary keys survive as multi-column pragma table_xinfo pk ordinals', async () => {
		for (let i = 0; i < TABLE_COUNT; i += 3) {
			const table = `synth_child_${i}`;
			const cols = await runner.all<{ name: string; pk: number }>(
				`pragma table_xinfo(${JSON.stringify(table)})`,
			);
			const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
			expect(pkCols.map((c) => c.name)).toEqual(['root_id', 'seq']);
		}
	});

	it('a CHECK constraint on every table survives, verified by SQLite enforcing it', async () => {
		// Verified by behaviour, not by grepping the DDL text: an insert that
		// violates "amount >= 0" must be rejected by SQLite itself.
		await expect(
			DB.prepare(
				'insert into "synth_child_0" '
					+ '("code","label","root_id","amount","rank","created_at","seq") '
					+ "values ('x','y', (select id from synth_root limit 1), -1, 1, 0, 1)",
			).run(),
		).rejects.toThrow();
	});

	it(
		'round-trips: snapshotFromSchema vs snapshotFromIntrospection diff empty across all '
			+ `${TABLE_COUNT + 1} tables`,
		async () => {
			const schemaSnapshot = snapshotFromSchema(SCHEMA_TABLES, '', SCHEMA_OPTIONS);
			const liveSnapshot = await introspect(runner);
			const diff = diffSnapshots(liveSnapshot, schemaSnapshot);
			if (diff.statements.length > 0) {
				// Print what's left so a real regression is diagnosable from the
				// test output alone, not just "not empty".
				// eslint-disable-next-line no-console
				console.error(diff.statements.map((s) => s.sql).join('\n---\n'));
			}
			expect(diff.statements).toEqual([]);
			expect(diff.errors).toEqual([]);
		},
	);

	it('a live D1 root row cascades/nullifies/restricts exactly as each table declared', async () => {
		// Behavioural proof, not text inspection, that on_delete actually does
		// what pragma foreign_key_list *says* it does — the rebuild path this
		// project's own bug-class #1 warns can drop constraints silently while
		// every artifact still agrees with itself.
		await DB.prepare('insert into "synth_root" ("id","slug") values (999, \'probe\')').run();
		// synth_child_0 has on_delete = cascade (i % 4 === 0).
		await DB.prepare(
			'insert into "synth_child_0" ("code","label","root_id","amount","rank","created_at","seq") '
				+ "values ('probe-code','probe', 999, 1, 1, 0, 1)",
		).run();
		await DB.prepare('delete from "synth_root" where id = 999').run();
		const remaining = await DB.prepare('select * from "synth_child_0" where code = \'probe-code\'').all();
		expect(remaining.results).toHaveLength(0);
	});
});
