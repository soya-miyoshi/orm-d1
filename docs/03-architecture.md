# 03 — Architecture

## Layering

Four layers, each depending only on the one above it. No layer imports downward.

```
  schema/     table + column definitions. Pure data. No knowledge of SQL or D1.
     ↓
  plan/       immutable IR describing a query. No knowledge of D1.
     ↓
  compile/    IR → { sql, paramPlan, rowMapper }. No knowledge of D1. Pure, synchronous.
     ↓
  runtime/    the only layer that touches D1Database. Binds params, executes, maps rows.
```

The important property is that **everything above `runtime/` is pure and synchronous**.
Compilation can be unit-tested without workerd, snapshot-tested as SQL strings, and — for
hot paths — executed once at module init and reused forever.

## Data flow

```mermaid
flowchart LR
  S["schema<br/>table()/column()"] --> B["builder<br/>select().from().where()"]
  B --> P["plan (IR)<br/>immutable object graph"]
  P -->|compile, memoized| C["CompiledQuery<br/>sql · paramPlan · mapper"]
  C -->|bind| D["D1PreparedStatement"]
  D -->|.raw()| R["unknown[][]"]
  R -->|mapper| T["typed rows"]
  D -->|meta| O["onQuery hook<br/>rows_read / rows_written"]
```

The `plan → CompiledQuery` edge is the one that gets memoized. See
[05-query-compilation.md](./05-query-compilation.md).

## Module layout

As built:

```
src/
  index.ts              # root entry: core + relations + the schema-aware drizzle()
  core.ts               # lean entry: everything except relations (rule R5)
  sqlite-core.ts        # the Drizzle-named schema surface, for import aliasing
  drizzle.ts            # type-level bridge to drizzle-orm (type-only import)
  ddl.ts                # separate entry: schema → CREATE TABLE / CREATE INDEX
  errors.ts             # D1zzleQueryError, NoTransactionsError — the only `extends`
  dev.ts                # __DEV__ flag, header assertion, full-scan heuristic

  sql/
    sql.ts              # sql`` tag, SQLChunk, Query, ParamSlot, Placeholder, RenderContext
    expressions.ts      # eq ne gt gte lt lte and or not like inArray isNull between …
    functions.ts        # count sum avg min max coalesce, and the decode they carry

  schema/
    table.ts            # table()/sqliteTable(), alias(), subqueries, symbols
    columns.ts          # integer text real blob numeric boolean json customType
    constraints.ts      # index() uniqueIndex() primaryKey() foreignKey() unique() check()
    infer.ts            # InferSelect / InferInsert
    drizzle-entity.ts   # entityKind chain + Drizzle's symbols (see doc 10)

  plan/
    plan.ts             # IR node types (SelectPlan, InsertPlan, UpdatePlan, DeletePlan)
    compile.ts          # plan → CompiledQuery, including projection aliasing
    params.ts           # bindParams over the param plan
    mapper.ts           # flat and tree row mappers

  builders/
    root.ts             # db-less `query` root, for hoisted/compiled queries
    select.ts insert.ts update.ts delete.ts
    types.ts            # QueryExecutor, Runnable, BatchResult

  runtime/
    database.ts         # d1zzle()/drizzle(), db.select/insert/update/delete/batch/withSession
    session.ts          # Executor: the only code that touches D1Database
    result.ts           # D1Meta → QueryEvent

  relations/
    define.ts           # defineRelations(), One/Many, the r.<table>.<column> builder
    filter.ts           # the where object DSL -> our expressions
    query.ts            # RelationalQueryBuilder — findMany/findFirst/count
    index.ts            # entry point: typed db.query, withRelations()
```

Three files did not exist in the original plan and are worth naming:

- **`schema/drizzle-entity.ts`** is what makes the ecosystem work ([10](./10-ecosystem-interop.md)).
- **`core.ts`** exists because the root entry had to grow relations; see rule R5's note in
  [01](./01-principles.md#r5--optional-subsystems-live-behind-separate-entry-points).
- **`builders/types.ts`** holds the `QueryExecutor` interface that builders depend on, so
  `builders/` never imports `runtime/` and the layering above holds literally, not just by
  convention.

### Entry points

```jsonc
"exports": {
  ".":              { "types": "./dist/index.d.ts",           "default": "./dist/index.js" },
  "./core":         { "types": "./dist/core.d.ts",            "default": "./dist/core.js" },
  "./sqlite-core":  { "types": "./dist/sqlite-core.d.ts",     "default": "./dist/sqlite-core.js" },
  "./ddl":          { "types": "./dist/ddl.d.ts",             "default": "./dist/ddl.js" },
  "./relations":    { "types": "./dist/relations/index.d.ts", "default": "./dist/relations/index.js" },
  "./drizzle":      { "types": "./dist/drizzle.d.ts",         "default": "./dist/drizzle.js" }
}
```

| Entry | Why it exists |
| --- | --- |
| `.` | The drop-in surface. `drizzle({ client, relations })` returns `db.query`, so it reaches `relations/`. |
| `./core` | The same, minus relations. This is the entry rule R5 describes exactly. |
| `./sqlite-core` | Lets a project alias `drizzle-orm/sqlite-core` and change nothing else. |
| `./ddl` | Reached by neither of the above; the CLI and integration tests are its consumers. |
| `./relations` | `defineRelations()`, `db.query` and the filter DSL, for anyone who wants them without the root entry. |
| `./drizzle` | Type-only import of `drizzle-orm`; contributes nothing at runtime. |

The plan was to enforce the boundaries in CI by building each entry in isolation against a
size budget. **That check is not built yet** — see [07](./07-roadmap.md). Until it is, the
boundaries are held by review, which is exactly the arrangement the original text warned
about.

## Public API

### Schema

```ts
import { integer, sqliteTable, text } from 'd1zzle';   // `table` is the native alias

export const users = sqliteTable('users', {
  id: integer().primaryKey(),
  email: text().notNull(),
  name: text(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

export type User = InferSelect<typeof users>;
export type NewUser = InferInsert<typeof users>;
```

The property key is the TypeScript-facing name; the optional string argument is the
database column name. Omitting it means they are the same (subject to the `casing` option).

### Queries — the ergonomic path

```ts
import { drizzle, eq } from 'd1zzle';   // `d1zzle` is the same function

export default {
  async fetch(req: Request, env: Env) {
    const db = drizzle(env.DB);

    const all  = await db.select().from(users);
    const one  = await db.select().from(users).where(eq(users.id, 1)).get();
    const some = await db.select({ id: users.id, email: users.email }).from(users).limit(10);

    await db.insert(users).values({ email: 'a@b.c' });
    await db.update(users).set({ name: 'x' }).where(eq(users.id, 1));
    await db.delete(users).where(eq(users.id, 1));
  },
};
```

Builders are **immutable and lazy**. Each chained call returns a new builder; nothing runs
until `.all()`, `.get()`, `.run()`, or `await` (builders are `PromiseLike`, defaulting to
`.all()`).

### Queries — the hot path

Because compilation is pure and db-independent, a query can be compiled once at module
scope and reused for the isolate's lifetime:

```ts
import { query, ph, eq } from 'd1zzle';

const getUserByEmail = query
  .select()
  .from(users)
  .where(eq(users.email, ph('email')))
  .compile();          // → CompiledQuery, no D1 binding involved

export default {
  async fetch(req: Request, env: Env) {
    const db = d1zzle(env.DB);
    const user = await db.get(getUserByEmail, { email: 'a@b.c' });
  },
};
```

This exists because **Worker bindings live on `env`, which is only available per-request**,
so `db` itself usually cannot be hoisted. Separating "what the query is" from "which
database runs it" is what makes module-scope compilation possible at all. It also makes
compilation unit-testable without a runtime.

(If you use `import { env } from 'cloudflare:workers'`, `db` *can* be hoisted, and a
hoisted ergonomic builder memoizes its own compilation just as well. Both paths work; the
`query` root is the one that always works.)

### Batch — the atomic primitive

```ts
const [inserted, posts] = await db.batch([
  db.insert(users).values({ email: 'a@b.c' }).returning(),
  db.select().from(posts).where(eq(posts.authorId, 1)),
]);
```

One round trip, all-or-nothing, result tuple typed per statement. This replaces
`transaction()`, which d1zzle deliberately does not provide
([02](./02-d1-platform.md#no-interactive-transactions)).

### Sessions

```ts
const s = db.withSession('first-unconstrained');
const rows = await s.select().from(users);
const bookmark = s.bookmark();   // stash in a cookie for read-your-writes
```

### Relational queries

Passing `relations` turns on `db.query` and the `db._` metadata that Drizzle's ecosystem
reads. This is the one place the root entry costs more than `d1zzle/core`.

```ts
const db = drizzle({ client: env.DB, relations });

const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: { posts: { where: { views: { gt: 100 } } } },
});
```

See [06](./06-runtime.md#relational-queries) for the fetch strategy and why it is the one
that shipped.

## Bundle discipline

Concrete rules, and their state as built:

| Rule | Enforcement | State |
| --- | --- | --- |
| Zero runtime dependencies | `"dependencies": {}` | Holds. `drizzle-orm` is an optional peer reached only by `d1zzle/drizzle` — for types by `asDrizzleSchema`/`asDrizzleTable`, and for `One`/`Many` at runtime by `asDrizzleRelations`. No other entry point imports it, so the main entry stays dependency-free. |
| No class hierarchy deeper than 1 | review | One exception: the `entityKind` chain in `schema/drizzle-entity.ts` ([10](./10-ecosystem-interop.md)). |
| No runtime entity-kind registry | structural checks via symbols | Holds — with the twist that we now publish Drizzle's symbols on purpose. |
| Diagnostics behind `__DEV__` | build replaces with `false` | Holds; `dev.ts` falls back to an explicit opt-in when no replacement happens. |
| Core entry ≤ 20 KB min | size budget in CI | **Not enforced.** The budget is unbuilt, so the number is unverified. |
| No `eval` / `new Function` | lint rule; also a hard Workers constraint | Holds. Mappers are loops over precomputed arrays. |

## What is deliberately absent

- `transaction()` / savepoints — D1 cannot honour them.
- A dialect abstraction — there is one target.
- A logger class hierarchy — one optional `onQuery` callback.
- A result cache — Workers already have Cache API and KV.
- Runtime type validation of rows — trust the schema; validate at the edge if you need to.
