/**
 * Detecting a vocabulary that was widened in one table and not its siblings.
 *
 * The cases that matter are the ones it must stay quiet about. A warning that
 * fires on two unrelated `status` columns is worse than no warning at all,
 * because the next real one gets skipped with it.
 */
import { describe, expect, it } from 'vitest';
import { vocabularyDivergences, vocabularyWarnings } from '../../src/core/vocabulary.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const withCheck = (table: string, column: string, value: string, name = `${table}_${column}_enum`) => ({
	name: table,
	columns: { [column]: { name: column, type: 'text', notNull: true, primaryKey: false } },
	indexes: {},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: { [name]: { name, value } },
});

const snapshotOf = (...tables: ReturnType<typeof withCheck>[]): Snapshot =>
	({
		version: '3',
		dialect: 'sqlite',
		id: '',
		prevId: '',
		origin: 'schema',
		tables: Object.fromEntries(tables.map((t) => [t.name, t])),
	}) as unknown as Snapshot;

describe('vocabularyDivergences', () => {
	// The exact bug this exists for: a payment-method list widened in three
	// tables and left alone in the fourth.
	it('reports a set that is a proper subset of its sibling', () => {
		const found = vocabularyDivergences(snapshotOf(
			withCheck('transactions', 'method', `"method" in ('card', 'cash', 'paypay')`),
			withCheck('booking_payment_events', 'method', `"method" in ('card', 'cash', 'paypay', 'bank_transfer')`),
		));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			column: 'method',
			narrower: { table: 'transactions' },
			wider: { table: 'booking_payment_events' },
			missing: ['bank_transfer'],
		});
	});

	it('says which values the narrower table rejects', () => {
		const [warning] = vocabularyWarnings(snapshotOf(
			withCheck('a', 'method', `"method" in ('card')`),
			withCheck('b', 'method', `"method" in ('card', 'cash', 'paypay')`),
		));
		expect(warning).toContain(`"a"."method"`);
		expect(warning).toContain(`'cash', 'paypay'`);
	});

	it('stays quiet when the sets are equal', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `"method" in ('card', 'cash')`),
			// Same set, different order and spacing.
			withCheck('b', 'method', `"method" in ('cash','card')`),
		))).toEqual([]);
	});

	// Two `status` columns that mean different things. Overlapping-but-not-nested
	// and fully disjoint both have to be silent.
	it('stays quiet when the sets are disjoint', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('expenses', 'status', `"status" in ('submitted', 'approved', 'rejected')`),
			withCheck('event_events', 'status', `"status" in ('draft', 'published', 'completed')`),
		))).toEqual([]);
	});

	it('stays quiet when the sets merely overlap', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'kind', `"kind" in ('x', 'y')`),
			withCheck('b', 'kind', `"kind" in ('y', 'z')`),
		))).toEqual([]);
	});

	it('stays quiet for a column that appears in only one table', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `"method" in ('card')`),
			withCheck('b', 'other', `"other" in ('card', 'cash')`),
		))).toEqual([]);
	});

	it('matches the nullable form the generator emits', () => {
		const found = vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `"method" IS NULL OR "method" IN ('card')`),
			withCheck('b', 'method', `"method" in ('card', 'cash')`),
		));
		expect(found).toHaveLength(1);
		expect(found[0]!.missing).toEqual(['cash']);
	});

	it('tolerates the wrapping parentheses SQLite keeps', () => {
		const found = vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `("method" in ('card'))`),
			withCheck('b', 'method', `"method" in ('card', 'cash')`),
		));
		expect(found).toHaveLength(1);
	});

	it('handles a quote inside a value', () => {
		const found = vocabularyDivergences(snapshotOf(
			withCheck('a', 'label', `"label" in ('it''s')`),
			withCheck('b', 'label', `"label" in ('it''s', 'other')`),
		));
		expect(found[0]!.narrower.values).toEqual(["it's"]);
		expect(found[0]!.missing).toEqual(['other']);
	});

	// Anything that is not a plain value list is not a vocabulary. Reading one
	// out of a range check or a cross-column rule invents divergences.
	it('ignores checks that are not a plain value list', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'n', `"n" >= 0`),
			withCheck('b', 'n', `"n" in (1, 2, 3)`),
		))).toEqual([]);

		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `"method" in ('card') and "amount" > 0`),
			withCheck('b', 'method', `"method" in ('card', 'cash')`),
		))).toEqual([]);
	});

	it('ignores a null-guard naming a different column than the list', () => {
		expect(vocabularyDivergences(snapshotOf(
			withCheck('a', 'method', `"other" is null or "method" in ('card')`),
			withCheck('b', 'method', `"method" in ('card', 'cash')`),
		))).toEqual([]);
	});

	it('ignores a check on a column the table does not have', () => {
		const orphan = withCheck('a', 'method', `"ghost" in ('card')`);
		expect(vocabularyDivergences(snapshotOf(
			orphan,
			withCheck('b', 'ghost', `"ghost" in ('card', 'cash')`),
		))).toEqual([]);
	});

	it('reports every narrower sibling when there are three', () => {
		const found = vocabularyDivergences(snapshotOf(
			withCheck('a', 'm', `"m" in ('x')`),
			withCheck('b', 'm', `"m" in ('x')`),
			withCheck('c', 'm', `"m" in ('x', 'y')`),
		));
		// a<c and b<c, but a and b are equal so they are not reported against
		// each other.
		expect(found.map((d) => [d.narrower.table, d.wider.table])).toEqual([['a', 'c'], ['b', 'c']]);
	});
});
