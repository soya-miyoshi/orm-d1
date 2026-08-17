/**
 * `getTableConfig` in Drizzle v1's shape.
 *
 * The reason this matters is at the bottom of the file: Pothos' drizzle plugin
 * resolves every model's primary key through a three-step fallback over exactly
 * these fields, and throws if all three miss. Before this shape existed, a
 * composite-key table missed all three.
 */
import * as dz from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import type { Column } from '../../src/index.js';
import { foreignKey, getTableConfig, integer, primaryKey, sqliteTable, text, unique } from '../../src/index.js';
import { postTags, posts, users } from '../schema.js';

const names = (columns: readonly Column<any>[]) => columns.map((c) => c.name);

describe('the v1 field set', () => {
	it('reports the table name and a schema of undefined', () => {
		const config = getTableConfig(users);
		expect(config.name).toBe('users');
		expect(config.schema).toBeUndefined();
	});

	it('lists every column', () => {
		expect(names(getTableConfig(posts).columns)).toEqual(['id', 'author_id', 'title', 'views']);
	});

	it('reports a composite primary key, which Drizzle’s own version leaves empty', () => {
		const [pk, ...rest] = getTableConfig(postTags).primaryKeys;
		expect(rest).toEqual([]);
		expect(names(pk!.columns)).toEqual(['post_id', 'tag']);
		// Real drizzle-orm's `PrimaryKey.name` is `undefined` for an unnamed PK
		// — only `.getName()` derives `${table}_${cols}_pk`. See `[F-052]`.
		expect(pk!.name).toBeUndefined();
		expect(pk!.isNameExplicit).toBe(false);
		expect(pk!.getName()).toBe('post_tags_post_id_tag_pk');
		expect(pk!.table).toBe(postTags);
	});

	it('reports a table-level unique() constraint', () => {
		const [uq] = getTableConfig(postTags).uniqueConstraints;
		expect(uq!.name).toBe('post_tags_tag_unique');
		// `postTags` names this constraint explicitly (`unique('post_tags_tag_unique')`).
		expect(uq!.isNameExplicit).toBe(true);
		expect(uq!.getName()).toBe('post_tags_tag_unique');
		expect(names(uq!.columns)).toEqual(['tag']);
	});

	it('leaves a column-level .unique() on the column, as Drizzle does', () => {
		const config = getTableConfig(users);
		expect(config.uniqueConstraints).toEqual([]);
		expect(config.columns.find((c) => c.name === 'email')!.isUnique).toBe(true);
	});

	it('reports indexes with their derived names and partial predicates', () => {
		// Nested under `.config`, plus `isNameExplicit`, matching
		// `drizzle-orm/sqlite-core`'s `Index` instance shape. See `[F-052]`.
		const indexes = getTableConfig(users).indexes;
		expect(indexes.map((i) => i.config.name)).toEqual(['users_name_idx', 'users_email_active_idx']);
		expect(indexes.find((i) => i.config.unique)!.config.where).toBeDefined();
	});

	it('derives an index name the same way the DDL does', () => {
		const t = sqliteTable('t', { a: integer('a') }, () => []);
		expect(getTableConfig(t).indexes).toEqual([]);
		const named = sqliteTable('u', { a: integer('a'), b: text('b') }, (c) => [unique().on(c.a, c.b)]);
		expect(getTableConfig(named).uniqueConstraints[0]!.name).toBe('u_a_b_unique');
	});

	it('reports checks', () => {
		const [check] = getTableConfig(users).checks;
		expect(check!.name).toBe('users_score_check');
		expect(check!.value).toBeDefined();
	});

	it('folds inline .references() into foreignKeys alongside table-level ones', () => {
		// `columns`/`foreignColumns`/`foreignTable` live behind `reference()`, a
		// function, matching `drizzle-orm/sqlite-core`'s `ForeignKey` instance
		// shape; `onUpdate`/`onDelete` stay top-level. See `[F-052]`.
		// `posts.authorId` is declared with `.references(() => users.id)`.
		const [inline] = getTableConfig(posts).foreignKeys;
		const inlineRef = inline!.reference();
		expect(names(inlineRef.columns)).toEqual(['author_id']);
		expect(names(inlineRef.foreignColumns)).toEqual(['id']);
		expect(inlineRef.foreignTable).toBe(users);
		expect(inline!.onDelete).toBe('cascade');
		// `${table}_${cols}_${foreignTable}_${foreignCols}_fk`, matching
		// Drizzle's `ForeignKey.getName()`. See `[F-015]`.
		expect(inline!.getName()).toBe('posts_author_id_users_id_fk');

		const [tableLevel] = getTableConfig(postTags).foreignKeys;
		const tableLevelRef = tableLevel!.reference();
		expect(names(tableLevelRef.columns)).toEqual(['post_id']);
		expect(tableLevelRef.foreignTable).toBe(posts);
		expect(tableLevel!.onDelete).toBe('cascade');
		// An unnamed table-level `foreignKey()` gets the same
		// `${table}_${cols}_${foreignTable}_${foreignCols}_fk` shape as the
		// inline case above, matching Drizzle's `ForeignKey.getName()` — not
		// `foreignKeyName()`'s DDL-facing `${table}_${cols}_fk` (`[F-015]`
		// follow-up; the DDL/snapshot side is asserted unchanged below).
		expect(tableLevel!.getName()).toBe('post_tags_post_id_posts_id_fk');
		expect(tableLevel!.isNameExplicit()).toBe(false);
	});

	it('an unnamed table-level foreignKey()\'s getName() matches real drizzle-orm, including multi-column', () => {
		const dzParent = dz.sqliteTable('parent', {
			a: dz.integer('a'),
			b: dz.integer('b'),
		}, (t) => [dz.primaryKey({ columns: [t.a, t.b] })]);
		const dzChild = dz.sqliteTable('child', {
			x: dz.integer('x'),
			y: dz.integer('y'),
		}, (t) => [dz.foreignKey({ columns: [t.x, t.y], foreignColumns: [dzParent.a, dzParent.b] })]);
		const [dzFk] = dz.getTableConfig(dzChild).foreignKeys;

		const parent = sqliteTable('parent', {
			a: integer('a'),
			b: integer('b'),
		}, (t) => [primaryKey({ columns: [t.a, t.b] })]);
		const child = sqliteTable('child', {
			x: integer('x'),
			y: integer('y'),
		}, (t) => [foreignKey({ columns: [t.x, t.y], foreignColumns: [parent.a, parent.b] })]);
		const [fk] = getTableConfig(child).foreignKeys;

		expect(fk!.getName()).toBe(dzFk!.getName());
		expect(fk!.getName()).toBe('child_x_y_parent_a_b_fk');
	});

	it('leaves DDL rendering unaffected by the getTableConfig() FK name change', () => {
		// `foreignKeyName()` (`src/schema/constraints.ts`), which
		// `createSchema`/the kit's snapshot both key foreign keys by, still
		// derives the shorter `${table}_${cols}_fk` — this pins that the DDL
		// text for `postTags` did not pick up the foreign side.
		const schema = createSchema([postTags]).join('\n');
		expect(schema).toContain('constraint "post_tags_post_id_fk"');
		expect(schema).not.toContain('post_tags_post_id_posts_id_fk');
	});
});

describe('Pothos’ getPrimaryKey fallback chain resolves for every fixture table', () => {
	/** Copied from `@pothos/plugin-drizzle`'s `utils/config.ts`, verbatim. */
	const getPrimaryKey = (table: Parameters<typeof getTableConfig>[0]): Column<any>[] => {
		const tableConfig = getTableConfig(table);
		const primaryKey = tableConfig.columns.find((column) => column.primary);
		if (primaryKey) return [primaryKey];
		const primaryKeys = tableConfig.primaryKeys.find((key) => key.columns.length > 0);
		if (primaryKeys) return [...primaryKeys.columns];
		const uniqueColumn = tableConfig.columns.find((column) => column.isUnique);
		if (uniqueColumn) return [uniqueColumn];
		throw new Error('Could not find primary key');
	};

	it('takes a column-level primary key first', () => {
		expect(names(getPrimaryKey(users))).toEqual(['id']);
		expect(names(getPrimaryKey(posts))).toEqual(['id']);
	});

	it('falls through to the composite key — the case that used to throw', () => {
		expect(names(getPrimaryKey(postTags))).toEqual(['post_id', 'tag']);
	});

	it('falls through again to a unique column when there is no primary key', () => {
		const sessions = sqliteTable('sessions', {
			token: text('token').notNull().unique(),
			userId: integer('user_id').notNull(),
		});
		expect(names(getPrimaryKey(sessions))).toEqual(['token']);
	});

	it('throws with a clear message when a table has no key of any kind', () => {
		const events = sqliteTable('events', { kind: text('kind'), at: integer('at') });
		expect(() => getPrimaryKey(events)).toThrow('Could not find primary key');
	});
});
