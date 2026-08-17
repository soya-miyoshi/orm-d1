/**
 * Batching, and the invariant a table rebuild depends on: `applyMigration`
 * (and `push`, tested against real D1 in `kit/test/workers/migrate.test.ts`)
 * must never split a rebuild group — `create table "__new_X"` … `alter table
 * "__new_X" rename to "X"` — across two `batch()` calls, since D1 only gives
 * atomicity *within* one batch. Splitting it can commit the `drop table "X"`
 * in one batch and fail the rename in the next, leaving the table gone.
 */
import { describe, expect, it } from 'vitest';
import { applyMigration, checkForeignTriggerConflicts, MAX_STATEMENTS_PER_BATCH } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { lookupCaseInsensitive, packIntoBatches, statementGroups, tablesRebuiltIn } from '../../src/core/sql.js';

const recordingRunner = (): { runner: SqlRunner; batches: string[][] } => {
	const batches: string[][] = [];
	return {
		batches,
		runner: {
			all: async () => [],
			batch: async (statements) => {
				batches.push([...statements]);
			},
		},
	};
};

/** A table rebuild, exactly as `recreateTable` in `diff.ts` emits it. */
const rebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table "__new_${table}" ("id" integer)`,
	`insert into "__new_${table}" ("id") select "id" from "${table}"`,
	`drop table "${table}"`,
	`alter table "__new_${table}" rename to "${table}"`,
];

describe('statementGroups', () => {
	it('gives every plain statement its own group', () => {
		const statements = ['create table "a" ("id" integer)', 'create table "b" ("id" integer)'];
		const groups = statementGroups(statements);
		expect(groups[0]).not.toBe(groups[1]);
	});

	it('groups a whole rebuild — including its leading defer_foreign_keys pragma — as one unit', () => {
		const statements = [
			'create table "before" ("id" integer)',
			...rebuildGroup('x'),
			'create index "x_idx" on "x" ("id")',
			'create table "after" ("id" integer)',
		];
		const groups = statementGroups(statements);

		// The unrelated statement before it is not folded in.
		expect(groups[0]).not.toBe(groups[1]);
		// The index create after the rename *is* part of the rebuild group:
		// `recreateTable` (`diff.ts`) emits it after the rename to restore the
		// constraints the drop just took with it, so a batch boundary landing
		// between the rename and it is exactly as unsafe as one landing before
		// the rename — see `[F-041]`. Only the statement after *that* is free.
		expect(groups[6]).toBe(groups[1]);
		expect(groups[7]).not.toBe(groups[1]);
		// PRAGMA through the trailing index create share one id.
		expect(new Set(groups.slice(1, 7)).size).toBe(1);
	});
});

describe('packIntoBatches', () => {
	it('never splits a rebuild group across two batches', () => {
		// Pad with plain statements so the rebuild group would straddle a
		// batch boundary under naive fixed-stride slicing.
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];

		const batches = packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH);

		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
		// And the group did land in exactly one batch, together.
		const groupBatch = batches.find((b) => b.includes('drop table "orders"'));
		expect(groupBatch).toBeDefined();
		expect(groupBatch).toEqual(expect.arrayContaining(rebuildGroup('orders')));
	});

	it('refuses outright, rather than splitting, when a single group exceeds the batch limit', () => {
		// The rebuild group is 5 statements; a limit of 3 cannot hold it, and
		// there is no safe way to split it, so this must throw rather than
		// emit a migration that can leave the table dropped and never renamed.
		expect(() => packIntoBatches(rebuildGroup('orders'), 3)).toThrow(/exceeds the per-batch limit/);
	});

	it('names the table whose rebuild is too large to fit in one batch', () => {
		// The refusal above proves the throw; this proves the message says
		// *which* table -- otherwise an operator staring at a schema with
		// dozens of tables has to bisect their own migration to find it.
		expect(() => packIntoBatches(rebuildGroup('orders'), 3)).toThrow(/"orders"/);
	});
});

describe('applyMigration batching', () => {
	it('never lets a batch drop "X" without also renaming "__new_X" to "X" in the same batch', async () => {
		const { runner, batches } = recordingRunner();
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];
		await applyMigration(runner, 'm_rebuild', `${statements.join(';\n')};`);

		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
	});

	it('does not split at all for a runner that says it needs no ceiling', async () => {
		// The local path and the remote import path both run any number of
		// statements as one unit. Splitting them under `/query`'s ceiling used
		// to give away atomicity for nothing.
		const { runner, batches } = recordingRunner();
		const unlimited: SqlRunner = { ...runner, atomicLimit: () => Infinity };
		const statements = Array.from(
			{ length: MAX_STATEMENTS_PER_BATCH * 3 },
			(_, i) => `create table "t${i}" ("id" integer)`,
		);

		const warnings = await applyMigration(unlimited, 'm_unlimited', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(statements.length + 1); // + the d1_migrations record
		expect(warnings).toEqual([]);
	});

	it('honours a ceiling the runner reports for these particular statements', async () => {
		const { runner, batches } = recordingRunner();
		const picky: SqlRunner = { ...runner, atomicLimit: (s) => (s.length > 5 ? Infinity : 2) };

		await applyMigration(picky, 'm_small_capped', 'create table "a" ("id" integer);\ncreate table "b" ("id" integer);');
		// 2 statements + the record = 3, over the ceiling of 2 → split.
		expect(batches.length).toBeGreaterThan(1);

		batches.length = 0;
		const many = Array.from({ length: 10 }, (_, i) => `create table "u${i}" ("id" integer)`);
		await applyMigration(picky, 'm_large_uncapped', `${many.join(';\n')};`);
		expect(batches).toHaveLength(1);
	});

	it('names the ceiling it actually used in the split warning', async () => {
		const { runner } = recordingRunner();
		const capped: SqlRunner = { ...runner, atomicLimit: () => 4 };
		const statements = Array.from({ length: 9 }, (_, i) => `create table "v${i}" ("id" integer)`);

		const warnings = await applyMigration(capped, 'm_capped', `${statements.join(';\n')};`);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('batches of up to 4');
	});

	it('appends the d1_migrations record to the final batch, not a separate one', async () => {
		const { runner, batches } = recordingRunner();
		const statements = Array.from({ length: MAX_STATEMENTS_PER_BATCH + 10 }, (_, i) => `create table "t${i}" ("id" integer)`);
		await applyMigration(runner, 'm_many', `${statements.join(';\n')};`);

		expect(batches.length).toBeGreaterThan(1);
		const last = batches[batches.length - 1]!;
		expect(last.some((s) => s.includes("insert into \"d1_migrations\" (name) values ('m_many')"))).toBe(true);
		// No batches after the one carrying the record.
		for (const batch of batches.slice(0, -1)) {
			expect(batch.some((s) => s.startsWith('insert into "d1_migrations"'))).toBe(false);
		}
	});

	it('shifts a statement out of an exactly-full last batch so the record does not become its own trailing batch (gap 2)', async () => {
		const { runner, batches } = recordingRunner();
		// Exactly MAX_STATEMENTS_PER_BATCH real statements: greedy packing fills
		// the (only) batch of real statements exactly, with no room left over.
		// [F-043]: the record must not become its own one-statement trailing
		// batch here — one real statement is shifted out of the full batch so
		// the record always rides along with a real statement.
		const statements = Array.from({ length: MAX_STATEMENTS_PER_BATCH }, (_, i) => `create table "t${i}" ("id" integer)`);
		await applyMigration(runner, 'm_exact', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(MAX_STATEMENTS_PER_BATCH - 1);
		expect(batches[1]).toHaveLength(2);
		expect(batches[1]).toContain(`insert into "d1_migrations" (name) values ('m_exact')`);
		expect(batches[1]!.some((s) => s !== `insert into "d1_migrations" (name) values ('m_exact')`)).toBe(true);
	});

	it('keeps a rebuild group whole when it is what makes the last batch fill exactly, and rides the record along with it (gap 2)', async () => {
		const { runner, batches } = recordingRunner();
		// 95 plain creates + a 5-statement rebuild group = exactly 100: the
		// group must not be split to make room for the record. [F-043]/[F-041]:
		// the whole group is shifted into a second batch together with the
		// record, rather than leaving the record alone in a trailing batch.
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 5 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...rebuildGroup('orders'),
		];
		await applyMigration(runner, 'm_rebuild_exact', `${statements.join(';\n')};`);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(MAX_STATEMENTS_PER_BATCH - 5);
		expect(batches[1]).toHaveLength(6);
		expect(batches[1]).toContain(`insert into "d1_migrations" (name) values ('m_rebuild_exact')`);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__new_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
		// The whole rebuild group landed in the second batch, with the record.
		expect(batches[1]).toContain('drop table "orders"');
		expect(batches[1]).toContain('alter table "__new_orders" rename to "orders"');
	});

	it('keeps the record in the single batch when the migration is small', async () => {
		const { runner, batches } = recordingRunner();
		await applyMigration(runner, 'm_small', 'create table "t" ("id" integer);');

		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual([
			'create table "t" ("id" integer)',
			`insert into "d1_migrations" (name) values ('m_small')`,
		]);
	});
});

/** A rebuild spelled with backticks throughout, instead of kit's own `"…"`. */
const backtickRebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table \`__new_${table}\` (\`id\` integer)`,
	`insert into \`__new_${table}\` (\`id\`) select \`id\` from \`${table}\``,
	`drop table \`${table}\``,
	`alter table \`__new_${table}\` rename to \`${table}\``,
];

/** A rebuild spelled with brackets throughout. */
const bracketRebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table [__new_${table}] ([id] integer)`,
	`insert into [__new_${table}] ([id]) select [id] from [${table}]`,
	`drop table [${table}]`,
	`alter table [__new_${table}] rename to [${table}]`,
];

const triggerRunner = (rows: { name: string; tbl_name: string; sql: string }[]): SqlRunner => ({
	all: async () => rows.map((r) => ({ type: 'trigger', ...r })) as never,
	batch: async () => {},
});

describe('finding 1 / finding 3: non-double-quoted rebuilds are recognized', () => {
	it('tablesRebuiltIn recognizes a backtick-quoted rebuild', () => {
		expect(tablesRebuiltIn(backtickRebuildGroup('orders'))).toEqual(['orders']);
	});

	it('tablesRebuiltIn recognizes a bracket-quoted rebuild', () => {
		expect(tablesRebuiltIn(bracketRebuildGroup('orders'))).toEqual(['orders']);
	});

	it('statementGroups treats a bracket-quoted rebuild as one atomic group, not five singletons', () => {
		const groups = statementGroups(bracketRebuildGroup('orders'));
		expect(new Set(groups).size).toBe(1);
	});

	it('statementGroups treats a backtick-quoted rebuild as one atomic group, not five singletons', () => {
		const groups = statementGroups(backtickRebuildGroup('orders'));
		expect(new Set(groups).size).toBe(1);
	});

	// [Finding 1]: `renamesInMigration`'s own `create table "__new_X"`
	// recognizer used to be double-quote-only, while the *rename* recognizer
	// right next to it already accepted all four spellings. A backtick- (or
	// bracket-, or bare-) spelled rebuild's own closing rename then went
	// unrecognized as "the rebuild's own close" and was misfiled as a genuine
	// live-table rename instead — which is worse than not checking at all:
	// the guard below would resolve "orders" through a bogus rename to
	// "__new_orders" and then find no trigger recorded under that name, so it
	// silently misses a real foreign trigger on "orders" rather than firing.
	it('still catches a foreign trigger on a table rebuilt with backtick-quoted SQL', async () => {
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const sql = `${backtickRebuildGroup('orders').join(';\n')};`;

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"orders_audit"/);
	});
});

describe('finding 4: within-file rename resolution is transitive and case-insensitive', () => {
	it('follows a bare-identifier two-hop rename chain within one migration file back to the live name', async () => {
		// orders -> tmp -> sales, all bare (no quotes at all), then a rebuild of
		// "sales" in the very same migration file. A single-hop lookup only
		// resolves "sales" back to "tmp", never reaching "orders" — the table's
		// actual live identity, and the one `foreignTriggers` is keyed by.
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const sql = [
			'alter table orders rename to tmp',
			'alter table tmp rename to sales',
			...rebuildGroup('sales'),
		].join(';\n') + ';';

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"orders_audit"/);
	});

	it('resolves a within-file rename whose recorded target case does not match the rebuild\'s spelling', async () => {
		// [Finding 4a]: `alter table orders rename to Sales;` records
		// `renames['Sales'] = 'orders'` — keyed exactly as the migration spelled
		// the target. The rebuild in the same file targets "sales" (lowercase),
		// so a case-sensitive `renames[table]` lookup with `table === 'sales'`
		// misses the entry entirely and never resolves back to "orders", the
		// table the live trigger actually sits on.
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const sql = [
			'alter table orders rename to Sales',
			...rebuildGroup('sales'),
		].join(';\n') + ';';

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"orders_audit"/);
	});
});

describe('finding 5: lookupCaseInsensitive', () => {
	it('folds only ASCII letters — the Kelvin sign does not fold to "k"', () => {
		// `.toLowerCase()` maps U+212A KELVIN SIGN to ordinary ASCII "k", which
		// would make an unrelated identifier spelled with it collide with one
		// spelled with a real "K" — SQLite's own identifier comparison is
		// ASCII-only and treats them as different names entirely.
		const map: Record<string, string[]> = { amountK: ['ascii-k'] };
		const kelvinSign = String.fromCharCode(0x212a);
		expect(lookupCaseInsensitive(map, `amount${kelvinSign}`)).toBeUndefined();
		// A genuine ASCII-only case difference still matches.
		expect(lookupCaseInsensitive(map, 'AMOUNTK')).toEqual(['ascii-k']);
	});

	it('unions every case-insensitively matching key\'s array, rather than only the first found', () => {
		const map: Record<string, string[]> = { Orders: ['a'], ORDERS: ['b'] };
		const result = lookupCaseInsensitive(map, 'orders');
		expect(result).toBeDefined();
		expect(new Set(result)).toEqual(new Set(['a', 'b']));
	});
});

describe('finding 8: the tail-extension matcher does not mis-capture a later "on" in the statement', () => {
	it('keeps a partial index whose `where` clause contains a `JOIN ... ON` in the rebuild group', () => {
		// `CREATE_ON_PATTERN`'s old capture-then-compare approach used a greedy
		// `[\s\S]*` before the capture group; `.exec()` backtracks to the LAST
		// "on <ident>" that still lets the rest of the pattern match, not the
		// first. A trailing `create index` whose `where` clause contains a
		// second "on" (here, a `JOIN ... ON` inside a subquery) then captures
		// that subquery's join identifier instead of the table this index is
		// actually on, `!== finalName` becomes true, and the loop breaks early
		// — splitting the index create out of the atomic rebuild group.
		const statements = [
			...rebuildGroup('orders'),
			'create index "orders_active_idx" on "orders" ("status") '
				+ 'where "region_id" in (select "a"."id" from "regions" "a" join "zones" "b" on "a"."zone_id" = "b"."id")',
		];
		const groups = statementGroups(statements);
		expect(new Set(groups).size).toBe(1);
	});

	it('keeps a trigger body containing ON CONFLICT in the rebuild group', () => {
		const statements = [
			...rebuildGroup('orders'),
			'create trigger "orders_audit" after insert on "orders" '
				+ 'begin insert into "audit_log" ("table_name") values (\'orders\') on conflict do nothing; end',
		];
		const groups = statementGroups(statements);
		expect(new Set(groups).size).toBe(1);
	});

	it('still stops at a statement that is not on the rebuilt table\'s final name', () => {
		const statements = [
			...rebuildGroup('orders'),
			'create index "other_idx" on "other" ("id")',
		];
		const groups = statementGroups(statements);
		expect(groups[groups.length - 1]).not.toBe(groups[0]);
	});
});

describe('finding 9: the cross-file rename fold is case-insensitive', () => {
	it('follows a rename chain across migration files whose case spelling changes at the seam', async () => {
		// m1: orders -> Sales. m2: sales -> sales_v2 (lowercase "sales" at the
		// seam, where m1's target was spelled "Sales"). m3 rebuilds sales_v2.
		// The old fold did `accumulated[from]` as a raw, case-sensitive object
		// lookup, so `accumulated['sales']` (m2's `from`) missed the entry
		// written as `accumulated['Sales']` (m1's fold), and the chain back to
		// "orders" — the table the live trigger actually sits on — was lost.
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const m1 = { tag: 'm1', sql: 'alter table orders rename to Sales;' };
		const m2 = { tag: 'm2', sql: 'alter table sales rename to sales_v2;' };
		const m3 = { tag: 'm3', sql: `${rebuildGroup('sales_v2').join(';\n')};` };

		await expect(checkForeignTriggerConflicts(runner, [m1, m2, m3]))
			.rejects.toThrow(/"orders_audit"/);
	});
});

/**
 * A rebuild whose `create table "__new_X"` and closing
 * `alter table … rename to "X"` disagree in case on the `__new_`/`__NEW_`
 * marker — SQLite identifiers are case-insensitive, so `"__new_orders"` and
 * `"__NEW_ORDERS"` name the same table, but the marker matching in `sql.ts`/
 * `apply.ts` used to compare with plain `===`/`.startsWith()`, missing this.
 */
const mixedCaseRebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table "__new_${table}" ("id" integer)`,
	`insert into "__new_${table}" ("id") select "id" from "${table}"`,
	`drop table "${table}"`,
	`alter table "__NEW_${table.toUpperCase()}" rename to "${table}"`,
];

describe('round 3, finding 1: __new_ matching is case-insensitive, like SQLite identifiers', () => {
	it('statementGroups treats a mixed-case __new_/__NEW_ rebuild as one atomic group, not five singletons', () => {
		// [BLOCKING]: with a case-sensitive comparison, the closing rename is
		// never recognized as closing the group. `statementGroups` then treats
		// the `drop table "orders"` and the rename as two unrelated singleton
		// statements, which `packIntoBatches` can freely split across two
		// batches — committing the drop in one batch and losing the rename (and
		// the table) if the next batch fails.
		const statements = mixedCaseRebuildGroup('orders');
		const groups = statementGroups(statements);
		expect(new Set(groups).size).toBe(1);
	});

	it('packIntoBatches never splits a mixed-case rebuild across two batches', () => {
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...mixedCaseRebuildGroup('orders'),
		];
		const batches = packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__NEW_ORDERS" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
	});

	it('tablesRebuiltIn recognizes a create table spelled "__NEW_" (uppercase marker)', () => {
		const statements = [
			'PRAGMA defer_foreign_keys = ON',
			'create table "__NEW_orders" ("id" integer)',
			'insert into "__NEW_orders" ("id") select "id" from "orders"',
			'drop table "orders"',
			'alter table "__NEW_orders" rename to "orders"',
		];
		expect(tablesRebuiltIn(statements)).toEqual(['orders']);
	});

	// Guard-bypass half: a mis-recognized close used to file itself as a
	// genuine live-table rename in `renamesInMigration`, which corrupted the
	// resolution chain `checkForeignTriggerConflicts` uses and could hide a
	// real foreign trigger on the rebuilt table from the refusal below.
	it('still refuses a mixed-case rebuild of a table carrying a foreign trigger', async () => {
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const sql = `${mixedCaseRebuildGroup('orders').join(';\n')};`;

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"orders_audit"/);
	});
});

/**
 * A rebuild whose `create table` statement itself uses the uppercase
 * `__NEW_` marker (not just the closing rename) — pins `sql.ts`'s create-side
 * `foldAsciiCase(createdName).startsWith('__new_')` check specifically.
 * `mixedCaseRebuildGroup` above only spells the *rename* half in uppercase,
 * so it exercises the rename-side comparison (sql.ts ~259-262) but leaves
 * the create-side check (sql.ts ~247) uncovered — a case-sensitive
 * `createdName.startsWith('__new_')` there would fail to recognize this
 * `create table` as a rebuild at all, and `statementGroups` would never even
 * look for a matching rename, splitting every statement into its own group.
 */
const upperCreateRebuildGroup = (table: string): string[] => [
	'PRAGMA defer_foreign_keys = ON',
	`create table "__NEW_${table}" ("id" integer)`,
	`insert into "__NEW_${table}" ("id") select "id" from "${table}"`,
	`drop table "${table}"`,
	`alter table "__NEW_${table}" rename to "${table}"`,
];

describe('round 3, finding 1b: __new_ matching on the CREATE side is case-insensitive too', () => {
	it('statementGroups treats a create-side-uppercase __NEW_ rebuild as one atomic group', () => {
		const statements = upperCreateRebuildGroup('orders');
		const groups = statementGroups(statements);
		expect(new Set(groups).size).toBe(1);
	});

	it('packIntoBatches never splits a create-side-uppercase rebuild across two batches', () => {
		const statements = [
			...Array.from({ length: MAX_STATEMENTS_PER_BATCH - 2 }, (_, i) => `create table "t${i}" ("id" integer)`),
			...upperCreateRebuildGroup('orders'),
		];
		const batches = packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH);
		for (const batch of batches) {
			const hasDrop = batch.some((s) => s === 'drop table "orders"');
			const hasRename = batch.some((s) => s === 'alter table "__NEW_orders" rename to "orders"');
			expect(hasDrop).toBe(hasRename);
		}
		const groupBatch = batches.find((b) => b.includes('drop table "orders"'));
		expect(groupBatch).toBeDefined();
		expect(groupBatch).toEqual(expect.arrayContaining(upperCreateRebuildGroup('orders')));
	});
});

describe('round 3, finding 2: lookupCaseInsensitive unions the exact key with case-insensitive matches', () => {
	it('includes the exact-key value in the union rather than short-circuiting on it', () => {
		// The exact-case key ("orders") is present *and* a differently-cased key
		// ("Orders") also matches case-insensitively. The old fast path returned
		// `map['orders']` alone the moment `Object.hasOwn` was true, skipping the
		// union loop below it entirely — exactly the case the union exists for.
		const map: Record<string, string[]> = { orders: ['a'], Orders: ['b'] };
		const result = lookupCaseInsensitive(map, 'orders');
		expect(new Set(result)).toEqual(new Set(['a', 'b']));
	});
});

describe('apply.ts:485 checkForeignTriggerConflicts looks up foreignTriggers case-insensitively', () => {
	it('catches a foreign trigger recorded under a differently-cased live table name', async () => {
		// The live table is "ORDERS" (as sqlite_master literally spells it via
		// `tbl_name`), but the migration's own rebuild marker resolves to
		// "orders" (lowercase) — a direct `foreignTriggers[liveName]` lookup at
		// apply.ts:485 would miss the "ORDERS"-keyed entry entirely.
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'ORDERS', sql: 'create trigger "orders_audit" after insert on "ORDERS" begin select 1; end' },
		]);
		const sql = `${rebuildGroup('orders').join(';\n')};`;

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"orders_audit"/);
	});
});

describe('apply.ts: the within-file rename walk terminates on a rename cycle', () => {
	it('terminates instead of looping forever when a migration renames tables in a cycle', async () => {
		// "a" -> "tmp" -> "b" -> "a": walking `renames` back from "b" (the table
		// being rebuilt) visits tmp, then a, then loops back to b. Without the
		// `visited.has(next)` guard at apply.ts ~483 this walk never terminates.
		// A short per-test timeout (rather than relying on vitest's default) is
		// the "hangs" assertion: this test fails by timing out if the guard is
		// removed, and resolves promptly when it is present.
		// `checkForeignTriggerConflicts` returns immediately, before ever
		// reaching the walk, when `foreignTriggers` (read from the live
		// database) is empty — so an unrelated foreign trigger, on a table this
		// migration never touches, is needed to reach the loop at all.
		const runner = triggerRunner([
			{ name: 'unrelated_audit', tbl_name: 'unrelated', sql: 'create trigger "unrelated_audit" after insert on "unrelated" begin select 1; end' },
		]);
		const sql = [
			'alter table a rename to tmp',
			'alter table b rename to a',
			'alter table tmp rename to b',
			...rebuildGroup('b'),
		].join(';\n') + ';';

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }])).resolves.toBeUndefined();
	}, 2000);
});

describe('apply.ts: the accumulated fold reuses an existing case-insensitive key rather than adding a second one', () => {
	it('does not leave a stale duplicate key that a later rebuild resolves through instead of the live one', async () => {
		// m1: orders -> Sales.                 accumulated: { Sales: 'orders' }
		// m2: sales -> Tmp (frees "sales").     accumulated: { Sales: 'orders', Tmp: 'orders' }
		// m3: widget -> sales (reuses the name freed by m2, now pointing at the
		//     table that is actually live as "widget"). The write side has to
		//     reuse the existing "Sales" key (case-insensitively equal to the
		//     "sales" this rename targets) rather than adding a second,
		//     differently-cased "sales" key — otherwise "Sales" -> 'orders'
		//     survives stale alongside a new "sales" -> 'widget', and which one
		//     a later lookup finds depends on the exact case spelled at the
		//     call site rather than which is current.
		// m4: rebuilds "Sales" (capital S, matching m1's own spelling) — must
		//     resolve through the live chain to "widget", the table the
		//     foreign trigger actually sits on, not the stale "orders" a
		//     duplicate key would return.
		const runner = triggerRunner([
			{ name: 'widget_audit', tbl_name: 'widget', sql: 'create trigger "widget_audit" after insert on "widget" begin select 1; end' },
		]);
		const migrations = [
			{ tag: 'm1', sql: 'alter table orders rename to Sales;' },
			{ tag: 'm2', sql: 'alter table sales rename to Tmp;' },
			{ tag: 'm3', sql: 'alter table widget rename to sales;' },
			{ tag: 'm4', sql: `${rebuildGroup('Sales').join(';\n')};` },
		];

		await expect(checkForeignTriggerConflicts(runner, migrations)).rejects.toThrow(/"widget_audit"/);
	});
});

describe('round 3, [F-078]: trigger/rename maps are prototype-safe', () => {
	it('records a foreign trigger on a live table literally named "constructor"', async () => {
		// A plain `{}` object literal has `Object.prototype.constructor` as an
		// inherited (non-own) property — a function, not `undefined` — so
		// `(foreignTriggers['constructor'] ??= []).push(...)` throws
		// `TypeError: … .push is not a function` instead of recording the
		// trigger. checkForeignTriggerConflicts must not throw that, and must
		// still catch the trigger.
		const runner = triggerRunner([
			{
				name: 'constructor_audit',
				tbl_name: 'constructor',
				sql: 'create trigger "constructor_audit" after insert on "constructor" begin select 1; end',
			},
		]);
		const sql = `${rebuildGroup('constructor').join(';\n')};`;

		await expect(checkForeignTriggerConflicts(runner, [{ tag: 'm1', sql }]))
			.rejects.toThrow(/"constructor_audit"/);
	});

	it('follows a rename chain through a table literally named "__proto__"', async () => {
		const runner = triggerRunner([
			{ name: 'orders_audit', tbl_name: 'orders', sql: 'create trigger "orders_audit" after insert on "orders" begin select 1; end' },
		]);
		const m1 = { tag: 'm1', sql: 'alter table orders rename to __proto__;' };
		const m2 = { tag: 'm2', sql: `${rebuildGroup('__proto__').join(';\n')};` };

		await expect(checkForeignTriggerConflicts(runner, [m1, m2]))
			.rejects.toThrow(/"orders_audit"/);
	});
});
