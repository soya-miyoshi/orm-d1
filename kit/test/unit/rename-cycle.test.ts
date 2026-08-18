/**
 * [reviewer issue 2] The in-place rename loop (`for (const [from, to] of
 * Object.entries(columnRenames))`) walks `--rename-column` pairs in map
 * order with no cycle detection. A swap (`x=y, y=x`) or a longer rotation
 * (`a=b, b=c, c=a`) cannot be expressed as a sequence of in-place
 * `alter table … rename column` statements: by the time the statement that
 * would close the cycle runs, the column it names has already been renamed
 * away by an earlier statement in the same batch. `diffSnapshots` now
 * detects a cyclic rename per table and routes it through the rebuild path
 * (`recreateTable`), which maps old to new columns directly instead of
 * relying on sequential renames.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

describe('a cyclic column rename forces a rebuild instead of naive sequential RENAME COLUMN', () => {
	it('a 2-cycle swap (x<->y) picks the rebuild path', () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: text('x'),
			y: text('y'),
		});
		// Same column set as `before`, same types — nothing else about the table
		// changes; the swap is expressed purely through `renamedColumns` below.
		const afterSwap = sqliteTable('t', {
			id: integer('id').primaryKey(),
			x: text('x'),
			y: text('y'),
		});

		const beforeSnapshot = snapshotFromSchema([before]);
		const afterSnapshot = snapshotFromSchema([afterSwap]);

		const { statements, errors } = diffSnapshots(beforeSnapshot, afterSnapshot, {
			renamedColumns: { 't.x': 'y', 't.y': 'x' },
		});

		expect(errors).toEqual([]);
		// Routed through the rebuild path: a scratch "__new_t" table is created,
		// not a naive pair of `rename column` statements on the live table.
		expect(statements.some((s) => /create table "__new_t"/.test(s.sql))).toBe(true);
		expect(statements.some((s) => s.sql === 'alter table "t" rename column "x" to "y"')).toBe(false);
		expect(statements.some((s) => s.sql === 'alter table "t" rename column "y" to "x"')).toBe(false);
	});

	it('a 3-way rotation (a->b, b->c, c->a) picks the rebuild path', () => {
		const before = sqliteTable('t', {
			id: integer('id').primaryKey(),
			a: text('a'),
			b: text('b'),
			c: text('c'),
		});
		const after = sqliteTable('t', {
			id: integer('id').primaryKey(),
			a: text('a'),
			b: text('b'),
			c: text('c'),
		});

		const { statements, errors } = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]), {
			renamedColumns: { 't.a': 'b', 't.b': 'c', 't.c': 'a' },
		});

		expect(errors).toEqual([]);
		expect(statements.some((s) => /create table "__new_t"/.test(s.sql))).toBe(true);
		expect(statements.every((s) => !/^alter table "t" rename column/.test(s.sql))).toBe(true);
	});

	it('a plain non-cyclic chain (x -> y, y untouched) is still done in place', () => {
		const before = sqliteTable('t', { id: integer('id').primaryKey(), x: text('x') });
		const after = sqliteTable('t', { id: integer('id').primaryKey(), y: text('y') });

		const { statements, errors } = diffSnapshots(snapshotFromSchema([before]), snapshotFromSchema([after]), {
			renamedColumns: { 't.x': 'y' },
		});

		expect(errors).toEqual([]);
		expect(statements.some((s) => /create table "__new_t"/.test(s.sql))).toBe(false);
		expect(statements).toEqual([
			{ sql: 'alter table "t" rename column "x" to "y"', destructive: false },
		]);
	});
});
