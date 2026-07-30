import { describe, expect, it } from 'vitest';
import { createIndexes, createSchema, createTable, dropTable } from '../../src/ddl.js';
import { blob, check, customType, integer, numeric, real, sql, sqliteTable, text, uniqueIndex } from '../../src/index.js';
import { allTables, postTags, posts, users } from '../schema.js';

describe('ddl generation', () => {
	it('creates a table with inline constraints', () => {
		expect(createTable(users)).toBe(
			'create table "users" (\n'
				+ '\t"id" integer primary key autoincrement not null,\n'
				+ '\t"email" text not null unique,\n'
				+ '\t"name" text,\n'
				+ '\t"role" text not null default \'member\',\n'
				+ '\t"active" integer not null default 1,\n'
				+ '\t"settings" text,\n'
				+ '\t"score" real,\n'
				+ '\t"created_at" integer not null,\n'
				+ '\t"updated_at" integer,\n'
				+ '\tconstraint "users_score_check" check ("score" >= 0)\n'
				+ ')',
		);
	});

	it('emits a column-level foreign key with its actions', () => {
		expect(createTable(posts)).toContain(
			'"author_id" integer not null references "users"("id") on delete cascade',
		);
	});

	it('emits composite primary keys, table-level FKs and uniques', () => {
		const ddl = createTable(postTags);
		expect(ddl).toContain('constraint "post_tags_pk" primary key ("post_id", "tag")');
		expect(ddl).toContain(
			'constraint "post_tags_post_id_fk" foreign key ("post_id") references "posts"("id") on delete cascade',
		);
		expect(ddl).toContain('constraint "post_tags_tag_unique" unique ("tag")');
		// A composite primary key must not also be declared inline.
		expect(ddl).not.toContain('"post_id" integer not null primary key');
	});

	it('never qualifies column names inside checks or index predicates', () => {
		expect(createTable(users)).not.toContain('"users"."score"');
		expect(createIndexes(users)[1]).toBe(
			'create unique index "users_email_active_idx" on "users" ("email", "active") where "active" = 1',
		);
	});

	it('inlines an interpolated value without padding it', () => {
		// The token stands where a `?` would, so the literal replaces it exactly.
		// Padding it produced `"active" =  1 ` — which introspection reads back
		// trimmed and single-spaced, so the index drifted against itself forever.
		const t = sqliteTable('t', {
			active: integer('active').notNull(),
			score: real('score'),
		}, (c) => [
			uniqueIndex('t_active_idx').on(c.active).where(sql`${c.active} = ${1}`),
			check('t_score_check', sql`${c.score} >= ${0}`),
		]);

		expect(createIndexes(t)[0]).toBe(
			'create unique index "t_active_idx" on "t" ("active") where "active" = 1',
		);
		expect(createTable(t)).toContain('check ("score" >= 0)');
	});

	it('renders sql defaults inline and value defaults as literals', () => {
		const t = sqliteTable('t', {
			at: integer('at').notNull().default(sql`(unixepoch())`),
			label: text('label').default("o'clock"),
			ratio: real('ratio').default(0.5),
			amount: numeric('amount').default('1.00'),
			payload: blob('payload', { mode: 'json' }).default({ a: 1 }),
		});

		expect(createTable(t)).toBe(
			'create table "t" (\n'
				+ '\t"at" integer not null default (unixepoch()),\n'
				+ '\t"label" text default \'o\'\'clock\',\n'
				+ '\t"ratio" real default 0.5,\n'
				+ '\t"amount" numeric default \'1.00\',\n'
				+ '\t"payload" blob default \'{"a":1}\'\n'
				+ ')',
		);
	});

	it('parenthesises a bare expression default, and leaves a literal alone', () => {
		// `create table … default unixepoch()` is a syntax error, and the bare
		// spelling is exactly what `pragma table_info` reports — so it reaches
		// a schema module by way of `pull` and has to be normalised on emission.
		const t = sqliteTable('t', {
			made: integer('made').default(sql`unixepoch()`),
			seen: numeric('seen').default(sql`CURRENT_TIMESTAMP`),
			note: text('note').default(sql`'hi'`),
			rank: integer('rank').default(sql`-1`),
		});

		const ddl = createTable(t);
		expect(ddl).toContain('"made" integer default (unixepoch())');
		expect(ddl).toContain('"seen" numeric default CURRENT_TIMESTAMP');
		expect(ddl).toContain(`"note" text default 'hi'`);
		expect(ddl).toContain('"rank" integer default -1');
	});

	it('supports if-not-exists and strict', () => {
		expect(createTable(posts, { ifNotExists: true, strict: true }))
			.toMatch(/^create table if not exists "posts" \(/);
		expect(createTable(posts, { strict: true })).toMatch(/\) strict$/);
		expect(dropTable(posts, { ifNotExists: true })).toBe('drop table if exists "posts"');
	});

	it('orders a whole schema: tables first, then indexes', () => {
		const statements = createSchema(allTables);
		expect(statements).toHaveLength(6);
		expect(statements.slice(0, 3).every((s) => s.startsWith('create table'))).toBe(true);
		expect(statements.slice(3).every((s) => s.includes('index'))).toBe(true);
	});

	it('derives an index name when none is given', () => {
		const t = sqliteTable('t', { a: integer('a') }, (c) => [
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			indexOn(c.a),
		]);
		expect(createIndexes(t)[0]).toContain('"t_a_index"');
	});
});

// Declared here rather than in the fixture: an unnamed index is unusual enough
// that it belongs next to the test that cares about it.
import { index } from '../../src/index.js';
import type { Column } from '../../src/index.js';
const indexOn = (column: Column<any>) => index().on(column);

describe('customType', () => {
	it('passes each column its own config to dataType', () => {
		// `dataType()` used to be called once, eagerly, with no argument — so a
		// dataType reading `config.length` threw at module scope, on import.
		const varchar = customType<string, string, { length: number }>({
			dataType: (config) => `text(${config!.length})`,
		});

		const t = sqliteTable('t', { short: varchar('short', { length: 10 }) });
		expect(createTable(t)).toContain('"short" text');
	});

	it('preserves the declared type verbatim, instead of guessing one of the five storage classes', () => {
		// Old behaviour: only whichever of integer|text|real|blob|numeric the
		// declared string happened to contain as a substring survived, so 'int'
		// rendered as a bare 'text' guess-miss and 'varchar(10)' lost its length.
		const intType = customType({ dataType: () => 'int' });
		const t1 = sqliteTable('t', { n: intType('n') });
		expect(createTable(t1)).toContain('"n" int');
		expect(createTable(t1)).not.toContain('"n" text');
		expect(t1.n.getSQLType()).toBe('int');

		const varchar = customType<string, string, { length: number }>({
			dataType: (config) => `varchar(${config!.length})`,
		});
		const t2 = sqliteTable('t', { name: varchar('name', { length: 10 }) });
		expect(createTable(t2)).toContain('varchar(10)');
	});

	it('applies toDriver and fromDriver as the column encoder and decoder', () => {
		const upper = customType<string, string>({
			dataType: () => 'text',
			toDriver: (value) => value.toUpperCase(),
			fromDriver: (value) => value.toLowerCase(),
		});

		const t = sqliteTable('t', { tag: upper('tag').default('abc') });
		expect(createTable(t)).toContain(`"tag" text default 'ABC'`);
	});
});
