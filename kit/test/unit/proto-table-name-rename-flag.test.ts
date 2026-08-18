/**
 * [Finding 4] Any `--rename-table`/`--rename-column` flag used to make
 * `diffSnapshots` throw for a schema containing a prototype-named table, even
 * when the rename is for a completely unrelated table. `cli.ts`'s
 * `asRenames` built `renamedTables`/`renamedColumns` as plain `{}`, so
 * `diffSnapshots`'s own `options.renamedTables ?? Object.create(null)`
 * fallback never fired (a plain `{}` is truthy) and the prototype hazard
 * flowed straight through: `renamedTables['constructor']` resolved the
 * inherited `Object` function, which is truthy — `quote(Object)` then threw
 * because `Object` has no `.replaceAll`.
 *
 * Also covers `carryForwardCollations`'s `renamedTables` default (`diff.ts`),
 * the "one more `{}` map" the same finding calls out: for a prototype-named
 * table, `targetName` used to become `Object` -> `tables[targetName]` is
 * `undefined` -> the live collation is silently NOT carried forward.
 */
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable, text } from 'orm-d1';
import { asTargetFlags, parseArgs } from '../../src/cli.js';
import { carryForwardCollations, diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const prototypeNames = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('an unrelated --rename-table flag does not throw for a schema with a prototype-named table', () => {
	for (const name of prototypeNames) {
		it(`does not throw when the schema also has a table named "${name}"`, () => {
			const other = sqliteTable('other', { id: integer('id').primaryKey() });
			const other2 = sqliteTable('other2', { id: integer('id').primaryKey() });
			const ghost = sqliteTable(name, { id: integer('id').primaryKey() });

			const before = snapshotFromSchema([other, ghost]);
			const after = snapshotFromSchema([other2, ghost]);

			const { flags } = parseArgs(['generate', '--rename-table', 'other=other2']);
			const renames = asTargetFlags(flags).renames;
			expect(renames).toBeDefined();

			expect(() => diffSnapshots(before, after, renames)).not.toThrow();
		});
	}
});

describe('carryForwardCollations carries a live collation forward for a prototype-named table', () => {
	for (const name of prototypeNames) {
		it(`persists "${name}"'s live column collation into the new baseline`, () => {
			const t = sqliteTable(name, { id: integer('id').primaryKey(), email: text('email').notNull() });
			const schemaAfter = snapshotFromSchema([t]);
			const liveBefore: Snapshot = {
				...schemaAfter,
				origin: 'introspection',
				tables: {
					[name]: {
						...schemaAfter.tables[name]!,
						columns: {
							...schemaAfter.tables[name]!.columns,
							email: { ...schemaAfter.tables[name]!.columns['email']!, collate: 'nocase' },
						},
					},
				},
			};

			expect(() => carryForwardCollations(liveBefore, schemaAfter)).not.toThrow();
			const persisted = carryForwardCollations(liveBefore, schemaAfter);
			expect(persisted.tables[name]!.columns['email']!.collate).toBe('nocase');
		});
	}
});
