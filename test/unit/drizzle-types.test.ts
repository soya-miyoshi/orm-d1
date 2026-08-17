/**
 * Type-level parity with Drizzle.
 *
 * `expectTypeOf` assertions are checked by `tsgo`, not at runtime, so this file
 * earns its keep during typecheck; the runtime bodies are trivially true.
 */
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { sql as drizzleSql } from 'drizzle-orm';
import {
	integer as drizzleInteger,
	sqliteTable as drizzleSqliteTable,
	text as drizzleText,
} from 'drizzle-orm/sqlite-core';
import { describe, expectTypeOf, it } from 'vitest';
import { asDrizzleSchema, asDrizzleTable } from '../../src/drizzle.js';
import type { InferInsert, InferSelect } from '../../src/index.js';
import { customType, integer, query, sql, sqliteTable, text } from '../../src/index.js';
import * as schema from '../schema.js';
import { posts, users } from '../schema.js';

type OurUser = InferSelect<typeof users>;
type TheirUser = InferSelectModel<ReturnType<typeof asDrizzleTable<typeof users>>>;

type OurNewUser = InferInsert<typeof users>;
type TheirNewUser = InferInsertModel<ReturnType<typeof asDrizzleTable<typeof users>>>;

describe('inference matches Drizzle’s, field for field', () => {
	it('selects the same row type', () => {
		expectTypeOf<TheirUser>().toEqualTypeOf<OurUser>();
		expectTypeOf<OurUser['id']>().toEqualTypeOf<number>();
		expectTypeOf<OurUser['name']>().toEqualTypeOf<string | null>();
		expectTypeOf<OurUser['active']>().toEqualTypeOf<boolean>();
		expectTypeOf<OurUser['createdAt']>().toEqualTypeOf<Date>();
		expectTypeOf<OurUser['settings']>().toEqualTypeOf<{ theme: string } | null>();
		expectTypeOf<OurUser['role']>().toEqualTypeOf<'admin' | 'member'>();
	});

	it('requires the same keys on insert', () => {
		// `[F-094]`: our optional keys now spell `k?: T | undefined`, matching
		// Drizzle's own `InferInsertModel` exactly (`drizzle-orm/table.d.ts`),
		// so `toExtend` here holds in both directions, not just ours-into-theirs.
		expectTypeOf<OurNewUser>().toExtend<TheirNewUser>();
		expectTypeOf<TheirNewUser>().toExtend<OurNewUser>();
		expectTypeOf<Exclude<keyof OurNewUser, keyof TheirNewUser>>().toEqualTypeOf<never>();
		expectTypeOf<Exclude<keyof TheirNewUser, keyof OurNewUser>>().toEqualTypeOf<never>();
		expectTypeOf<TheirNewUser['role']>().toEqualTypeOf<'admin' | 'member' | undefined>();
		expectTypeOf<TheirNewUser['createdAt']>().toEqualTypeOf<Date | undefined>();
		expectTypeOf<TheirNewUser['settings']>().toEqualTypeOf<{ theme: string } | null | undefined>();
		expectTypeOf<TheirNewUser['email']>().toEqualTypeOf<string>();
		// `email` is notNull with no default: required.
		expectTypeOf<OurNewUser['email']>().toEqualTypeOf<string>();
		// `id`, `role` and `active` all have defaults: optional.
		expectTypeOf<OurNewUser['id']>().toEqualTypeOf<number | undefined>();
		expectTypeOf<OurNewUser['role']>().toEqualTypeOf<'admin' | 'member' | undefined>();
	});

	it('keeps a whole schema module assignable', () => {
		const drizzleSchema = asDrizzleSchema(schema);
		expectTypeOf<InferSelectModel<typeof drizzleSchema.posts>>().toEqualTypeOf<InferSelect<typeof posts>>();
	});

	// `[F-094]`: `typeof table.$inferSelect` / `$inferInsert`, the property
	// spelling — alongside the free `InferSelectModel<T>` / `InferInsertModel<T>`
	// helpers above — so a schema ported by changing one import specifier keeps
	// every `typeof X.$inferInsert` annotation compiling.
	it('exposes $inferSelect / $inferInsert as properties on the table, like Drizzle', () => {
		expectTypeOf<typeof users.$inferSelect>().toEqualTypeOf<TheirUser>();
		expectTypeOf<typeof users.$inferSelect>().toEqualTypeOf<OurUser>();
		expectTypeOf<typeof users.$inferInsert>().toExtend<TheirNewUser>();
		expectTypeOf<typeof users.$inferInsert>().toEqualTypeOf<OurNewUser>();
	});
});

describe('$inferSelect / $inferInsert pin optionality through $defaultFn and nullability', () => {
	const t = sqliteTable('t_infer_props', {
		id: integer('id').primaryKey(),
		token: text('token').notNull().$defaultFn(() => 'x'),
		note: text('note'),
	});

	// Built the same way against real `drizzle-orm/sqlite-core`, not a
	// hand-written literal — a literal `id?: number` (no `| undefined`) checks
	// only that orm-d1 agrees with itself, and would not have caught `[F-094]`:
	// real drizzle-orm's `InferInsertModel` spells the optional half
	// `?: GetColumnData<…> | undefined` (`drizzle-orm/table.d.ts`), which
	// differs from a bare `?: T` under `exactOptionalPropertyTypes`.
	const dzT = drizzleSqliteTable('t_infer_props_dz', {
		id: drizzleInteger('id').primaryKey(),
		token: drizzleText('token').notNull().$defaultFn(() => 'x'),
		note: drizzleText('note'),
	});

	it('$inferSelect keeps a nullable column nullable, not optional', () => {
		expectTypeOf<typeof t.$inferSelect>().toEqualTypeOf<typeof dzT.$inferSelect>();
		expectTypeOf<typeof t.$inferSelect>().toEqualTypeOf<{
			id: number;
			token: string;
			note: string | null;
		}>();
	});

	it('$inferInsert makes a $defaultFn column optional, matching real drizzle-orm exactly', () => {
		// `toEqualTypeOf`, not just mutual `toExtend`: this is the type
		// `[F-094]` fixed, so it has to be checked for exact equality against
		// Drizzle's own type, not merely assignability in one direction.
		expectTypeOf<typeof t.$inferInsert>().toEqualTypeOf<typeof dzT.$inferInsert>();

		// The `exactOptionalPropertyTypes` edge case itself: an object literal
		// that sets an optional key to an explicit `undefined` must assign to
		// both sides. Before the fix, `?: Out<C[K]>` (no `| undefined`)
		// rejected this under `exactOptionalPropertyTypes`, while Drizzle's
		// `?: GetColumnData<…> | undefined` accepted it.
		const withExplicitUndefined: typeof dzT.$inferInsert = { id: undefined, token: 'x', note: undefined };
		const ours: typeof t.$inferInsert = withExplicitUndefined;
		void ours;
	});
});

describe('generated columns are absent from the insert model', () => {
	const flags = sqliteTable('flags', {
		id: integer('id').primaryKey(),
		name: text('name').notNull(),
		shout: text('shout').generatedAlwaysAs(sql`upper("name")`),
		loud: text('loud').notNull().generatedAlwaysAs(sql`upper("name")`),
	});

	// Compared against a table declared natively in Drizzle, not against
	// `asDrizzleTable(flags)`: the bridge pins `_['generated']` to `undefined` on
	// purpose (see `DrizzleColumnShape`), so a bridged table would agree with us
	// for the wrong reason and prove nothing.
	const theirFlags = drizzleSqliteTable('flags', {
		id: drizzleInteger('id').primaryKey(),
		name: drizzleText('name').notNull(),
		shout: drizzleText('shout').generatedAlwaysAs(drizzleSql`upper("name")`),
		loud: drizzleText('loud').notNull().generatedAlwaysAs(drizzleSql`upper("name")`),
	});

	type NewFlag = InferInsert<typeof flags>;
	type TheirNewFlag = InferInsertModel<typeof theirFlags>;

	it('omits the key entirely, as Drizzle does', () => {
		// Not optional — absent. Offering it invites the value that makes D1 fail
		// with `cannot INSERT into generated column`.
		expectTypeOf<Exclude<keyof NewFlag, 'id' | 'name'>>().toEqualTypeOf<never>();
		// `loud` is notNull, so the required-key branch has to drop it too.
		expectTypeOf<Exclude<keyof TheirNewFlag, keyof NewFlag>>().toEqualTypeOf<never>();
		expectTypeOf<Exclude<keyof NewFlag, keyof TheirNewFlag>>().toEqualTypeOf<never>();
	});

	it('still selects them', () => {
		expectTypeOf<InferSelect<typeof flags>['shout']>().toEqualTypeOf<string | null>();
		expectTypeOf<InferSelect<typeof flags>['loud']>().toEqualTypeOf<string>();
	});

	it('does not disturb the other columns', () => {
		expectTypeOf<NewFlag['id']>().toEqualTypeOf<number | undefined>();
		expectTypeOf<NewFlag['name']>().toEqualTypeOf<string>();
	});
});

describe('a subquery keeps its columns’ nullability', () => {
	it('does not widen a notNull column to null', () => {
		const inner = query.select({ id: users.id, name: users.name }).from(users).as('inner');
		expectTypeOf<InferSelect<typeof inner>>().toEqualTypeOf<{ id: number; name: string | null }>();
		// The read, not just the row type: this is what forced a `!` before.
		expectTypeOf(inner.id.$).toExtend<{ notNull: true }>();
		expectTypeOf(inner.name.$).toExtend<{ notNull: false }>();
	});
});

describe("text({ mode: 'json' }) matches Drizzle", () => {
	type Location = { lat: number; lon: number };

	const ours = sqliteTable('places', {
		id: integer('id').primaryKey(),
		plain: text('plain'),
		blob: text('blob', { mode: 'json' }),
		typed: text('typed', { mode: 'json' }).$type<Location>(),
	});

	const theirs = drizzleSqliteTable('places', {
		id: drizzleInteger('id').primaryKey(),
		plain: drizzleText('plain'),
		blob: drizzleText('blob', { mode: 'json' }),
		typed: drizzleText('typed', { mode: 'json' }).$type<Location>(),
	});

	it('carries the narrowed type through $type, as Drizzle does', () => {
		// The whole point: this used to be `string | null`, because the return
		// type ignored `mode` while the runtime built a JSON column — so
		// `$type<T>()` had nothing to narrow and `json<T>()` was needed instead.
		expectTypeOf<InferSelect<typeof ours>['typed']>().toEqualTypeOf<Location | null>();
		expectTypeOf<InferSelectModel<typeof theirs>['typed']>().toEqualTypeOf<Location | null>();
	});

	it('is unknown without $type, as Drizzle is', () => {
		expectTypeOf<InferSelect<typeof ours>['blob']>().toEqualTypeOf<unknown>();
	});

	it('leaves a column with no mode as a string', () => {
		// The conditional must not distribute over the default `'text' | 'json'`
		// union, or a plain column comes back as both branches at once.
		expectTypeOf<InferSelect<typeof ours>['plain']>().toEqualTypeOf<string | null>();
		expectTypeOf<InferSelectModel<typeof theirs>['plain']>().toEqualTypeOf<string | null>();
	});
});

describe('primaryKey()’s HasDefault is gated like Drizzle’s', () => {
	// Drizzle's `ColumnBuilder.primaryKey()` only adds `HasDefault` when
	// `TExtraConfig['primaryKeyHasDefault']` extends `true` — set only by the
	// integer builder (see `sqlite-core/columns/integer.d.ts`). A `customType`
	// column has no such flag, so its primary key stays required on insert.
	const uuid = customType<string>({ dataType: () => 'text' });

	const withCustomPk = sqliteTable('with_custom_pk', {
		id: uuid('id').primaryKey(),
	});

	const withIntegerPk = sqliteTable('with_integer_pk', {
		id: integer('id').primaryKey(),
	});

	// `SQLiteTimestampBuilder` and `SQLiteBooleanBuilder` both extend
	// `SQLiteBaseIntegerBuilder` (`sqlite-core/columns/integer.d.ts`), so they
	// inherit `primaryKeyHasDefault` too — an `integer(..., { mode: 'timestamp' |
	// 'boolean' })` primary key is still SQLite's rowid alias underneath and is
	// just as optional on insert as a plain integer one.
	const withTimestampPk = sqliteTable('with_timestamp_pk', {
		id: integer('id', { mode: 'timestamp' }).primaryKey(),
	});

	const withBooleanPk = sqliteTable('with_boolean_pk', {
		id: integer('id', { mode: 'boolean' }).primaryKey(),
	});

	it('requires the id on insert for a non-integer primary key', () => {
		type Insert = InferInsert<typeof withCustomPk>;
		expectTypeOf<Insert['id']>().toEqualTypeOf<string>();
	});

	it('leaves the id optional on insert for an integer primary key', () => {
		type Insert = InferInsert<typeof withIntegerPk>;
		expectTypeOf<Insert['id']>().toEqualTypeOf<number | undefined>();
	});

	it('leaves the id optional on insert for a timestamp-mode integer primary key', () => {
		type Insert = InferInsert<typeof withTimestampPk>;
		expectTypeOf<Insert['id']>().toEqualTypeOf<Date | undefined>();
	});

	it('leaves the id optional on insert for a boolean-mode integer primary key', () => {
		type Insert = InferInsert<typeof withBooleanPk>;
		expectTypeOf<Insert['id']>().toEqualTypeOf<boolean | undefined>();
	});
});
