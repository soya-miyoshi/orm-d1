/**
 * What the kit picks up out of a schema module, and what it must not.
 *
 * `snapshotFromSchema` filters module exports on the `orm-d1:IsTable` symbol,
 * so a `defineRelations` export is skipped. That is worth a test rather than an
 * assumption: the result is a plain record whose every value carries a `table`
 * property, which is exactly the shape a looser "does it look like a table?"
 * check would mistake for something to snapshot — and a relations export
 * silently turning into a migration is not a failure anyone would enjoy
 * diagnosing.
 */
import { integer, sqliteTable, text } from 'orm-d1';
import { defineRelations } from 'orm-d1/relations';
import { describe, expect, it } from 'vitest';
import { snapshotFromSchema } from '../../src/core/snapshot.js';

const users = sqliteTable('users', {
	id: integer('id').primaryKey(),
	email: text('email').notNull(),
});

const posts = sqliteTable('posts', {
	id: integer('id').primaryKey(),
	authorId: integer('author_id').notNull(),
});

const relations = defineRelations({ users, posts }, (r) => ({
	users: { posts: r.many.posts() },
	posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
}));

describe('scanning a schema module', () => {
	it('snapshots the tables and ignores the defineRelations export', () => {
		const snapshot = snapshotFromSchema({ users, posts, relations });
		expect(Object.keys(snapshot.tables).sort()).toEqual(['posts', 'users']);
	});

	it('is unchanged by the presence of the relations export', () => {
		expect(snapshotFromSchema({ users, posts, relations }))
			.toEqual(snapshotFromSchema({ users, posts }));
	});

	it('does not mistake a relations entry for a table, despite its `table` key', () => {
		// Each value is `{ table, name, relations, columns }`. Handing the
		// entries in directly must still produce nothing.
		expect(snapshotFromSchema({ ...relations }).tables).toEqual({});
	});

	it('ignores the other things a schema module tends to export', () => {
		const snapshot = snapshotFromSchema({
			users,
			allTables: [users, posts],
			SOME_CONSTANT: 42,
			helper: () => null,
			nothing: null,
		});
		expect(Object.keys(snapshot.tables)).toEqual(['users']);
	});
});
