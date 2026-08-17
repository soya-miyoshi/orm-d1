/**
 * Casing is module-global and resolved lazily, which is what lets a schema
 * module be imported before the option is known. The cost is that the order of
 * "set the option" and "read a name" matters, and getting it wrong produces
 * SQL that is wrong rather than SQL that fails to build — so both bad orders
 * throw at the point of the mistake.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { toSnakeCase as drizzleToSnakeCase } from 'drizzle-orm/casing';
import { applyCasing, configureCasing, isColumn, resetCasing } from '../../src/schema/columns.js';
import { integer, sqliteTable, text } from '../../src/index.js';

afterEach(() => resetCasing());

describe('configureCasing', () => {
	it('applies to names that were not read before it was set', () => {
		configureCasing('snake_case');
		const t = sqliteTable('t', { firstName: text() });
		expect(t.firstName.name).toBe('first_name');
	});

	it('refuses to change an already-configured mode', () => {
		configureCasing('snake_case');
		expect(() => configureCasing('preserve')).toThrow(/already configured/);
	});

	it('refuses to take effect after a name has already been resolved', () => {
		// This is the documented module-scope compilation: a query built at
		// import time bakes `"firstName"` into its SQL, and a later
		// `orm-d1(env.DB, { casing: 'snake_case' })` would make every *other*
		// reader say `first_name`. The compiled query keeps the old text and D1
		// answers "no such column" — in production, for the optimised query.
		const t = sqliteTable('t', { firstName: text(), id: integer() });
		expect(t.firstName.name).toBe('firstName');

		expect(() => configureCasing('snake_case')).toThrow(/after column names had already been read/);
	});

	it('tolerates a late call that changes nothing', () => {
		const t = sqliteTable('t', { firstName: text() });
		expect(t.firstName.name).toBe('firstName');

		// Redundant, but not a mistake: the names it would produce are the ones
		// already handed out.
		expect(() => configureCasing('preserve')).not.toThrow();
	});

	// Asserted against `toSnakeCase` imported from the real `drizzle-orm`
	// package rather than a literal: a previous finding ([F-014]) records that
	// asserting against constants read off the implementation is what let two
	// snake_case disagreements ship unnoticed. Verified this import resolves
	// (drizzle-orm/casing, re-exported from the package root's dist layout).
	it('matches drizzle-orm\'s toSnakeCase exactly, including the cases the old regex pair disagreed on', () => {
		configureCasing('snake_case');
		// `explicitName` (the `text('column_name')` form) bypasses casing
		// entirely, so this exercises only the field-key path — the same path
		// `applyCasing`/`toSnakeCase` cover for arbitrary strings below.
		const t = sqliteTable('t', {
			apiV2: text(),
			formatV3: text(),
			utf8MB4: text(),
			_id: text(),
			__typename: text(),
			firstName: text(),
			userID: text(),
			HTTPServer: text(),
			emailVerified: text(),
			oauth2Token: text(),
			myURLPath: text(),
			ABCDef: text(),
			iOS: text(),
			fooBAR: text(),
		});

		for (const [key, column] of Object.entries(t)) {
			if (!isColumn(column)) continue;
			expect(column.name).toBe(drizzleToSnakeCase(key));
		}

		// The specific disagreements the fix closed, spelled out explicitly.
		expect(t.apiV2.name).toBe('api_v_2');
		expect(t.formatV3.name).toBe('format_v_3');
		expect(t.utf8MB4.name).toBe('utf8_mb_4');
		expect(t._id.name).toBe('id');
		expect(t.__typename.name).toBe('typename');
	});

	it('matches drizzle-orm\'s toSnakeCase for strings not reachable as a JS identifier field key', () => {
		configureCasing('snake_case');
		for (const input of ['user’sName', '__typename', 'some name', "user's Name"]) {
			expect(applyCasing(input)).toBe(drizzleToSnakeCase(input));
		}
		expect(applyCasing('user’sName')).toBe('users_name');
		expect(applyCasing('some name')).toBe('some_name');
	});
});
