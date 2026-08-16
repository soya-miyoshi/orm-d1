# d1zzle

d1zzle is an ORM for Cloudflare D1. It supports D1 and nothing else. Its API is taken from
Drizzle — the same schema DSL, the same query builder, the same inferred types — and the
parts that exist to abstract over other databases are removed. `d1zzle-migrate` is the
migration CLI, installed separately and used only during development.

```bash
npm install d1zzle
npm install -D d1zzle-migrate
```

```ts
import { drizzle, eq, integer, sqliteTable, text } from 'd1zzle';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name'),
});

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB);

    const all = await db.select().from(users);
    const one = await db.select().from(users).where(eq(users.id, 1)).get();

    await db.insert(users).values({ email: 'a@b.c' });
    return Response.json(all);
  },
};
```

An existing `drizzle-orm/sqlite-core` schema file works after changing one import
specifier; see [Migrating an existing project](#migrating-an-existing-project).

## Contents

- [Differences from drizzle-orm on D1](#differences-from-drizzle-orm-on-d1)
- [Relational queries](#relational-queries)
- [Migrations](#migrations)
- [Migrating an existing project](#migrating-an-existing-project)
- [Ecosystem](#ecosystem)
- [Entry points and dependencies](#entry-points-and-dependencies)
- [D1 limits, and where each is enforced](#d1-limits-and-where-each-is-enforced)
- [Scope](#scope)
- [Development](#development)
- [Support and maintenance](#support-and-maintenance)

## Differences from drizzle-orm on D1

The API is Drizzle's; the behaviour on D1 differs in ten places, all of them consequences
of the same four properties of the platform. The database is reached over the network, so
cost tracks the number of calls; a statement accepts at most 100 bound parameters;
`batch()` is the only atomicity available, because there are no interactive transactions;
and Worker startup CPU is billed, so library size is a per-request cost on cold isolates.

Each case below is written out in full — what `drizzle-orm@1.0.0-rc.4` does on D1, read
from that version's own source, and what d1zzle does instead — in
**[Differences from drizzle-orm on D1](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md)**.

| Case | `drizzle-orm` on D1 | d1zzle |
| --- | --- | --- |
| [Inserting more rows than one statement can carry](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#inserting-more-rows-than-one-statement-can-carry) | one statement, 2,000 parameters, `too many SQL variables` | chunked at compile time and submitted as one atomic `batch()` |
| [Matching a column against a long list](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#matching-a-column-against-a-long-list) | one parameter per value; over 100 values fails | collapses to `json_each(?)` past a threshold |
| [Grouping writes so that they all succeed or all fail](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#grouping-writes-so-that-they-all-succeed-or-all-fail) | `transaction()` emits `BEGIN`/`COMMIT`, which D1 does not honour | no `transaction()`; `batch()`, with typed per-statement results |
| [A joined select inside `batch()` with two columns of the same name](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#a-joined-select-inside-batch-that-projects-two-columns-with-the-same-name) | the duplicate key is already lost when the row is converted | collision detected while compiling; aliases emitted |
| [Reading from a replica, and reading your own writes](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#reading-from-a-replica-and-reading-your-own-writes) | no session API; use the binding directly | `withSession()` returns the same API, plus `bookmark()` |
| [Seeing what a query cost](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#seeing-what-a-query-cost) | `logger` gets SQL and params; selects lose D1's metadata | `onQuery` with `rowsRead` / `rowsWritten` / timings per statement |
| [Building a query once per isolate](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#building-a-query-once-per-isolate-instead-of-once-per-request) | `.prepare()` needs a session, so SQL is built inside `fetch` | compilation is separate from execution; compile at module scope |
| [D1's other limits](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#d1s-other-limits) | reported by D1, naming the constraint but not the call | checked while compiling, naming the lever |
| [Plan-dependent limits](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#plan-dependent-limits) | — | opt-in `plan: 'free' \| 'paid'` warnings in development |
| [Bundle size](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#bundle-size) | 77.8 kB minified for driver + schema DSL | 44.1 kB — the dialect, transaction and prepared-statement layers are absent |

## Relational queries

```ts
import { defineRelations, drizzle } from 'd1zzle';

export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}));

const db = drizzle({ client: env.DB, relations });   // or drizzle(env.DB, { relations })

const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: { posts: { columns: { title: true }, where: { views: { gt: 100 } } } },
  orderBy: { id: 'desc' },
  limit: 10,
});
```

This is Drizzle v1's interface: `defineRelations`, the RQBv2 `db.query` config, and v1's
`getTableConfig` shape. The v0 `relations()` API is not supported.

The join is stated once, with `from`/`to` on either side; the other side picks it up.
`optional: false` on a `one` relation removes `| null` from the inferred type.

`where` is an object DSL. A bare scalar means equality, so `{ id: 1 }` is
`{ id: { eq: 1 } }`. Besides the per-column operators (`eq` `ne` `gt` `gte` `lt` `lte`
`in` `notIn` `like` `ilike` `notLike` `notIlike` `isNull` `isNotNull`) there are `AND`,
`OR`, `NOT`, a `RAW` escape hatch, and relation keys: `{ posts: { views: { gt: 100 } } }`
filters users by their posts, compiled as a correlated `exists` in the parent's own query.

Every operator accepts a `ph()` placeholder except `in` and `notIn`, which take a literal
array or a subquery — `in (…)` renders one parameter per value, so the count is part of
the SQL text and a placeholder filled after compilation could only ever fill one slot.
Passing one is a `CompileError` naming the column.

`count` takes the same `where`, including relation keys, and answers how many rows
`findMany` would return without a limit:

```ts
const where = { status: { in: ['paid', 'shipped'] } };

const rows  = await db.query.orders.findMany({ where, orderBy: { id: 'desc' }, limit: 20 });
const total = await db.query.orders.count({ where });
```

It accepts no `with`, `limit` or `offset`: relations are stitched rather than joined, so
none of them changes the total.

### How a `with` is executed

Two plans, selected with `relationalStrategy`. Both return identical results — the workers
suite runs a matrix of queries through each and deep-compares them against a real D1
database — so the choice affects timing only.

```ts
const db = drizzle({ client: env.DB, relations });                              // 'split' (default)
const db = drizzle({ client: env.DB, relations, relationalStrategy: 'joined' });
```

`'split'` runs one query per relation level and stitches the rows in JavaScript. Levels
cost round trips; rows do not — two parents or two thousand, a level is one query with an
`in`, which collapses to `json_each` past the parameter budget.

```sql
select "id", "email" from "users"
select "id", "title" from "posts" where "author_id" in (?, ?)
```

`'joined'` answers the whole tree in one statement, each relation a correlated subquery
wrapped in `json_group_array` / `json_object` — the shape Drizzle v1 produces on SQLite.
SQLite has no `LATERAL`, so it is a correlated subquery rather than the lateral join
Drizzle emits on Postgres; the two are equivalent here.

```sql
select "d0"."id",
  (select json_group_array(json_object('id', "id", 'title', "title"))
   from (select "d1"."id" as "id", "d1"."title" as "title"
         from "posts" as "d1" where "d0"."id" = "d1"."author_id") as "t") as "posts"
from "users" as "d0"
```

Neither dominates. Joined makes one call and runs the inner query once per outer row;
split makes one call per level and does one index scan each. The default is split because
its failure modes are visible: `rows_read` is predictable, no function-argument cap
constrains the projection, and the SQL in a log is readable.

`'joined'` falls back to split, per query and silently, for anything it cannot express as
a correlated subquery:

| Falls back when | Why |
| --- | --- |
| a relation goes `through` a junction table | needs a join inside the inner select |
| a payload holds a `blob` column | `json_object` rejects binary — *JSON cannot hold BLOB values* |
| a payload is wider than 63 keys | `json_object` costs 2 arguments per key against SQLite's 127-argument cap |
| a nested `limit`/`offset` is a placeholder | split cannot take one, and the strategy must not change which queries are legal |

Three further properties of the split plan:

- Relations at the same level are fetched concurrently, so round trips scale with the
  *depth* of the `with` tree, not the number of relations in it.
- A nested `limit`/`offset` is a page per parent, taken with a `row_number()` window so
  the level stays one query. One query per parent would be an unbounded fan-out against
  the Workers subrequest limit.
- Join keys are fetched whether or not you selected them, and removed from the rows before
  they are returned. A parent with no children gets `[]` for a `many` and `null` for a
  `one`, never a missing key. A `where` on a child narrows the children, not the parents.

Many-to-many is declared with `.through()` on both ends:

```ts
articles: {
  tags: r.many.tags({
    from: r.articles.id.through(r.articleTags.articleId),
    to: r.tags.id.through(r.articleTags.tagId),
  }),
},
```

Before passing a client-supplied object to `findMany`, read
[docs/11-security](./docs/11-security.md#the-filter-dsl-is-a-query-language): the filter
DSL is a query language, and handing one an untrusted body delegates query construction to
the caller.

## Migrations

`d1zzle-migrate` is a devDependency. It runs in Node and adds nothing to the Worker
bundle. Full documentation is in [kit/README.md](./kit/README.md).

```bash
npx d1zzle-migrate generate   # diff the schema against the last snapshot → a SQL migration
npx d1zzle-migrate migrate    # apply pending migrations (--local | --remote)
npx d1zzle-migrate check      # drift and unapplied migrations; non-zero exit for CI
npx d1zzle-migrate verify     # replay migrations into an empty DB and compare with the schema
```

The command surface mirrors `drizzle-kit` (`generate` `migrate` `push` `pull` `check`
`up`, plus `verify`), and migrations are written in wrangler's layout and recorded in
wrangler's own `d1_migrations` table, so `d1zzle-migrate migrate` and
`wrangler d1 migrations apply` remain interchangeable on the same database.

What differs, and why:

**Applying a migration is atomic.** A migration file is split into statements and
submitted as one `batch()`. Emitting `BEGIN`/`COMMIT` around the statements — what a
portable tool does — is not honoured by D1, so a failure halfway through leaves the
database half-migrated. When a migration is too large for one atomic unit the CLI reports
the split point rather than hiding it; a remote migration over 100 statements is routed
through the file-import endpoint, which Cloudflare rolls back as a unit, instead of being
cut in half.

**Some statements cannot go through D1's `/query` endpoint at all.** D1 re-splits the
posted string on semicolons with a splitter that does not know about compound statements,
so a trigger body is cut before its `end`:

```sql
create trigger "t_no_update" before update on "t" begin
  select raise(abort, 't is append-only');   -- /query cuts here
end;
```

D1 answers `incomplete input: SQLITE_ERROR`. Measured against a real database, this happens
for a whole batch, for a lone `create trigger`, on one line, and with the trailing
semicolon removed; the semicolon before `end` is required by SQLite's grammar, so there is
no phrasing `/query` accepts. `wrangler d1 migrations apply` fails identically — it is the
endpoint, not the client. `d1zzle-migrate` routes such a batch through the file-import
endpoint (`init` → `PUT` → `ingest` → poll), the same four steps `wrangler d1 execute
--file` uses.

**Table rebuilds are checked before they are written.** SQLite can only `ADD COLUMN`,
`DROP COLUMN`, `RENAME COLUMN` and `RENAME TO`; a type change, a new `NOT NULL`, a changed
default or any constraint change rebuilds the table. SQLite's standard recipe for that
begins with `PRAGMA foreign_keys = OFF`, which D1 rejects — it cannot be changed inside the
implicit transaction D1 runs every statement in. `defer_foreign_keys`, which D1 does
accept, postpones constraint checking but does not suppress `ON DELETE CASCADE`, so the
`DROP TABLE` step would delete rows out of every referencing table. Therefore a table that
another table references cannot be rebuilt in one migration: `generate` refuses and names
the tables holding the references, instead of emitting SQL that destroys data on apply.
Drop the referencing foreign keys in one migration and rebuild in the next. The same rule
applies to a new `NOT NULL` column with no default — it cannot be backfilled, so it fails
at `generate` rather than at apply. In the rebuild itself, the column list in
`INSERT … SELECT` is always computed from the intersection of the old and new columns;
`SELECT *` never appears.

**`verify` exists because `check` cannot catch a renderer bug.** `generate` writes two
artifacts from one diff — the SQL and the snapshot — and nothing forces them to agree. If
the renderer drops a constraint, both are self-consistent, `check` compares the live
database against the snapshot that shares the omission, and CI stays green with the
constraint gone. This is the failure the project started from: on one 64-table schema,
`drizzle-kit` dropped column-level `.unique()` and the generated-versus-committed CI check
stayed green because both artifacts shared the bug. `verify` replays the migrations into
an empty database and compares *that* against the schema, so the two sides share no code
path. It needs no database and runs in CI.

**Drift is a command.** `check` introspects the live database, diffs it against the
snapshot the migrations imply, and reports unapplied migrations and manual changes — the
`wrangler d1 execute` someone ran against production that would otherwise make the next
generated migration compute from a false baseline.

**One target, printed before it acts.** The database is read from `wrangler.jsonc` /
`wrangler.toml`, including named environment blocks, selected the way wrangler selects
them (`--env`, then `CLOUDFLARE_ENV`, then `d1.env`, then top level). An environment that
declares no `d1_databases` is an error rather than a fallback to the top-level block,
because wrangler treats that binding as non-inheritable and the fallback would apply a
migration to a database wrangler would never have bound. Every database-touching command
prints the environment, binding, database name, and — for `--remote` — the account and the
database id masked to its last four characters, each with the source it was read from.

There is no `studio`. The Drizzle Studio browser extension introspects the live database
and never loads a schema file, so it works against a d1zzle project unchanged;
Cloudflare's D1 console covers ad-hoc queries.

## Migrating an existing project

Change the import specifier:

```diff
- import { drizzle } from 'drizzle-orm/d1';
- import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
+ import { drizzle, sqliteTable, text, integer } from 'd1zzle';
```

For a zero-diff migration, alias the modules instead of editing files:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "drizzle-orm": ["./node_modules/d1zzle/dist/index.js"],
      "drizzle-orm/d1": ["./node_modules/d1zzle/dist/index.js"],
      "drizzle-orm/sqlite-core": ["./node_modules/d1zzle/dist/sqlite-core.js"]
    }
  }
}
```

Point at the `.js`, not the `.d.ts`. Getting this wrong fails silently: the build
succeeds, the types are d1zzle's, the editor is satisfied, and the Worker runs on
`drizzle-orm`. esbuild — wrangler's bundler — honours `paths` for module resolution but
cannot bundle a declaration file, so it falls through to node resolution and finds the real
`drizzle-orm`, which is installed by definition during a migration. TypeScript picks up the
sibling `.d.ts` from the `.js` path on its own, so types are unaffected. Set `baseUrl` as
well; a relative `./node_modules/…` path resolved without it depends on the bundler's
working directory.

Bundling a two-import Worker with each target, unminified — these numbers identify which
library ended up in the bundle rather than measure its size:

| `paths` target | bundle | contains |
| --- | --- | --- |
| `dist/index.d.ts` | 175 kB | `drizzle-orm` — the mapping did nothing |
| `dist/index.js` | 81 kB | d1zzle |

`test/unit/module-resolution.test.ts` bundles that fixture and asserts it.

**Supported unchanged:** `sqliteTable` · every column type and `mode` · `.notNull()`
`.primaryKey({ autoIncrement })` `.default()` `.$defaultFn()` `.$onUpdate()` `.$type<T>()`
`.references()` `.unique()` `.generatedAlwaysAs()` · `index()` `uniqueIndex()`
`primaryKey()` `foreignKey()` `unique()` `check()` · both table-extras forms · the `sql`
tag · the comparison and aggregate operators · `defineRelations()` and `db.query` ·
`InferSelectModel` / `InferInsertModel`.

**Not supported:**

- `transaction()` — throws, with a pointer to `batch()`.
- The v0 `relations()` API, and the `where`/`orderBy` callback forms. d1zzle presents v1's
  interface only. The old `schema` option is accepted and ignored.
- Views, CTEs and set operations. They are absent rather than silently no-op.
- Drizzle's execution plan for relational queries is not adopted, only its interface.

The schema DSL is a strict subset of `drizzle-orm/sqlite-core`: every symbol usable in a
schema file also exists there with the same meaning. That is what makes the aliasing work
in both directions, and it is why `STRICT`, `WITHOUT ROWID` and the append-only trigger are
configured in a separate `tableOptions` module rather than on the table.

## Ecosystem

Drizzle has no public API for describing a schema, so adapters read its internals:
`entityKind`, `Symbol.for('drizzle:Columns')`, `db._.relations`. d1zzle tables and columns
carry those, so Drizzle's own helpers work on them:

```ts
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteInteger, SQLiteTable } from 'drizzle-orm/sqlite-core';

is(users, SQLiteTable);       // true
is(users.id, SQLiteInteger);  // true
getTableColumns(users);       // { id, email, name }
```

Drizzle `SQL` fragments built over d1zzle columns — `eq(users.id, 1)`, `inArray(...)`,
`` sql`…` `` — render correctly inside a d1zzle query, which is how an adapter's own
predicates reach the database.

### Pothos

`test/workers/pothos.test.ts` runs a GraphQL schema over a d1zzle database inside workerd
with `@pothos/plugin-drizzle`. Two substitutions are required:

```ts
import type { PothosRelations } from 'd1zzle/drizzle';
import { asPothosRelations } from 'd1zzle/drizzle';
import { getTableConfig } from 'd1zzle';           // ours, not drizzle-orm/sqlite-core's

const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof relations> }>({
  plugins: [DrizzlePlugin],
  drizzle: { client: db, getTableConfig, relations: asPothosRelations(relations) },
});
```

- `getTableConfig` must be d1zzle's. Drizzle's derives constraints by running a table's
  `ExtraConfigBuilder`, which a d1zzle table does not have, so it reports the columns and
  leaves every other field empty — and the plugin then cannot find a composite primary key.
  The plugin reads `getTableConfig` from its own config, so substituting it is enough.
- `asPothosRelations` re-prototypes the relations onto Drizzle's `One`/`Many`. The plugin
  is duck-typed everywhere except `relationField instanceof Many`, which decides whether a
  field is a GraphQL list. `instanceof` consults the right-hand constructor, so no
  structural match satisfies it; without this, every `many` relation resolves as a single
  object.

`asDrizzleSchema` / `asDrizzleTable` are identity functions at runtime. They exist because
Drizzle's `Column` declares a `protected` member, and TypeScript accepts protected members
only from the declaring class, so no independent implementation is assignable — they
compute the equivalent Drizzle types from metadata the columns already carry.
`asDrizzleRelations` is the one export that does runtime work, for the `instanceof` reason
above.

Pothos' relation types are checked rather than opted out of:
`test/unit/pothos-types.test.ts` pins the negative controls — an unknown column, an
unknown property on a resolver's row, a resolver whose return type disagrees with its
field, and an undeclared relation name are each rejected. `client` and `getTableConfig`
still require casts, because they slot against Drizzle's database and table classes and
the protected-member rule applies there.

### Better Auth

`d1zzle/better-auth` is a Better Auth database adapter written against
`createAdapterFactory`, not a shim over the Drizzle one:

```ts
import { betterAuth } from 'better-auth';
import { drizzle } from 'd1zzle';
import { d1zzleAdapter } from 'd1zzle/better-auth';
import { user, session, account, verification } from './schema';

const auth = betterAuth({
  database: d1zzleAdapter(drizzle(env.DB), {
    schema: { user, session, account, verification },
  }),
});
```

Write the four tables with `sqliteTable` as usual — the schema in Better Auth's Drizzle
documentation ports over unchanged — and generate the migration with `d1zzle-migrate`.
Model names map to tables through `schema`; field names map to columns through Better
Auth's own `fields` option.

The reason for a separate adapter: everything in the section above is about being *read*.
Better Auth's Drizzle adapter instead *executes* through drizzle-orm — `db.insert(t)
.values(…)`, `eq()`, `and()`, its dialect and session layer. `asDrizzleSchema()` retypes a
schema; it cannot retype a runtime, and a d1zzle table fails there on the first write.
`createAdapterFactory` takes ten methods over `{ model, where, data }` and supplies the
mapping, id generation and transforms itself, so it needs no Drizzle at all.

`consumeOne` and `incrementOne` are implemented as one `RETURNING` statement pinned to a
single row. Better Auth's fallbacks for them are built on transactions, which D1 does not
have, and a fallback would leave a read-then-write gap in exactly the operations where
only one caller may win — consuming a verification token, decrementing a guarded counter.
`test/workers/better-auth.test.ts` races them against real D1 and asserts the counts.

`experimental.joins` is not supported: the adapter raises a named error rather than
dropping the joined models. There is no `createSchema` for `@better-auth/cli generate`,
because in a d1zzle project the schema file is what `d1zzle-migrate` diffs against, and
generating it from Better Auth's model list would invert the source of truth.

## Entry points and dependencies

| Import | Contents |
| --- | --- |
| `d1zzle` | schema, queries, runtime, relations |
| `d1zzle/core` | the same, minus relations — the smallest entry |
| `d1zzle/sqlite-core` | the Drizzle-named schema surface, for import aliasing |
| `d1zzle/ddl` | schema → `CREATE TABLE` / `CREATE INDEX`, and `tableOptions()` |
| `d1zzle/relations` | `defineRelations()`, `db.query`, the filter DSL |
| `d1zzle/drizzle` | the bridge to `drizzle-orm`: `asDrizzleSchema`, `asDrizzleRelations` |
| `d1zzle/better-auth` | `d1zzleAdapter()` |

`package.json` declares `"dependencies": {}`. `drizzle-orm` and `better-auth` are optional
peers, and each is confined to one entry point:

- `d1zzle`, `d1zzle/core`, `d1zzle/sqlite-core`, `d1zzle/ddl` and `d1zzle/relations` import
  neither, at runtime or for types. Both can be absent from `node_modules`.
- `d1zzle/drizzle` imports `drizzle-orm`'s types for `asDrizzleSchema` / `asDrizzleTable`,
  and its `One`/`Many` classes at runtime for `asDrizzleRelations`. Importing that module
  is what makes `drizzle-orm` required, which is why nothing else re-exports it.
- `d1zzle/better-auth` imports `createAdapterFactory` from `better-auth/adapters` at
  runtime. Only a project calling `d1zzleAdapter()` needs `better-auth` installed.

The peer range is `>=1.0.0-rc.1`: d1zzle presents v1's interface, and `asDrizzleRelations`
prototypes onto v1's `OneV2` / `ManyV2`. On v0 it would prototype onto the wrong classes.
Verified against rc.1 and rc.4.

There is no `eval`, no `new Function` and no `child_process` in either package, and `src/`
uses no Node builtins.

## D1 limits, and where each is enforced

Checked while compiling, because compilation happens once per isolate and already walks
the query:

| Limit | Value | Handling |
| --- | --- | --- |
| Bound parameters per statement | 100 | drives insert chunking and the `inArray` strategy; an error only where neither applies |
| SQL statement length | 100,000 bytes of text — bound parameters are sent separately | error naming `maxParams` as the lever |
| Arguments to one SQL function | 32 | error |
| `LIKE` / `GLOB` pattern | 50 bytes, when the pattern is a literal at the call site | error |
| Columns per table | 100 | checked at `sqliteTable(…)` |

Checked after execution, and only when `plan` is set: statements per Worker invocation and
database size (see
[Plan-dependent limits](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#plan-dependent-limits)).

Left to D1: maximum query duration (30 s), and maximum string / BLOB / row size
(2,000,000 bytes), which is a property of the values rather than of the query. A pattern
supplied through `ph()` is filled after compilation, so its length is left to D1 as well.

Verify the current values against
<https://developers.cloudflare.com/d1/platform/limits/> before relying on a specific
number; the ones above were last checked on 2026-07-27. Full table:
[docs/02](./docs/02-d1-platform.md#documented-limits).

## Scope

Supported: Cloudflare D1, on Workers.

Not supported, deliberately:

- **Other databases.** No Postgres, MySQL, better-sqlite3, `bun:sqlite`, or Durable Object
  SQLite. Supporting a second backend reintroduces the abstraction that the bundle-size
  difference above consists of. If you need portability, Drizzle is the answer.
- **Interactive transactions.** D1 has none.
- **A runtime migration engine.** Migrations are generated and applied by the CLI, never
  from inside a Worker.
- **Query result caching.** Workers have the Cache API and KV.
- **Runtime schema validation.** Zod and Valibot adapters would be a separate package.

## Documentation

The design is written down in [`docs/`](./docs/README.md):
[01-principles](./docs/01-principles.md) states the goals and the rules that break ties;
[02-d1-platform](./docs/02-d1-platform.md) is the platform description most decisions come
from, including the table of what the test suite observed against a real D1 database;
[11-security](./docs/11-security.md) states what the compiler guarantees, which three APIs
opt out of it, and why the relational `where` is a query language rather than an input
format;
[12-drizzle-differences](https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md)
is the long form of the differences table above.

## Development

```bash
npm install
npm test        # unit tests in Node, integration tests inside workerd against real D1
npm run check   # typecheck + build + tests + kit typecheck + kit build
```

Tests are in two layers, and the split is load-bearing: `test/unit/` and
`kit/test/unit/` run in Node and assert on compilation output; `test/workers/` and
`kit/test/workers/` run inside workerd against a real D1 binding, and every claim about
SQLite's actual behaviour lives there.

`d1zzle` and `d1zzle-migrate` are released together from one GitHub Release and published
to npm with trusted publishing (OIDC, no long-lived token) and provenance attestations.
`npm run version:set <version>` moves both packages and the kit's peer range together. See
[RELEASING.md](./RELEASING.md).

## Support and maintenance

This project is maintained, but it is not open to contributions. Those are two different
things, and the distinction is what matters when deciding whether to depend on it.

- **Pull requests are very unlikely to be merged**, and feature requests are very unlikely
  to be accepted. Reviewing a patch properly means owning it afterwards, and that is the
  part I (soya-miyoshi) cannot take on at the moment — so please do not spend an evening
  on a patch for this repository expecting it to land.
- **Issues are welcome, and a reply is not guaranteed.** A described bug or a reproduction
  is worth having written down; it helps anyone running a fork whether or not I answer.
- **The security of this software is not guaranteed.** It is written carefully and tested
  against a real D1 binding, and [11-security](./docs/11-security.md) documents what the
  compiler does and does not guarantee, but that is not a substitute for reviewing the copy
  you run, and no fix is promised on any timeline.

**If you intend to depend on this, fork it and maintain your own copy.** You take on the
risk and the maintenance deliberately, and the MIT license exists so that you can.
[CONTRIBUTING](./CONTRIBUTING.md) covers what a usable fork needs.

If funding or a volunteer maintainer appears, the contribution side of this can change.
That is not the situation today.

## License

MIT — see [LICENSE](./LICENSE). The warranty and liability clauses mean what they say.
