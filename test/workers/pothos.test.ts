/**
 * The acceptance test: `@pothos/plugin-drizzle` driving an orm-d1 database
 * inside workerd, against a real D1 binding.
 *
 * This is the definition of done for adopting the v1 interface, and it is the
 * test whose absence let the gap survive — `drizzle-graphql` sat in this repo's
 * devDependencies the whole time with no test importing it, which reads as
 * evidence of something that was never actually checked. Everything the plugin
 * touches is exercised here through GraphQL execution rather than asserted
 * about in isolation:
 *
 * - `relations` — the plain `defineRelations` output, read as `AnyRelations`
 * - `getTableConfig` — ours, supplying the `primaryKeys` Drizzle's cannot
 * - `client.query.<table>.findMany` — RQBv2's config, including `columns`,
 *   `with`, `extras` and a `where: { RAW }` built from Drizzle's own `inArray`
 *   over our columns, which is what the Phase 1 SQL bridge exists for
 */
import SchemaBuilder from '@pothos/core';
import DrizzlePlugin from '@pothos/plugin-drizzle';
import { env } from 'cloudflare:test';
import { Many as DrizzleMany } from 'drizzle-orm';
import { getTableConfig as drizzleGetTableConfig } from 'drizzle-orm/sqlite-core';
import { execute, parse } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import type { PothosRelations } from '../../src/drizzle.js';
import { asDrizzleRelations, asPothosRelations } from '../../src/drizzle.js';
import { drizzle, getTableConfig } from '../../src/index.js';
import * as schema from '../schema.js';

const DB = (env as { DB: D1Database }).DB;

const statements: string[] = [];
const db = drizzle({
	client: DB,
	relations: schema.relations,
	onQuery: (event) => statements.push(event.sql),
});

/**
 * `DrizzleRelations` is filled, not opted out of.
 *
 * This used to be `never`, on the reasoning that Pothos slots against Drizzle's
 * `TablesRelationalConfig`, whose `table` carries a protected member. That is
 * true of Drizzle's `Table` *class*, but v1's `TableRelationalConfig` asks only
 * for `SchemaEntry` — so `PothosRelations` satisfies it, and every field below
 * is checked rather than cast. `test/unit/pothos-types.test.ts` pins the type
 * itself, including the negative controls; this file proves the same types
 * drive a schema that actually executes.
 */
const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof schema.relations> }>({
	plugins: [DrizzlePlugin],
	drizzle: {
		client: db as never,
		// Ours, not `drizzle-orm/sqlite-core`'s. See the assertion at the
		// bottom of this file for why that substitution is the whole point.
		getTableConfig: getTableConfig as never,
		// Re-prototyped onto Drizzle's One/Many. The plugin decides list-vs-object
		// with a bare `relationField instanceof Many`, which no amount of
		// structural matching can satisfy — see `asDrizzleRelations`.
		relations: asPothosRelations(schema.relations),
	},
});

const PostRef = builder.drizzleObject('posts', {
	name: 'Post',
	fields: (t) => ({
		id: t.exposeInt('id'),
		title: t.exposeString('title'),
		views: t.exposeInt('views'),
	}),
});

const UserRef = builder.drizzleObject('users', {
	name: 'User',
	select: {
		extras: {
			// Pothos passes the `sql` tag as the second argument and calls it;
			// Drizzle passes `{ sql }`. Both spellings reach the same bag.
			shouty: ((users: typeof schema.users, sql: typeof import('../../src/index.js').sql) =>
				sql<string>`upper(${users.email})`) as never,
		},
	},
	fields: (t) => ({
		id: t.exposeInt('id'),
		email: t.exposeString('email'),
		shouty: t.string({ resolve: (user) => (user as { shouty: string }).shouty }),
		posts: t.relation('posts'),
	}),
});

builder.queryType({
	fields: (t) => ({
		users: t.drizzleField({
			type: [UserRef],
			// `.execute()` rather than awaiting the builder: a RelationalQuery is
			// a thenable, and Pothos' resolver type wants a real Promise.
			resolve: (query, _root, _args, _ctx) =>
				db.query.users.findMany({ ...query(), orderBy: { id: 'asc' } } as never).execute(),
		}),
		post: t.drizzleField({
			type: PostRef,
			args: { id: t.arg.int({ required: true }) },
			resolve: (query, _root, args) =>
				db.query.posts.findFirst({ ...query(), where: { id: args.id } } as never).execute() as never,
		}),
	}),
});

const graphqlSchema = builder.toSchema();

const run = async (source: string) => {
	statements.length = 0;
	const result = await execute({ schema: graphqlSchema, document: parse(source), contextValue: {} });
	if (result.errors?.length) throw result.errors[0];
	return result.data;
};

beforeAll(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(schema.allTables)) await DB.prepare(statement).run();

	await db.insert(schema.users).values([
		{ id: 1, email: 'ada@example.com', name: 'Ada', createdAt: new Date(0) },
		{ id: 2, email: 'bob@example.com', name: 'Bob', createdAt: new Date(0) },
	]);
	await db.insert(schema.posts).values([
		{ id: 10, authorId: 1, title: 'first', views: 5 },
		{ id: 11, authorId: 1, title: 'second', views: 50 },
		{ id: 12, authorId: 2, title: 'third', views: 1 },
	]);
});

describe('a Pothos schema over an orm-d1 database', () => {
	it('resolves scalar fields off a drizzleObject', async () => {
		expect(await run(`{ users { id email } }`)).toEqual({
			users: [{ id: 1, email: 'ada@example.com' }, { id: 2, email: 'bob@example.com' }],
		});
	});

	it('resolves a nested list through t.relation', async () => {
		expect(await run(`{ users { id posts { id title } } }`)).toEqual({
			users: [
				{ id: 1, posts: [{ id: 10, title: 'first' }, { id: 11, title: 'second' }] },
				{ id: 2, posts: [{ id: 12, title: 'third' }] },
			],
		});
	});

	it('resolves the whole nested query in two statements, not one per user', async () => {
		await run(`{ users { id posts { id } } }`);
		// Parents, then children — the split-query executor batching by parent
		// key. An N+1 would make this grow with the number of users.
		expect(statements).toHaveLength(2);
		expect(statements[1]).toContain('"posts"');
	});

	it('computes a select-level extra', async () => {
		expect(await run(`{ users { shouty } }`)).toEqual({
			users: [{ shouty: 'ADA@EXAMPLE.COM' }, { shouty: 'BOB@EXAMPLE.COM' }],
		});
	});

	it('passes arguments into the filter DSL', async () => {
		expect(await run(`{ post(id: 11) { id title views } }`)).toEqual({
			post: { id: 11, title: 'second', views: 50 },
		});
	});

	it('selects only the columns the GraphQL query asked for', async () => {
		await run(`{ users { id } }`);
		expect(statements[0]).toContain('"id"');
		expect(statements[0]).not.toContain('"settings"');
	});
});

/**
 * The two things that had to change for any of the above to run.
 *
 * Neither is observable from the GraphQL results — a passing query proves they
 * work, but not *why* — so they are pinned separately.
 */
describe('what the plugin depends on', () => {
	it('reads the relations object without knowing it is not Drizzle’s', () => {
		// `Object.values(relations).forEach(({ table }) => …)` in the plugin's
		// config, plus `relations[tableName].table` in its model loader.
		for (const entry of Object.values(schema.relations)) {
			expect(entry.table).toBeDefined();
			expect(typeof entry.name).toBe('string');
		}
	});

	it('answers `instanceof Many`, which is how it decides a field is a list', () => {
		const adapted = asDrizzleRelations(schema.relations);
		expect(adapted['users']!.relations['posts']).toBeInstanceOf(DrizzleMany);
		expect(adapted['posts']!.relations['author']).not.toBeInstanceOf(DrizzleMany);
		// Our own objects are left alone — the executor still reads these.
		expect(schema.relations['users']!.relations['posts']).not.toBeInstanceOf(DrizzleMany);
		// And the copy keeps every field the plugin reads off it.
		expect(adapted['users']!.relations['posts']!.targetTableName).toBe('posts');
		expect(adapted['users']!.relations['posts']!.sourceColumns!.map((c) => c.name)).toEqual(['id']);
	});

	it('gets a composite primary key from ours where Drizzle’s reports none', () => {
		// Drizzle derives constraints by running a table's ExtraConfigBuilder,
		// which an orm-d1 table does not have — so its version returns the
		// columns and nothing else, and the plugin's getPrimaryKey throws on
		// `post_tags`. This is the substitution that makes the plugin work.
		expect(drizzleGetTableConfig(schema.postTags as never).primaryKeys).toEqual([]);
		expect(getTableConfig(schema.postTags).primaryKeys[0]!.columns.map((c) => c.name))
			.toEqual(['post_id', 'tag']);
	});
});
