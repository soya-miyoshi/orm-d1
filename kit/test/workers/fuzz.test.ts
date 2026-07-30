/**
 * Property tests for migrations.
 *
 * Random schema A, random schema B, migrate A → B against real D1, then assert
 * that introspecting the result equals B and that rows seeded into A survived
 * wherever they could. This is the test class that catches table-recreation
 * bugs — the ones that quietly drop a column's data — so it is worth its setup
 * cost.
 *
 * The generator is seeded, so a failure is reproducible from the seed printed
 * in the assertion.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyMigrations, introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots, orderByDependency, renderMigration } from '../../src/core/diff.js';
import { canonicalTable, createTableFromSnapshot, emptySnapshot, normalizeIndexColumn } from '../../src/core/snapshot.js';
import type { ColumnSnapshot, Snapshot, TableSnapshot } from '../../src/core/snapshot.js';

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sql: string) => (await DB.prepare(sql).all<T>()).results,
	batch: async (statements) => {
		const results = await DB.batch(statements.map((sql) => DB.prepare(sql)));
		results.forEach((result, i) => {
			if (!result.success) throw new Error(`Statement failed: ${statements[i]}`);
		});
	},
};

/** A tiny deterministic PRNG, so every failure is reproducible from its seed. */
const rng = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
};

const TYPES = ['integer', 'text', 'real'] as const;

const randomColumn = (next: () => number, name: string): ColumnSnapshot => {
	const type = TYPES[Math.floor(next() * TYPES.length)]!;
	const notNull = next() < 0.3;
	const hasDefault = notNull || next() < 0.3;

	// Generated and expression-default columns are generated here on purpose.
	// Hard-coding them away is what let two bugs through: a rebuild that named
	// a generated column in its `INSERT … SELECT` (which SQLite rejects), and
	// an expression default that could not compare equal to itself, because
	// CREATE TABLE requires the parentheses that `table_info` strips.
	const generated = !notNull && !hasDefault && next() < 0.2;
	const expressionDefault = hasDefault && type === 'integer' && next() < 0.4;

	return {
		name,
		type,
		primaryKey: false,
		notNull,
		autoincrement: false,
		unique: false,
		// A NOT NULL column always gets a default, so it can be backfilled.
		default: generated
			? undefined
			: hasDefault
			? (expressionDefault ? '(unixepoch())' : type === 'text' ? `'x'` : '0')
			: undefined,
		generated: generated
			? { as: `(${type === 'text' ? `upper('g')` : '1 + 1'})`, mode: next() < 0.5 ? 'stored' : 'virtual' }
			: undefined,
		references: undefined,
	};
};

const randomTable = (next: () => number, name: string): TableSnapshot => {
	const columns: Record<string, ColumnSnapshot> = {
		id: {
			name: 'id',
			type: 'integer',
			primaryKey: true,
			notNull: true,
			autoincrement: false,
			unique: false,
			default: undefined,
			generated: undefined,
			references: undefined,
		},
	};

	// From zero, so the indexed column is not guaranteed to survive a mutation:
	// `1 + …` meant `c0` always existed on both sides, and the drop-an-indexed-
	// column case the generator is meant to reach was unreachable.
	const count = Math.floor(next() * 5);
	for (let i = 0; i < count; i++) {
		const columnName = `c${i}`;
		columns[columnName] = randomColumn(next, columnName);
	}

	const indexes = columns['c0'] && next() < 0.5
		? {
			[`${name}_idx`]: {
				name: `${name}_idx`,
				columns: ['c0'],
				isUnique: false,
				where: undefined,
			},
		}
		: {};

	return {
		name,
		columns,
		indexes,
		foreignKeys: {},
		compositePrimaryKeys: {},
		uniqueConstraints: {},
		checkConstraints: {},
	};
};

/**
 * Wire up foreign keys between the generated tables.
 *
 * Left out originally, which is why no property test reached the rebuild-with-
 * dependents family at all. The parent is chosen at random rather than always
 * being `t0`: with the parent fixed as the first table, the emitted rebuild
 * order came out right by luck, and an ordering bug that only shows when the
 * child is declared first went unseen.
 */
const withForeignKeys = (tables: Record<string, TableSnapshot>, next: () => number): void => {
	const names = Object.keys(tables);
	if (names.length < 2) return;

	// The *last* table, and the same one on both sides of every pair. Declared
	// last means every child precedes its parent in the module, which is the
	// order the rebuild ordering used to get wrong. Keeping it stable also
	// avoids generating a foreign key retargeted at a freshly created empty
	// table: that fails on the seeded data, which is a property of the data
	// rather than a bug in the migration, and no schema differ can foresee it.
	const parentName = names[names.length - 1]!;

	for (const [name, table] of Object.entries(tables)) {
		if (name === parentName || next() < 0.25) continue;
		const fkName = `${name}_fk`;
		(tables[name] as { foreignKeys: Record<string, unknown> }).foreignKeys = {
			...table.foreignKeys,
			[fkName]: {
				name: fkName,
				columns: ['id'],
				tableTo: parentName,
				columnsTo: ['id'],
				onDelete: undefined,
				onUpdate: undefined,
			},
		};
	}
};

const randomSnapshot = (next: () => number, tableCount: number): Snapshot => {
	const tables: Record<string, TableSnapshot> = {};
	for (let i = 0; i < tableCount; i++) tables[`t${i}`] = randomTable(next, `t${i}`);
	withForeignKeys(tables, next);
	return { version: '1', dialect: 'sqlite', id: '', prevId: '', tables };
};

/**
 * The same normalisation the differ uses, plus indexes.
 *
 * This used to strip `unique`, `references` and the table-level constraints
 * with the note "only what introspection can faithfully recover" — which
 * hid the fact that the two snapshot builders disagreed about exactly those
 * fields, and so that `check` reported drift on a database that matched its
 * schema. `canonicalTable` is what makes them comparable for real; asserting
 * on anything less lets that class of bug back in.
 */
const comparable = (snapshot: Snapshot) =>
	Object.fromEntries(
		Object.entries(snapshot.tables).map(([name, t]) => [name, {
			...canonicalTable(t),
			indexes: Object.fromEntries(
				Object.entries(t.indexes).map(([i, index]) => [
					i,
					{ columns: index.columns.map(normalizeIndexColumn), isUnique: index.isUnique },
				]),
			),
		}]),
	);

const dropEverything = async (): Promise<void> => {
	const tables = await runner.all<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
			+ "and name not like '\\_cf\\_%' escape '\\'",
	);
	for (const t of tables) await DB.prepare(`drop table if exists "${t.name}"`).run();
};

/**
 * One row per table, so recreation has something to lose.
 *
 * Parents before children: every row uses `id = 1`, so inserting a child first
 * violates its foreign key. That is the harness's problem, not the migration's.
 */
const seed = async (snapshot: Snapshot): Promise<void> => {
	const order = orderByDependency(snapshot, Object.keys(snapshot.tables));
	for (const table of order.map((name) => snapshot.tables[name]!)) {
		// SQLite computes generated columns; naming one in an INSERT is an error.
		const columns = Object.values(table.columns).filter((c) => !c.generated);
		const values = columns.map((c) => (c.name === 'id' ? '1' : c.type === 'text' ? `'seed'` : '42'));
		await DB.prepare(
			`insert into "${table.name}" (${columns.map((c) => `"${c.name}"`).join(', ')}) `
				+ `values (${values.join(', ')})`,
		).run();
	}
};

describe('migrating random schema pairs', () => {
	const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

	it.each(SEEDS)('seed %i: A → B introspects back to B', async (seedValue) => {
		await dropEverything();
		const next = rng(seedValue);

		// The same table count on both sides, so the foreign-key topology is
		// stable and only its *removal* is exercised.
		const tableCount = 2 + Math.floor(next() * 2);
		const before = randomSnapshot(next, tableCount);
		const after = randomSnapshot(next, tableCount);

		const create = diffSnapshots(emptySnapshot(), before);
		expect(create.errors, `seed ${seedValue}`).toEqual([]);
		await applyMigrations(runner, [{ tag: `${seedValue}_a`, sql: renderMigration(create) }]);
		await seed(before);

		const change = diffSnapshots(before, after);

		// A refusal is a legitimate outcome now that the generator emits foreign
		// keys: a table with a dependent cannot be rebuilt on D1 at all.
		// `generate` throws on any error, so nothing here is applied — but the
		// refused table must not have contributed any of its rebuild to the
		// statement list, or a caller reading past the error would apply half of
		// something that cannot work.
		if (change.errors.length > 0) {
			const refused = change.errors
				.map((error) => /^"([^"]+)" has to be recreated/.exec(error)?.[1])
				.filter((name): name is string => name !== undefined);
			expect(refused.length, `seed ${seedValue}: ${change.errors.join('; ')}`).toBeGreaterThan(0);

			for (const name of refused) {
				const own = change.statements.filter((s) =>
					s.sql.includes(`"__new_${name}"`) || s.sql === `drop table "${name}"`
				);
				expect(own, `seed ${seedValue}, refused ${name}`).toEqual([]);
			}
			return;
		}

		await applyMigrations(runner, [{ tag: `${seedValue}_b`, sql: renderMigration(change) }]);
		expect(comparable(await introspect(runner)), `seed ${seedValue}`).toEqual(comparable(after));
	});

	it.each(SEEDS)('seed %i: rows survive whatever the migration does', async (seedValue) => {
		await dropEverything();
		const next = rng(seedValue * 31);

		const before = randomSnapshot(next, 2);
		const after = randomSnapshot(next, 2);

		await applyMigrations(runner, [{
			tag: `${seedValue}_a`,
			sql: renderMigration(diffSnapshots(emptySnapshot(), before)),
		}]);
		await seed(before);

		const change = diffSnapshots(before, after);
		if (change.errors.length > 0) return;
		await applyMigrations(runner, [{ tag: `${seedValue}_b`, sql: renderMigration(change) }]);

		for (const table of Object.values(after.tables)) {
			// Every table existed in `before` too (both snapshots use t0…tN), so
			// its seeded row must still be there.
			const rows = await runner.all<{ n: number }>(`select count(*) as n from "${table.name}"`);
			expect(rows[0]!.n, `seed ${seedValue}, table ${table.name}`).toBe(1);

			// Columns carried across keep their value; new ones take the default.
			// A generated column has no value to carry — SQLite recomputes it from
			// its expression, so it is excluded rather than asserted on.
			const carried = Object.values(before.tables[table.name]?.columns ?? {})
				.filter((c) => table.columns[c.name] && c.name !== 'id')
				.filter((c) => !c.generated && !table.columns[c.name]!.generated);

			if (carried.length === 0) continue;
			const row = (await runner.all<Record<string, unknown>>(
				`select ${carried.map((c) => `"${c.name}"`).join(', ')} from "${table.name}"`,
			))[0]!;

			for (const column of carried) {
				const expected = column.type === 'text' ? 'seed' : 42;
				const actual = row[column.name];
				// A text→number change coerces; only the untouched ones must match.
				if (column.type === table.columns[column.name]!.type) {
					expect(actual, `seed ${seedValue}, ${table.name}.${column.name}`).toBe(expected);
				}
			}
		}
	});
});

describe('the recreation procedure itself', () => {
	it('never emits select *', () => {
		const next = rng(7);
		const before = randomSnapshot(next, 2);
		const after = randomSnapshot(next, 2);
		const sql = renderMigration(diffSnapshots(before, after));
		expect(sql.toLowerCase()).not.toContain('select *');
	});

	it('creates every random table it describes', async () => {
		await dropEverything();
		const snapshot = randomSnapshot(rng(99), 3);

		for (const table of Object.values(snapshot.tables)) {
			await DB.prepare(createTableFromSnapshot(table)).run();
		}

		expect(Object.keys((await introspect(runner)).tables).sort()).toEqual(['t0', 't1', 't2']);
	});
});
