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
 * The 36 child tables cycle through 12 distinct shapes (a function of `i %
 * 12`, since the per-table knobs below are `i % 2`, `i % 3`, `i % 4` and `i %
 * 6` — all divisors of 12), repeated 3 times over. Nearly every assertion
 * above is therefore not actually scale-sensitive: it would pass identically
 * at 12 tables as at 36. The one exception is the "declares a schema large
 * enough that a single batch would refuse to fit unbounded growth" check
 * below, which is deliberately sized against the *current* `TABLE_COUNT` and
 * would need `TABLE_COUNT` to shrink well below today's value before it
 * stopped being meaningful.
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
import { introspect, MAX_STATEMENTS_PER_BATCH } from '../../src/core/apply.js';
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
			// Case-insensitive collation, folded through the `collate nocase`
			// expression on the unique index below. There is no `.collate()`
			// API on the column builder itself — orm-d1 has no spelling for
			// declaring collation directly on a column — so this column
			// declares no collation of its own; only the index member does.
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
	// Seed a root row so tests that insert into a "synth_child_*" table via
	// "(select id from synth_root limit 1)" get a real, non-null root_id —
	// without this, the FK's NOT NULL fires before the constraint each test
	// actually means to probe (e.g. a CHECK) is ever reached, and the test
	// passes for the wrong reason.
	await DB.prepare('insert into "synth_root" ("id","slug") values (1, \'seed\')').run();
});

describe('large synthetic schema — fidelity against real SQLite', () => {
	it(`declares ${TABLE_COUNT + 1} tables covering every constraint kind`, () => {
		expect(SCHEMA_TABLES.length).toBe(TABLE_COUNT + 1);
	});

	// Scale-sensitive, unlike almost everything else in this file: the 36
	// child tables cycle through only 12 distinct shapes (every per-table knob
	// below is `i % 2`, `i % 3`, `i % 4` or `i % 6`, all divisors of 12), so
	// most assertions here would pass identically at 12 tables. This one would
	// not — the full `CREATE TABLE`/`CREATE INDEX`/`CREATE TRIGGER` statement
	// count for this schema exceeds `MAX_STATEMENTS_PER_BATCH` only because
	// there are enough tables, each contributing several statements
	// (table + partial index + collated unique index + FK is inline, so at
	// least 3 non-table statements per child). At a much smaller `TABLE_COUNT`
	// this would fail, which is exactly what makes it a check on scale rather
	// than on shape.
	it('the full schema exceeds a single migration batch (a scale-sensitive property)', () => {
		const statements = createSchema(SCHEMA_TABLES, {}, SCHEMA_OPTIONS);
		expect(statements.length).toBeGreaterThan(MAX_STATEMENTS_PER_BATCH);
	});

	it('every declared column-level unique survives as its own unique index (pragma index_list)', async () => {
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const indexes = await runner.all<{ name: string; unique: number; origin: string }>(
				`pragma index_list(${JSON.stringify(table)})`,
			);
			// `origin` is `'c'` for an explicit `CREATE INDEX` (the declared
			// `label_nocase_idx`), `'u'` for a column-level/table-level UNIQUE
			// constraint (the `.unique()` on "code"), or `'pk'` for the
			// implicit index SQLite creates for a PRIMARY KEY constraint.
			// Composite-PK tables get that implicit `'pk'`-origin unique index
			// too — counting it in would let this assertion pass even if
			// column-level `.unique()` DDL emission were entirely broken,
			// since two-thirds of the generated tables lack a composite PK and
			// would never exercise that implicit index anyway. Excluding
			// `'pk'` keeps the count to indexes SQLite reports as user-created.
			const userUnique = indexes.filter((idx) => idx.unique === 1 && idx.origin !== 'pk');
			// One for the column-level `.unique()` on "code", one for the
			// declared `label_nocase_idx`.
			expect(userUnique.length).toBeGreaterThanOrEqual(2);
			// Confirm the specific member column of each, not just the count —
			// two unrelated single-column unique indexes could satisfy the
			// count above even if neither one is actually on "code".
			const memberNames = new Set<string>();
			for (const idx of userUnique) {
				const info = await runner.all<{ name: string | null }>(
					`pragma index_info(${JSON.stringify(idx.name)})`,
				);
				for (const m of info) if (m.name) memberNames.add(m.name);
			}
			expect(memberNames.has('code')).toBe(true);
			expect(memberNames.has('label')).toBe(true);
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

	it('the partial index "where" predicate survives (pragma index_list partial flag)', async () => {
		// Reads SQLite's own parsed/normalized view (`pragma index_list`'s
		// `partial` flag) rather than grepping `sqlite_master.sql` — the
		// verbatim CREATE INDEX text this file's own docstring says a test
		// here should never assert against when a pragma can answer instead.
		for (let i = 0; i < TABLE_COUNT; i += 5) {
			const table = `synth_child_${i}`;
			const idxName = `${table}_rank_partial_idx`;
			const indexes = await runner.all<{ name: string; partial: number }>(
				`pragma index_list(${JSON.stringify(table)})`,
			);
			const idx = indexes.find((x) => x.name === idxName);
			expect(idx).toBeDefined();
			expect(idx!.partial).toBe(1);
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

	it('STRICT and WITHOUT ROWID land on the tables that declared them (behavioral probes)', async () => {
		// Asserted through SQLite's own enforcement, not by grepping
		// `sqlite_master.sql` for the "strict"/"without rowid" suffix text —
		// this file's own docstring says a test here should never do that when
		// a behavioral signal is available.
		for (let i = 0; i < TABLE_COUNT; i++) {
			const table = `synth_child_${i}`;
			const strict = i % 2 === 0;
			const withoutRowid = i % 3 === 0 && i % 6 === 0;

			// STRICT: SQLite rejects a value whose storage class doesn't match
			// the column's declared type — no affinity coercion. A non-numeric
			// TEXT value into the INTEGER "rank" column is rejected on a
			// STRICT table and silently stored as TEXT (via ordinary column
			// affinity) on a non-STRICT one.
			const insertBadType = DB.prepare(
				`insert into ${JSON.stringify(table)} `
					+ '("code","label","root_id","amount","rank","created_at","seq") '
					+ `values ('strict-probe-${i}','y', (select id from synth_root limit 1), 1, 'not-a-number', 0, ${i + 1000})`,
			).run();
			if (strict) {
				await expect(insertBadType).rejects.toThrow();
			} else {
				await expect(insertBadType).resolves.toBeDefined();
			}

			// WITHOUT ROWID: "rowid" (and its aliases) resolve at compile time,
			// not per-row, so a WITHOUT ROWID table rejects `select rowid` even
			// against an empty result set, while a rowid table accepts it.
			const selectRowid = DB.prepare(`select rowid from ${JSON.stringify(table)} limit 0`).run();
			if (withoutRowid) {
				await expect(selectRowid).rejects.toThrow();
			} else {
				await expect(selectRowid).resolves.toBeDefined();
			}
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

	it('the CHECK constraint on synth_child_0 survives, verified by SQLite enforcing it', async () => {
		// Verified by behaviour, not by grepping the DDL text: an insert that
		// violates "amount >= 0" must be rejected by SQLite itself, and
		// rejected specifically for that reason — not merely rejected (a NULL
		// FK from an unseeded "synth_root", for example, would also throw and
		// let this test pass without the CHECK ever having been reached).
		await expect(
			DB.prepare(
				'insert into "synth_child_0" '
					+ '("code","label","root_id","amount","rank","created_at","seq") '
					+ "values ('x','y', (select id from synth_root limit 1), -1, 1, 0, 1)",
			).run(),
		).rejects.toThrow(/CHECK/i);
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
