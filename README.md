# d1zzle

*("dee-one-zzle" — D1, with Drizzle's ergonomics.)*

A type-safe ORM built **exclusively** for Cloudflare D1 and Workers.

It takes its API from Drizzle — the same schema DSL, the same query builder, the same
inferred types — and drops everything that only exists to support other databases. What is
left is tuned for the one platform it targets: D1's positional read path, its
bound-parameter limit, its Sessions API, and its billing counters.

```bash
npm install d1zzle
npm install -D d1zzle-migrate
```

```ts
import { drizzle, eq } from 'd1zzle';
import { integer, sqliteTable, text } from 'd1zzle';

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

## Built for one database, and it shows

Targeting a single platform buys two things: everything that exists only to abstract over
other databases is gone, and everything D1 offers that other databases have no analogue for
can be first class.

**Smaller.** Bundling an equivalent Worker — driver, schema DSL, and one
`select().from(users).where(eq(...))` — with esbuild, minified:

| | minified | gzipped |
| --- | --- | --- |
| `drizzle-orm/d1` + `drizzle-orm/sqlite-core` | 77.8 kB | 22.2 kB |
| `d1zzle` | 44.1 kB | 15.3 kB |
| | **−43%** | **−31%** |

To be fair to Drizzle: it is *not* a bloated package. It ships 25 MB across 718 export
paths with `sideEffects: false`, and tree-shaking drops ~97% of that before it reaches your
bundle. The difference is that tree-shaking removes what is unreachable, not what is
generic — the dialect indirection, the session and transaction/savepoint subsystem, and the
prepared-statement abstractions covering both sync and async drivers are all reachable from
the SQLite entry, so no bundler can drop them. d1zzle removes them at the source. That is
the whole 43%: portability has a floor, and the only way under it is to give up
portability.

On Workers the minified column is the one to watch. Startup CPU is billed and parse time
tracks uncompressed bytes, so the 3 MB / 10 MB compressed limits are never the binding
constraint for an ORM.

**And D1-shaped, not SQLite-shaped.** Each of these exists because of a specific property
of D1, and would be hard to justify in a portable ORM:

| | why D1 makes it necessary or possible |
| --- | --- |
| Positional `.raw()` reads | `.all()` builds one keyed object per row and **silently collides duplicate column names** in joins |
| `batch()` as the atomic primitive | it is D1's *only* atomicity guarantee, and one round trip |
| No `transaction()` | D1 has no interactive transactions; a `BEGIN` may land on another connection |
| Automatic insert chunking | the ~100 bound-parameter cap has no analogue in server-side SQLite |
| `inArray` → `json_each` | collapses a long list to **one** parameter instead of N |
| Sessions and bookmarks | D1's read replication has no analogue in a Postgres or MySQL driver |
| `rows_read` / `rows_written` | D1's **billing units**, free on every response, and usually discarded |
| Compile-once-per-isolate | module scope persists across requests in a Worker isolate |
| Plan-aware limits | the free and paid plans differ, and only the caller knows which they are on |

## Plans and limits

D1's limits are enforced where they can be, rather than left to arrive as bare SQLite
errors. Which mechanism applies depends on when the limit becomes knowable.

**Compile time**, because compilation happens once per isolate and already walks the query,
so the check is free and the message can name the offending call:

| limit | value |
| --- | --- |
| Bound parameters per query | 100 — drives chunking rather than erroring, where it can |
| SQL statement length | 100,000 bytes of *text*; bound parameters do not count |
| Arguments per SQL function | 32 |
| `LIKE` / `GLOB` pattern | 50 bytes, when the pattern is a literal |
| Columns per table | 100, checked at `sqliteTable(…)` |

The point is the message. `too many SQL variables` does not tell you which `inArray`
produced it; a compile error does.

**Runtime, and opt-in**, for the two limits that differ by plan. Neither can be known until
a statement has already run, so they are dev-only warnings:

```ts
const db = drizzle(env.DB, { plan: 'free' });   // or 'paid'
```

| | free | paid |
| --- | --- | --- |
| Queries per Worker invocation | 50 | 1,000 |
| Database size | 500 MB | 10 GB |

The query counter includes **every member of a `batch()` individually**, which is how D1
counts them — so batching is the fix for round trips, not for this limit. The size warning
fires once past 90% of the cap, read from `meta.size_after`, which D1 returns on every
statement including reads. Both warn **once**: past the line every subsequent statement is
also past it.

Counting is per database object, and shared with any session `withSession()` derives, since
the limit belongs to the invocation rather than the session. That is exact for the usual
`drizzle(env.DB)`-inside-`fetch` shape and over-counts for a database hoisted to module
scope — warning once is what keeps that case from being misleading, and the message says so.

Left unset, neither warning fires: guessing would either cry wolf on a paid database or stay
silent on a free one, and nothing in the binding reveals the plan.

Note that `plan` does **not** change the bound-parameter budget. That is 100 on both plans;
`maxParams` remains the way to change it. See
[docs/02](./docs/02-d1-platform.md#documented-limits) for the full table, including the
limits deliberately left to D1.

## Migrating from Drizzle

Change the import specifier. That is the whole migration:

```diff
- import { drizzle } from 'drizzle-orm/d1';
- import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
+ import { drizzle, sqliteTable, text, integer } from 'd1zzle';
```

For a **zero-diff** migration, alias the modules instead of editing files:

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

**Point at the `.js`, not the `.d.ts`.** This is the detail that matters, and getting it
wrong fails *silently* — your build succeeds, your types are d1zzle's, your editor is
happy, and your Worker runs on `drizzle-orm`. esbuild (wrangler's bundler) honours `paths`
for real module resolution, but it cannot bundle a declaration file, so it falls through to
node resolution and finds the real `drizzle-orm` — which is installed by definition, since
you are migrating off it. TypeScript picks up the sibling `.d.ts` from the `.js` path on
its own, so types are unaffected.

Set `baseUrl` as well. A relative `./node_modules/…` path resolved without it depending on
the bundler's working directory, and `baseUrl` removes the ambiguity.

Measured on the recipe above, bundling a two-import Worker:

| `paths` target | bundle | contains |
| --- | --- | --- |
| `dist/index.d.ts` | 175 kb | `drizzle-orm` — the mapping did nothing |
| `dist/index.js` | 81 kb | d1zzle |

`test/unit/module-resolution.test.ts` bundles that fixture and asserts it, because nothing
else in the suite exercises resolution.

(These two numbers are unminified, and are here to show *which library ended up in the
bundle* rather than to size it — the minified comparison is
[above](#built-for-one-database-and-it-shows).)

Supported unchanged: `sqliteTable` · every column type and `mode` · `.notNull()`
`.primaryKey({ autoIncrement })` `.default()` `.$defaultFn()` `.$onUpdate()` `.$type<T>()`
`.references()` `.unique()` `.generatedAlwaysAs()` · `index()` `uniqueIndex()`
`primaryKey()` `foreignKey()` `unique()` `check()` · both table-extras forms · the `sql`
tag · the comparison and aggregate operators · `defineRelations()` and `db.query` ·
`InferSelectModel` / `InferInsertModel`.

d1zzle presents **Drizzle v1's** interface: `defineRelations`, the RQBv2 `db.query`
config, and v1's `getTableConfig` shape. The v0 `relations()` API is not supported.

Not supported, deliberately: **`transaction()`**. D1 has no interactive transactions, so
d1zzle's `transaction()` throws with a pointer to `batch()`, which *is* atomic. See
[docs/02](./docs/02-d1-platform.md#no-interactive-transactions).

## Works with the Drizzle ecosystem

A d1zzle schema is not merely similar to a Drizzle schema — Drizzle's own code recognises
it. Tables are instances of classes whose `entityKind` chain matches Drizzle's, and they
carry Drizzle's symbols, so this all works on d1zzle objects:

```ts
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteInteger, SQLiteTable } from 'drizzle-orm/sqlite-core';

is(users, SQLiteTable);   // true
is(users.id, SQLiteInteger); // true
getTableColumns(users);   // { id, email, name }
```

`defineRelations` produces the same plain `{ table, name, relations }` record Drizzle v1
does, and `db._.relations` is what adapters read. Drizzle `SQL` fragments built over
d1zzle columns — `eq(users.id, 1)`, `inArray(...)`, `sql\`…\`` — render correctly inside
a d1zzle query, which is how an adapter's own predicates reach the database.

**Verified against `@pothos/plugin-drizzle`.** `test/workers/pothos.test.ts` runs a real
GraphQL schema over a d1zzle database inside workerd, resolving nested lists and
`select`-level extras. Two things it needs:

```ts
import type { PothosRelations } from 'd1zzle/drizzle';
import { asPothosRelations } from 'd1zzle/drizzle';
import { getTableConfig } from 'd1zzle';           // ours, not drizzle-orm/sqlite-core's

const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof relations> }>({
  plugins: [DrizzlePlugin],
  drizzle: { client: db, getTableConfig, relations: asPothosRelations(relations) },
});
```

- **`getTableConfig`** must be ours. Drizzle's derives constraints by *running* a table's
  `ExtraConfigBuilder`, which a d1zzle table does not have, so on our tables it reports
  the columns and every other field empty — and the plugin cannot find a composite
  primary key. Ours reads our own constraint records. The plugin takes `getTableConfig`
  from its own config, so this substitution is all that is needed.
- **`asPothosRelations`** re-prototypes the relations onto Drizzle's `One`/`Many`. The
  plugin is duck-typed everywhere except `relationField instanceof Many`, which decides
  whether a field is a GraphQL list; `instanceof` consults the right-hand constructor, so
  no structural match can satisfy it. Without this, every `many` resolves as a single
  object. It is `asDrizzleRelations` doing the same work, typed as `PothosRelations` so the
  value lines up with the generic.

`asDrizzleSchema` / `asDrizzleTable` are **identity at runtime** — the objects already
satisfy every check Drizzle makes of them. They exist because Drizzle's `Column` class
declares a `protected` member, and TypeScript only accepts protected members from the same
declaration, so no independent implementation can be assignable to it. `asDrizzleSchema`
computes the equivalent Drizzle types from the metadata each column already carries;
`test/unit/drizzle-types.test.ts` asserts that `InferSelectModel` / `InferInsertModel`
applied to the result match our own inference field for field.

`asDrizzleRelations` is the exception: it is the one export that does real work and the one
that needs `drizzle-orm`'s classes at runtime, for the `instanceof` reason above.

**Pothos' types are not opted out of.** Earlier versions of this README said
`DrizzleRelations: never` was permanent, on the grounds that Pothos' generic slots against
`TablesRelationalConfig`, whose `table` is Drizzle's `Table` class. That was wrong. The
protected-member rule applies to Drizzle's `Column`/`Table` *classes*, but v1's
`TableRelationalConfig` asks only for `{ table; name; relations }`, and its `table` is
`SchemaEntry` — `Table<any> | View<…>` — which `ToDrizzleTable` already produces. Nothing
in that interface is ever compared nominally, so `PothosRelations<typeof relations>` fills
the slot outright.

What that buys is the whole GraphQL layer back under compile-time checking. The typing is
genuine rather than vacuous, and `test/unit/pothos-types.test.ts` pins it with negative
controls — an unknown column, an unknown property on a resolver's row, a resolver whose
return type disagrees with its field, and an undeclared relation name are each rejected:

```ts
t.exposeString('nope_not_a_column')          // rejected
t.string({ resolve: (row) => row.notAColumn })  // rejected
t.boolean({ resolve: (row) => row.title })   // rejected — string vs boolean
t.relation('definitely_not_a_relation')      // rejected
```

`client` and `getTableConfig` still take casts — those slot against Drizzle's own database
and table *classes*, which are subject to the protected-member rule. `relations` and every
builder call above it are checked.

## Better Auth

[Better Auth](https://www.better-auth.com) runs on d1zzle directly — `d1zzle/better-auth`
is a native adapter, not a shim over the Drizzle one:

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

Write the four tables with `sqliteTable` as you would any other — the schema in Better
Auth's Drizzle docs ports over unchanged — and generate the migration with
`d1zzle-migrate`. Model names map to tables through `schema`; field names map to columns
through Better Auth's own `fields` option, so `fields: { image: 'avatarUrl' }` reaches an
`avatar_url` column with nothing extra on our side.

**Why a separate adapter rather than the Drizzle one.** Everything under *Works with the
Drizzle ecosystem* above is about being **read**: an adapter inspects a schema, and
d1zzle's objects answer the way Drizzle's would. Better Auth's Drizzle adapter instead
**executes** through drizzle-orm — `db.insert(t).values(…)`, `eq()`, `and()`, its dialect
and session layer. `asDrizzleSchema()` retypes a schema; it cannot retype a runtime, and a
d1zzle table fails there on the first write. But Better Auth does not require that path:
`createAdapterFactory` takes ten methods over `{ model, where, data }` and supplies the
mapping, id generation and transforms itself. That is the seam, and it needs no Drizzle at
all.

**Single-statement `consumeOne` / `incrementOne`.** Better Auth's fallbacks for these are
built on transactions, which [D1 does not have](./docs/02-d1-platform.md), so a fallback
would leave a read-then-write gap in exactly the operations whose whole point is that only
one caller wins — consuming a verification token, decrementing a guarded counter. Both are
implemented instead as one `RETURNING` statement pinned to a single row, which D1 executes
atomically. `test/workers/better-auth.test.ts` races them against real D1 and asserts the
counts.

`experimental.joins` is not supported (the adapter raises a named error rather than quietly
dropping the joined models), and there is no `createSchema` for `@better-auth/cli generate`
— in a d1zzle project the schema file is what `d1zzle-migrate` diffs against, so generating
it from Better Auth's model list would invert the source of truth. `better-auth` is an
optional peer; see [docs/10](./docs/10-ecosystem-interop.md#better-auth--where-the-bridge-stops-being-the-answer).

## What is different, and why

**Reads are positional.** D1's `.all()` builds one keyed object per row, and silently
collides duplicate column names in joins. d1zzle knows the projection at compile time, so
it reads `.raw()` and maps by index. Inside `batch()`, where `raw()` is unavailable,
colliding projections are aliased `c0…cN` at compile time.

**A query compiles once per isolate, not once per request.** Builders are immutable and
memoise their own compilation. Because compiling needs no database, a query can be built at
module scope and reused for the isolate's lifetime:

```ts
import { eq, ph, query } from 'd1zzle';

const byEmail = query.select().from(users).where(eq(users.email, ph('email'))).compile();

export default {
  async fetch(request: Request, env: Env) {
    const user = await drizzle(env.DB).get(byEmail, { email: 'a@b.c' });
  },
};
```

**`batch()` is the atomic primitive.** One round trip, all-or-nothing, tuple-typed results:

```ts
const [inserted, posts] = await db.batch([
  db.insert(users).values({ email: 'a@b.c' }).returning(),
  db.select().from(postsTable).where(eq(postsTable.authorId, 1)),
]);
```

**Bulk inserts are chunked for you.** D1 caps bound parameters per statement (~100), so a
500-row insert is compiled into several statements and submitted as one `batch()` — still
atomic, still one round trip, with `.returning()` results concatenated in order.

**Sessions are first class.** D1's read replication has no analogue in other drivers:

```ts
const session = db.withSession(bookmark ?? 'first-unconstrained');
const rows = await session.select().from(users);
response.headers.set('Set-Cookie', `d1_bookmark=${session.bookmark()}; Path=/; HttpOnly`);
```

**Billing units are surfaced.** `rows_read` / `rows_written` are what D1 charges for:

```ts
const db = drizzle(env.DB, {
  onQuery: (event) => {
    if (event.rowsRead > 1000) console.warn(`${event.rowsRead} rows read: ${event.sql}`);
  },
});
```

Parameters are never included outside `__DEV__` — query logs end up where query logs end up.

**D1's other limits are compile errors, not SQLite errors**, and the two that differ by
plan are opt-in dev warnings. See [Plans and limits](#plans-and-limits) above.

## Relational queries

```ts
import { defineRelations, drizzle } from 'd1zzle';

export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}));

const db = drizzle({ client: env.DB, relations });

const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: { posts: { columns: { title: true }, where: { views: { gt: 100 } } } },
  orderBy: { id: 'desc' },
  limit: 10,
});
```

The join is stated once, with `from`/`to` on either side; the opposite side picks it up.
`optional: false` on a `one` promises the row is there, which takes `| null` off the
inferred type.

`where` is an object DSL. A bare scalar means `eq`, so `{ id: 1 }` is `{ id: { eq: 1 } }`.
Beyond the per-column operators (`eq` `ne` `gt` `gte` `lt` `lte` `in` `notIn` `like`
`ilike` `notLike` `notIlike` `isNull` `isNotNull`) there are `AND` / `OR` / `NOT`, a `RAW`
escape hatch, and **relation keys** — `{ posts: { views: { gt: 100 } } }` filters users by
their posts as a correlated `exists`, in the parent's own query.

```ts
const db = drizzle({ client: env.DB, relations });   // primary form
const db = drizzle(env.DB, { relations });           // binding-first, also fine
```

### How a `with` is executed

Two plans, chosen with `relationalStrategy`. Both return identical results — the
workers suite runs a matrix of queries through each and deep-compares them against a
real D1 database — so this is a performance switch and nothing else.

```ts
const db = drizzle({ client: env.DB, relations });                              // 'split' (default)
const db = drizzle({ client: env.DB, relations, relationalStrategy: 'joined' });
```

**`'split'`** runs one query per relation level and stitches the rows in JS. Levels cost
round trips; rows do not — two parents or two thousand, a level is still one query with an
`IN`, which collapses to `json_each` past the bound-parameter budget.

```sql
select "id", "email" from "users"
select "id", "title" from "posts" where "author_id" in (?, ?)
```

**`'joined'`** answers the whole tree in one statement, each relation a correlated
subquery wrapped in `json_group_array` / `json_object` — the shape Drizzle v1 produces on
SQLite.

```sql
select "d0"."id",
  (select json_group_array(json_object('id', "id", 'title', "title"))
   from (select "d1"."id" as "id", "d1"."title" as "title"
         from "posts" as "d1" where "d0"."id" = "d1"."author_id") as "t") as "posts"
from "users" as "d0"
```

Neither dominates. Joined makes one call and runs the inner query once per outer row;
split makes one call per level and does one index scan each. Latency and row counts decide
it, so measure rather than assume — the default is split because its failure modes are all
visible.

Joined falls back to split, per query and silently, for anything it cannot express as a
correlated subquery:

| Falls back when | Why |
| --- | --- |
| a relation goes `through` a junction | needs a join inside the inner select |
| a relation payload holds a `blob` column | `json_object` rejects binary — *JSON cannot hold BLOB values* |
| a payload is wider than 63 keys | `json_object` costs 2 arguments per key against SQLite's 127-argument cap |
| a nested `limit`/`offset` is a placeholder | split cannot take one, and the strategy must not change which queries are legal |

Because SQLite has no `LATERAL`, this is a correlated subquery rather than the lateral
join Drizzle emits on Postgres. The two are equivalent here.

Many-to-many is declared with `.through()` on both ends:

```ts
articles: {
  tags: r.many.tags({
    from: r.articles.id.through(r.articleTags.articleId),
    to: r.tags.id.through(r.articleTags.tagId),
  }),
},
```

Children are fetched with split queries and stitched in JS — predictable `rows_read`, no
cap on how wide a child projection can be, and readable SQL in the log. Relations at the
same level are fetched concurrently, so the query's *depth* is what costs round trips. A
nested `limit`/`offset` is a page *per parent*, taken with a `row_number()` window so it
stays one query rather than one per parent.

## Entry points

| Import | Contents |
| --- | --- |
| `d1zzle` | schema, queries, runtime, relations |
| `d1zzle/core` | the same, minus relations — for the smallest possible bundle |
| `d1zzle/sqlite-core` | the Drizzle-named schema surface, for import aliasing |
| `d1zzle/ddl` | schema → `CREATE TABLE` / `CREATE INDEX` |
| `d1zzle/relations` | `defineRelations()`, `db.query`, the filter DSL |
| `d1zzle/drizzle` | the bridge to `drizzle-orm`: `asDrizzleSchema`, `asDrizzleRelations` |
| `d1zzle/better-auth` | `d1zzleAdapter()` — a Better Auth database adapter |

**Zero runtime dependencies**, and `"dependencies": {}` in `package.json`. `drizzle-orm`
and `better-auth` are optional peers, and each cost is confined to one entry point:

- `d1zzle`, `d1zzle/core`, `d1zzle/sqlite-core`, `d1zzle/ddl` and `d1zzle/relations` never
  import either one, at runtime or for types. A Worker that does not do adapter interop
  never loads them, and they can be absent from `node_modules` entirely.
- `d1zzle/drizzle` imports `drizzle-orm`'s **types** for `asDrizzleSchema` /
  `asDrizzleTable`, and its `One`/`Many` **classes** at runtime for `asDrizzleRelations`.
  Importing that module is what makes `drizzle-orm` required, which is why nothing else
  re-exports it — `d1zzle`'s own entry does not reach it.
- `d1zzle/better-auth` imports `createAdapterFactory` from `better-auth/adapters` at
  runtime. Same rule: nothing else reaches it, so only a project that calls
  `d1zzleAdapter()` needs `better-auth` installed.

The peer range is `>=1.0.0-rc.1`: d1zzle presents v1's interface, and `asDrizzleRelations`
prototypes onto v1's `OneV2`/`ManyV2` classes. On v0 it would silently prototype onto the
wrong ones. Verified against rc.1 and rc.4.

## d1zzle-migrate

Migrations, introspection and drift detection — a devDependency that adds nothing to the
Worker bundle. See [kit/README.md](./kit/README.md).

```bash
npx d1zzle-migrate generate   # diff the schema against the last snapshot → a SQL migration
npx d1zzle-migrate migrate    # apply pending migrations (--local | --remote)
npx d1zzle-migrate check      # detect drift and unapplied migrations; non-zero exit for CI
```

## Documentation

The design is written down in [`docs/`](./docs/README.md) — start with
[01-principles](./docs/01-principles.md), then [02-d1-platform](./docs/02-d1-platform.md),
which is where most of the non-obvious decisions come from.

## Development

```bash
npm install
npm test        # unit tests in Node, integration tests inside workerd against real D1
npm run check   # typecheck + build + tests + kit typecheck + kit build
```

`d1zzle` and `d1zzle-migrate` are released together from one GitHub Release, published to npm
with trusted publishing (OIDC — no tokens) and provenance attestations. `npm run version:set
<version>` moves both packages and the kit's peer range in lockstep. See
[RELEASING.md](./RELEASING.md).

## License

MIT
