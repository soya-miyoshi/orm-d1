import { describe, expect, it } from 'vitest';
import { pickColumns } from '../../src/relations/projection.js';
import type { Column } from '../../src/index.js';
import { integer, sqliteTable, text } from '../../src/index.js';

const t = sqliteTable('t', { id: integer('id'), name: text('name') });
const cols = { id: t.id, name: t.name } as unknown as Record<string, Column<any>>;

describe('pickColumns', () => {
	it('selects every column when there is no `columns` key at all', () => {
		expect(pickColumns(cols, undefined)).toEqual(['id', 'name']);
	});

	it('selects zero columns for an empty `columns: {}`', () => {
		expect(pickColumns(cols, {})).toEqual([]);
	});

	it('selects zero columns when every value in `columns` is undefined', () => {
		expect(pickColumns(cols, { id: undefined, name: undefined })).toEqual([]);
	});

	it('selects just the explicit true`s', () => {
		expect(pickColumns(cols, { id: true })).toEqual(['id']);
	});

	it('selects everything but the explicit falses', () => {
		expect(pickColumns(cols, { id: false })).toEqual(['name']);
	});
});
