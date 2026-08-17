/**
 * [F-4] `snapshotFromSchema` renders a `check()` constraint's value with a
 * bare `renderInline(extra.meta.value)` call — not through `checkDDL`, which
 * is what normally wires up `withDDLContext` and attaches the table/
 * constraint name to a thrown error. Snapshot generation runs *before* the
 * diff engine's own `checkDDL` call would, so a schema with a `check()` that
 * triggers the empty-array DDL refusal (an interpolated empty array in a
 * `not in`/`in` predicate — see `src/ddl.ts`) used to throw an anonymous
 * error the moment `orm-d1-kit generate` scanned the schema, long before the
 * diff step that would otherwise have named it.
 */
import { check, integer, sql, sqliteTable, text } from 'orm-d1';
import { describe, expect, it } from 'vitest';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

describe('snapshotting a schema with a failing check constraint', () => {
	it('names the table and constraint, not an anonymous error', () => {
		const roles: string[] = [];
		const users = sqliteTable('users', {
			id: integer('id').primaryKey(),
			role: text('role'),
		}, (c) => [
			check('users_role_check', sql`${c.role} not in ${roles}`),
		]);

		expect(() => snapshotFromSchema({ users })).toThrow(/empty array/);
		expect(() => snapshotFromSchema({ users })).toThrow(/table "users"/);
		expect(() => snapshotFromSchema({ users })).toThrow(/constraint "users_role_check"/);
	});
});
