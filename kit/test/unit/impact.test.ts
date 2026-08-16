/**
 * The rebuild-cost closure.
 *
 * Pure over a snapshot, so it belongs in the Node suite. What it computes is
 * not obvious enough to trust from reading: the edges run backwards (a table
 * is expensive because of what points *at* it), self-references are real
 * edges, and a cycle has to terminate. Each of those gets a case.
 */
import { describe, expect, it } from 'vitest';
import { impactOf, impactRanking } from '../../src/core/impact.js';
import type { Snapshot, TableSnapshot } from '../../src/core/snapshot.js';

/** A snapshot table with only the fields the closure walks. */
const table = (
	name: string,
	references: Record<string, string> = {},
	columnReferences: Record<string, string> = {},
): TableSnapshot => ({
	name,
	columns: Object.fromEntries(
		Object.entries(columnReferences).map(([column, tableTo]) => [column, {
			name: column,
			type: 'text',
			notNull: false,
			primaryKey: false,
			references: { name: `${name}_${column}_fk`, columns: [column], tableTo, columnsTo: ['id'] },
		}]),
	),
	indexes: {},
	foreignKeys: Object.fromEntries(
		Object.entries(references).map(([fkName, tableTo]) => [fkName, {
			name: fkName,
			columns: ['x'],
			tableTo,
			columnsTo: ['id'],
		}]),
	),
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
}) as unknown as TableSnapshot;

const snapshotOf = (...tables: TableSnapshot[]): Snapshot =>
	({
		version: '3',
		dialect: 'sqlite',
		id: '',
		prevId: '',
		origin: 'schema',
		tables: Object.fromEntries(tables.map((t) => [t.name, t])),
	}) as unknown as Snapshot;

describe('impactOf', () => {
	it('is empty for a table nothing references', () => {
		const snapshot = snapshotOf(table('a'), table('b'));
		expect(impactOf(snapshot, 'a').closure).toEqual([]);
	});

	it('counts a direct child', () => {
		const snapshot = snapshotOf(table('parent'), table('child', { child_fk: 'parent' }));
		const result = impactOf(snapshot, 'parent');
		expect(result.closure).toEqual(['child']);
		expect(result.directReferences).toEqual(['child.child_fk']);
	});

	// The part that makes the number surprising: dropping the child's foreign
	// key is itself a rebuild of the child, which drags the grandchild in.
	it('follows the reference edges backwards, transitively', () => {
		const snapshot = snapshotOf(
			table('a'),
			table('b', { b_fk: 'a' }),
			table('c', { c_fk: 'b' }),
			table('d', { d_fk: 'c' }),
		);
		expect(impactOf(snapshot, 'a').closure).toEqual(['b', 'c', 'd']);
		expect(impactOf(snapshot, 'c').closure).toEqual(['d']);
		expect(impactOf(snapshot, 'd').closure).toEqual([]);
	});

	it('sees a column-level reference, not just a table-level one', () => {
		const snapshot = snapshotOf(table('parent'), table('child', {}, { parentId: 'parent' }));
		const result = impactOf(snapshot, 'parent');
		expect(result.closure).toEqual(['child']);
		expect(result.directReferences).toEqual(['child.parentId']);
	});

	// `booking_payment_events.refund_of_id` is this shape: the table is its own
	// child, which makes it "has children" for the rebuild rule, but it must
	// not be listed as dragging itself along.
	it('treats a self-reference as an edge without putting the table in its own closure', () => {
		const snapshot = snapshotOf(table('t', { self_fk: 't' }));
		const result = impactOf(snapshot, 't');
		expect(result.closure).toEqual([]);
		expect(result.directReferences).toEqual(['t.self_fk']);
	});

	it('terminates on a cycle', () => {
		const snapshot = snapshotOf(
			table('x', { x_fk: 'y' }),
			table('y', { y_fk: 'x' }),
		);
		expect(impactOf(snapshot, 'x').closure).toEqual(['y']);
		expect(impactOf(snapshot, 'y').closure).toEqual(['x']);
	});

	it('counts a table once however many paths reach it', () => {
		const snapshot = snapshotOf(
			table('root'),
			table('left', { l_fk: 'root' }),
			table('right', { r_fk: 'root' }),
			table('join', { j1: 'left', j2: 'right' }),
		);
		expect(impactOf(snapshot, 'root').closure).toEqual(['join', 'left', 'right']);
	});

	it('names the tables it knows when asked about one it does not', () => {
		const snapshot = snapshotOf(table('a'), table('b'));
		expect(() => impactOf(snapshot, 'nope')).toThrow(/no table named "nope"[\s\S]*a, b/);
	});
});

describe('impactRanking', () => {
	it('orders by closure size, most expensive first', () => {
		const snapshot = snapshotOf(
			table('cheap'),
			table('mid', {}),
			table('expensive'),
			table('c1', { f: 'expensive' }),
			table('c2', { f: 'expensive' }),
			table('c3', { f: 'mid' }),
		);
		const ranking = impactRanking(snapshot);
		expect(ranking[0]!.table).toBe('expensive');
		expect(ranking[0]!.closure).toEqual(['c1', 'c2']);
		expect(ranking.find((r) => r.table === 'mid')!.closure).toEqual(['c3']);
		expect(ranking.at(-1)!.closure).toEqual([]);
	});
});
