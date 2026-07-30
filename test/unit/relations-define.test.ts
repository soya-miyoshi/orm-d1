/**
 * `defineRelations` — the shape it produces and the joins it resolves.
 *
 * The output shape is asserted deliberately: an adapter reads `db._.relations`
 * and walks `{ table, name, relations }` with `relation.targetTableName`,
 * `sourceColumns` and `targetColumns`. Those field names are the contract, so
 * they are pinned here rather than left to an integration test to discover.
 */
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable, text } from '../../src/index.js';
import type { One } from '../../src/relations/define.js';
import { defineRelations } from '../../src/relations/define.js';

const users = sqliteTable('users', {
	id: integer('id').primaryKey(),
	name: text('name'),
});

const articles = sqliteTable('articles', {
	id: integer('id').primaryKey(),
	authorId: integer('author_id'),
	editorId: integer('editor_id'),
});

const tags = sqliteTable('tags', { id: integer('id').primaryKey() });
const articleTags = sqliteTable('article_tags', {
	articleId: integer('article_id').notNull(),
	tagId: integer('tag_id').notNull(),
});

const names = (columns: readonly { name: string }[] | undefined) => columns?.map((c) => c.name);

describe('the output is the plain object Drizzle produces', () => {
	const config = defineRelations({ users, articles }, (r) => ({
		users: { articles: r.many.articles() },
		articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id }) },
	}));

	it('has one entry per table, keyed by TypeScript name', () => {
		expect(Object.keys(config).sort()).toEqual(['articles', 'users']);
		expect(config['users']!.name).toBe('users');
		expect(config['users']!.table).toBe(users);
	});

	it('includes a table that declared no relations at all', () => {
		const bare = defineRelations({ users, articles }, () => ({}));
		expect(bare['users']!.relations).toEqual({});
	});

	it('carries the field names adapters read off each relation', () => {
		const author = config['articles']!.relations['author']!;
		expect(author.targetTableName).toBe('users');
		expect(author.targetTable).toBe(users);
		expect(author.sourceTable).toBe(articles);
		expect(author.fieldName).toBe('author');
		expect(author.relationType).toBe('one');
		expect(names(author.sourceColumns)).toEqual(['author_id']);
		expect(names(author.targetColumns)).toEqual(['id']);
	});

	it('defaults a one() to optional and honours optional: false', () => {
		const relaxed = defineRelations({ users, articles }, (r) => ({
			articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id }) },
		}));
		const strict = defineRelations({ users, articles }, (r) => ({
			articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id, optional: false }) },
		}));
		expect((relaxed['articles']!.relations['author'] as One).optional).toBe(true);
		expect((strict['articles']!.relations['author'] as One).optional).toBe(false);
	});
});

describe('a relation with no from/to adopts the one pointing back', () => {
	it('takes the join from the single reverse relation, flipped', () => {
		const config = defineRelations({ users, articles }, (r) => ({
			users: { articles: r.many.articles() },
			articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id }) },
		}));

		const many = config['users']!.relations['articles']!;
		// Seen from `users`, the join runs id → author_id.
		expect(names(many.sourceColumns)).toEqual(['id']);
		expect(names(many.targetColumns)).toEqual(['author_id']);
		expect(many.isReversed).toBe(true);
	});

	it('refuses two candidates rather than picking whichever was declared first', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				users: { articles: r.many.articles() },
				articles: {
					author: r.one.users({ from: r.articles.authorId, to: r.users.id }),
					editor: r.one.users({ from: r.articles.editorId, to: r.users.id }),
				},
			}))
		).toThrow(/more than one relation back to "users"/);
	});

	it('pairs the right two up when both sides carry the same alias', () => {
		const config = defineRelations({ users, articles }, (r) => ({
			users: { edited: r.many.articles({ alias: 'edited' }) },
			articles: {
				author: r.one.users({ from: r.articles.authorId, to: r.users.id }),
				editor: r.one.users({ from: r.articles.editorId, to: r.users.id, alias: 'edited' }),
			},
		}));

		expect(names(config['users']!.relations['edited']!.targetColumns)).toEqual(['editor_id']);
	});

	it('is not marked reversed when this side declares its own where', () => {
		// Drizzle (relations.js:60): `isReversed = !where`. A `where` stated on
		// this side names *this* side's own target columns, not the source
		// being reversed onto — so it must be compiled the ordinary way
		// (against the target), not treated as needing the reversed,
		// against-the-parent handling `isReversed` triggers elsewhere.
		const config = defineRelations({ users, articles }, (r) => ({
			users: { articles: r.many.articles({ where: { authorId: { isNotNull: true } } }) },
			articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id }) },
		}));

		const many = config['users']!.relations['articles']!;
		expect(many.isReversed).toBe(false);
		expect(many.where).toEqual({ authorId: { isNotNull: true } });
	});

	it('says so when there is no relation pointing back', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				users: { articles: r.many.articles() },
			}))
		).toThrow(/no relation back to "users"/);
	});

	it('says so when the matching relation has no from/to either', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				users: { articles: r.many.articles() },
				articles: { author: r.one.users() },
			}))
		).toThrow(/does not state them either/);
	});
});

describe('refusing a declaration that cannot mean anything', () => {
	it('rejects "from" without "to"', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				articles: { author: r.one.users({ from: r.articles.authorId }) },
			}))
		).toThrow(/declare both "from" and "to", or neither/);
	});

	it('rejects mismatched column counts', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				articles: { author: r.one.users({ from: [r.articles.authorId, r.articles.editorId], to: r.users.id }) },
			}))
		).toThrow(/same number of columns/);
	});

	it('rejects a "from" column belonging to another table', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				articles: { author: r.one.users({ from: r.users.id, to: r.users.id }) },
			}))
		).toThrow(/every "from" column must belong to "articles"/);
	});

	it('rejects a relation whose name collides with a column', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				articles: { authorId: r.one.users({ from: r.articles.authorId, to: r.users.id }) },
			}))
		).toThrow(/collides with the column "authorId"/);
	});

	it('rejects an empty alias, which reads as "no alias" but is not', () => {
		expect(() =>
			defineRelations({ users, articles }, (r) => ({
				articles: { author: r.one.users({ from: r.articles.authorId, to: r.users.id, alias: '' }) },
			}))
		).toThrow(/cannot be an empty string/);
	});

	it('names the table that is not in the schema', () => {
		expect(() => defineRelations({ users }, () => ({ articles: {} }) as never))
			.toThrow(/"articles" is not a table in the schema/);
	});
});

describe('many-to-many, declared with .through()', () => {
	const config = defineRelations({ articles, tags, articleTags }, (r) => ({
		articles: {
			tags: r.many.tags({
				from: r.articles.id.through(r.articleTags.articleId),
				to: r.tags.id.through(r.articleTags.tagId),
			}),
		},
	}));

	it('records the junction table and the columns each side hops via', () => {
		const relation = config['articles']!.relations['tags']!;
		expect(relation.throughTable).toBe(articleTags);
		expect(names(relation.through!.source)).toEqual(['article_id']);
		expect(names(relation.through!.target)).toEqual(['tag_id']);
		expect(names(relation.sourceColumns)).toEqual(['id']);
		expect(names(relation.targetColumns)).toEqual(['id']);
	});

	it('flips both halves when the other side adopts it', () => {
		const both = defineRelations({ articles, tags, articleTags }, (r) => ({
			articles: {
				tags: r.many.tags({
					from: r.articles.id.through(r.articleTags.articleId),
					to: r.tags.id.through(r.articleTags.tagId),
				}),
			},
			tags: { articles: r.many.articles() },
		}));

		const reverse = both['tags']!.relations['articles']!;
		expect(names(reverse.through!.source)).toEqual(['tag_id']);
		expect(names(reverse.through!.target)).toEqual(['article_id']);
		expect(reverse.throughTable).toBe(articleTags);
	});

	it('rejects .through() on only some of the columns', () => {
		expect(() =>
			defineRelations({ articles, tags, articleTags }, (r) => ({
				articles: {
					tags: r.many.tags({ from: r.articles.id.through(r.articleTags.articleId), to: r.tags.id }),
				},
			}))
		).toThrow(/on every column of "from" and "to", or on none/);
	});
});
