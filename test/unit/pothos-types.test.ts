/**
 * `PothosRelations` — the type that fills `@pothos/plugin-drizzle`'s
 * `DrizzleRelations` generic.
 *
 * The README used to say Pothos' types were opted out of permanently, because
 * Drizzle's `TableRelationalConfig['table']` carries a protected member. That
 * reasoning was stale: v1's `TableRelationalConfig` is only
 * `{ table; name; relations }`, and its `table` is `SchemaEntry` —
 * `Table<any> | View<…>` — which `ToDrizzleTable` already produces. The
 * protected-member rule never gets a chance to apply.
 *
 * Opting out is not free: it takes the *whole* GraphQL layer off compile-time
 * checking, so a typo'd column reaches production as a runtime resolver error.
 * The assertions below therefore matter mostly as **negative** controls — a
 * vacuous `any` would satisfy every positive one. Each `@ts-expect-error` fails
 * the typecheck if the type ever stops rejecting what it should.
 *
 * `tsgo` checks this file; the runtime bodies are trivially true.
 */
import type { BuildQueryResult, TablesRelationalConfig } from 'drizzle-orm';
import { describe, expectTypeOf, it } from 'vitest';
import type { PothosRelations } from '../../src/drizzle.js';
import * as schema from '../schema.js';

type Relations = PothosRelations<typeof schema.relations>;

describe('PothosRelations satisfies the shape Pothos slots against', () => {
	it('is assignable to Drizzle’s TablesRelationalConfig', () => {
		// The assignability the whole feature rests on, and the one the README
		// claimed was impossible. If a protected member were ever reachable from
		// this interface, this line is where it would surface.
		expectTypeOf<Relations>().toExtend<TablesRelationalConfig>();
	});

	it('keys by the schema’s TypeScript names', () => {
		expectTypeOf<keyof Relations>().toEqualTypeOf<'users' | 'posts' | 'postTags'>();
		expectTypeOf<Relations['users']['name']>().toEqualTypeOf<'users'>();
	});
});

describe('row shapes infer through Drizzle’s own BuildQueryResult', () => {
	// Not our inference — Drizzle's, reading the bridged table. This is what
	// Pothos calls to type a `drizzleObject`'s resolvers, so agreement here is
	// what makes `t.exposeString` and `resolve: (row) => …` check correctly.
	type User = BuildQueryResult<Relations, Relations['users'], true>;

	it('infers each column at its own type', () => {
		expectTypeOf<User['id']>().toEqualTypeOf<number>();
		expectTypeOf<User['email']>().toEqualTypeOf<string>();
		expectTypeOf<User['name']>().toEqualTypeOf<string | null>();
		expectTypeOf<User['active']>().toEqualTypeOf<boolean>();
		expectTypeOf<User['createdAt']>().toEqualTypeOf<Date>();
		expectTypeOf<User['role']>().toEqualTypeOf<'admin' | 'member'>();
	});

	it('rejects a column that is not on the table', () => {
		// @ts-expect-error `nope_not_a_column` is not a column of `users`.
		expectTypeOf<User['nope_not_a_column']>().toBeAny();
	});

	it('resolves a relation to the target’s row type, list-ness included', () => {
		type WithPosts = BuildQueryResult<Relations, Relations['users'], { with: { posts: true } }>;
		expectTypeOf<WithPosts['posts']>().toBeArray();
		expectTypeOf<WithPosts['posts'][number]['title']>().toEqualTypeOf<string>();

		// `author` is `optional: false`, so it is `T` rather than `T | null` —
		// the flag survives the trip through Drizzle's `One<…, TOptional>`.
		type WithAuthor = BuildQueryResult<Relations, Relations['posts'], { with: { author: true } }>;
		expectTypeOf<WithAuthor['author']['email']>().toEqualTypeOf<string>();
	});
});

describe('relation names are validated, not merely present', () => {
	it('carries every declared relation', () => {
		expectTypeOf<keyof Relations['users']['relations']>().toEqualTypeOf<'posts'>();
		expectTypeOf<keyof Relations['posts']['relations']>().toEqualTypeOf<'author' | 'tags'>();
	});

	it('rejects a relation name that was never declared', () => {
		// The gap the review flagged in its own sketch: with
		// `relations: Record<string, never>`, `t.relation('definitely_not_a_relation')`
		// would compile. Mapping One/Many into the record is what closes it.
		// @ts-expect-error no such relation on `users`.
		expectTypeOf<Relations['users']['relations']['definitely_not_a_relation']>().toBeAny();
	});

	it('distinguishes one from many at the type level', () => {
		expectTypeOf<Relations['users']['relations']['posts']['relationType']>().toEqualTypeOf<'many'>();
		expectTypeOf<Relations['posts']['relations']['author']['relationType']>().toEqualTypeOf<'one'>();
		// The target name is recovered from the phantom target table, and it is
		// what Drizzle keys the joined row shape by.
		expectTypeOf<Relations['users']['relations']['posts']['targetTableName']>().toEqualTypeOf<'posts'>();
	});
});
