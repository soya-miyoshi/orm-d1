# 12 — Differences from drizzle-orm on D1

Each item below states the case, what `drizzle-orm@1.0.0-rc.4` does on D1, and what d1zzle
does. The Drizzle behaviour is read from that version's `d1/session.js`,
`sqlite-core/async/*.js` and `sql/expressions/conditions.js`.

The differences all come from the same four properties of D1: the database is reached over
the network, so cost tracks the number of calls; a statement accepts at most 100 bound
parameters; `batch()` is the only atomicity available, because there are no interactive
transactions; and Worker startup CPU is billed, so library size is a per-request cost on
cold isolates. Each section names the property it depends on. The platform description
they are drawn from is [02](./02-d1-platform.md), which also records what the suite
observed running inside workerd against a real D1 binding.

## Contents

- [Inserting more rows than one statement can carry](#inserting-more-rows-than-one-statement-can-carry)
- [Matching a column against a long list](#matching-a-column-against-a-long-list)
- [Grouping writes so that they all succeed or all fail](#grouping-writes-so-that-they-all-succeed-or-all-fail)
- [A joined select inside `batch()` that projects two columns with the same name](#a-joined-select-inside-batch-that-projects-two-columns-with-the-same-name)
- [Reading from a replica, and reading your own writes](#reading-from-a-replica-and-reading-your-own-writes)
- [Seeing what a query cost](#seeing-what-a-query-cost)
- [Building a query once per isolate instead of once per request](#building-a-query-once-per-isolate-instead-of-once-per-request)
- [D1's other limits](#d1s-other-limits)
- [Plan-dependent limits](#plan-dependent-limits)
- [Bundle size](#bundle-size)
- [D1 limits, and where each is enforced](#d1-limits-and-where-each-is-enforced)

## Inserting more rows than one statement can carry

```ts
await db.insert(users).values(rows);   // rows.length === 500, 4 columns each
```

**Drizzle** renders one `insert` with 2,000 bound parameters. D1 rejects the statement:
`D1_ERROR: too many SQL variables`. There is no chunking in the SQLite insert builder, so
the caller has to split the array and give up all-or-nothing behaviour across the pieces.

**d1zzle** computes `floor(100 / 4) = 25` rows per statement at compile time, produces 20
statements, and submits them as one `batch()`. That is one round trip, and the batch is
atomic, so a conflict in the last chunk inserts nothing. `.returning()` rows come back
concatenated in input order.

A single row wider than the budget cannot be chunked at all, so it fails during
compilation instead of at D1:

```
A row of 120 columns exceeds the bound-parameter limit of 100; no chunking can satisfy
it. Insert fewer columns per statement.
```

## Matching a column against a long list

```ts
await db.select().from(users).where(inArray(users.id, ids));   // ids.length === 201
```

**Drizzle** binds one parameter per value — `in (?, ?, ?, …)` — so any list longer than
100 fails at D1.

**d1zzle** switches strategy once the list reaches `jsonEachThreshold` (30 by default) and
the values are representable as JSON. The list travels as a single bound parameter:

```sql
select "users"."id" from "users" where "users"."id" in (select "value" from json_each(?))
```

Below the threshold, or for `blob` values that have no JSON spelling, the values are bound
individually as before. If that would exceed the budget, compilation fails with a message
naming the call and the reason it could not collapse, rather than leaving you with
`too many SQL variables` and no indication of which `inArray` produced it.

## Grouping writes so that they all succeed or all fail

**Drizzle** exposes `db.transaction()` on its D1 driver, implemented by running `begin`,
the callback's statements, and then `commit` or `rollback` as ordinary separate statements.
It type-checks and usually appears to work. What it does not do is group the statements:
D1 does not guarantee that consecutive statements reach the same connection, so the `begin`
can apply to a connection none of the writes use, and each write commits by itself. When
the third of five writes fails, the first two stay applied and the `rollback` has nothing
to undo.

**d1zzle** does not provide `transaction()`. Calling it throws immediately:

```
d1zzle does not provide transaction(). D1 has no interactive transactions: statements in
a session are not guaranteed to land on the same connection, so an emitted BEGIN may
apply elsewhere. Use db.batch([...]) instead — it is atomic and takes one round trip.
```

`batch()` takes a tuple of statements and returns a tuple of results with per-statement
types:

```ts
const [inserted, posts] = await db.batch([
  db.insert(users).values({ email: 'a@b.c' }).returning(),
  db.select().from(postsTable).where(eq(postsTable.authorId, 1)),
]);
```

The atomicity is D1's, asserted against a real binding: in a batch whose second statement
violates a unique constraint, the first statement leaves zero rows.

Removing `transaction()` also removes the transaction and savepoint code from the bundle.

## A joined select inside `batch()` that projects two columns with the same name

```ts
await db.batch([
  db.select({ userId: users.id, postId: posts.id }).from(users).innerJoin(posts, …),
]);
```

D1's `batch()` has no positional read mode; it returns one object per row, keyed by column
name, and two columns named `id` occupy one key.

**Drizzle** converts those objects back to arrays with `Object.keys(row).map(k => row[k])`.
Drizzle's own source comments the function: *"It may cause issues with duplicated column
names in join queries."* By the time the object exists, one of the two values is gone.

**d1zzle** knows the projection while compiling, detects the collision then, and emits
generated aliases (`c0`, `c1`, …) for the colliding columns only, so the returned keys are
unique. Outside `batch()` both libraries read positionally through `.raw()`, where the
problem does not arise; d1zzle additionally checks the returned column names against the
compiled projection in development builds.

## Reading from a replica, and reading your own writes

**Drizzle** has no D1 session API — `withSession` does not appear anywhere in the package.
Using replicas means calling the binding directly and leaving the query builder behind.

**d1zzle** returns the same database API from `withSession()`, with `bookmark()` added:

```ts
const bookmark = req.headers.get('Cookie')?.match(/d1_bookmark=([^;]+)/)?.[1];
const session = db.withSession(bookmark ?? 'first-unconstrained');

const rows = await session.select().from(users);
await session.insert(users).values({ email: 'a@b.c' });

res.headers.set('Set-Cookie', `d1_bookmark=${session.bookmark()}; Path=/; HttpOnly`);
```

Writes made through the session are visible to later reads through it. Passing the
bookmark back on a later request resumes that consistency point. `db.query` is attached to
sessions as well, so relational queries can be served from a replica.

## Seeing what a query cost

D1 returns `rows_read` and `rows_written` on every response. These are the billed units.

**Drizzle** offers a `logger` that receives the SQL and its parameters. For selects it
reads through `.raw()`, which returns rows only, so the metadata is not available to the
caller; `run()` returns D1's result object, so writes keep it.

**d1zzle** takes an `onQuery` callback, called once per executed statement — including
every member of a `batch()` and every chunk of a chunked insert, which is how D1 counts
them too:

```ts
const db = drizzle(env.DB, {
  onQuery: (e) => {
    if (e.rowsRead > 1000) console.warn(`${e.rowsRead} rows read: ${e.sql}`);
  },
});
```

The event carries `rowsRead`, `rowsWritten`, `durationMs` (measured around the call, so it
includes the network), `d1DurationMs` and `sqlDurationMs` (D1's own, server-side),
`servedByPrimary`, `servedByRegion` and `attempts`. `durationMs - sqlDurationMs` is the
network share.

Two costs. `.raw()` carries no metadata, so installing
`onQuery` switches selects to the keyed read path, which allocates one object per row —
which is why it is opt-in per database. And bound parameters are included only in
development builds, since they contain user data; `test/workers/integration.test.ts`
asserts that a production build omits them.

## Building a query once per isolate instead of once per request

**Drizzle**'s `.prepare()` is a method on a builder that already holds a session, and the
session holds the binding. On Workers the binding arrives with the request, so the SQL is
built inside `fetch`, on every request.

**d1zzle** separates compilation from execution. `query.select()` needs no binding, so a
query can be compiled at module scope and reused for the isolate's lifetime; values are
supplied through named placeholders:

```ts
import { drizzle, eq, ph, query } from 'd1zzle';

const byEmail = query.select().from(users).where(eq(users.email, ph('email'))).compile();

export default {
  async fetch(request: Request, env: Env) {
    const user = await drizzle(env.DB).get(byEmail, { email: 'a@b.c' });
  },
};
```

`db.all(compiled, input)`, `db.get(compiled, input)` and `db.run(compiled, input)` execute
a compiled query. Builders also memoise their own compilation, so a builder held in a
module-scope constant compiles once even without `compile()`.

## D1's other limits

**Drizzle** passes the statement to D1 and reports what comes back. SQLite's messages name
the constraint but not the call: `too many SQL variables` does not say which `inArray`,
and `too many arguments on function coalesce` does not say which `coalesce`.

**d1zzle** checks the limits that are knowable while compiling — which happens once per
isolate and already walks the whole query — and names the lever:

```
A statement of 186040 characters exceeds D1's 100000-byte limit on SQL text. Bound
parameters do not count toward it, so this is statement text: a very wide insert, or a
large sql.raw(…) fragment. Lower maxParams (currently 100000) to chunk into shorter
statements, or shorten the fragment.
```

The full list, and the limits deliberately left to D1, are in
[D1 limits, and where each is enforced](#d1-limits-and-where-each-is-enforced) below.

## Plan-dependent limits

Two limits differ between the free and paid plans, and neither can be evaluated until a
statement has already run. Passing `plan` turns on a development-only warning for each:

```ts
const db = drizzle(env.DB, { plan: 'free' });   // or 'paid'
```

| | free | paid |
| --- | --- | --- |
| Statements per Worker invocation | 50 | 1,000 |
| Database size | 500 MB | 10 GB |

The statement counter includes each member of a `batch()` separately, so batching reduces
round trips but not this count; the warning says so and suggests reducing the number of
statements instead. The size warning fires past 90% of the cap, read from `size_after`,
which D1 returns on every statement including reads.

Each warning fires at most once per database object. Counting is per database object and
shared with sessions derived from it, which is exact for the usual `drizzle(env.DB)`
inside `fetch` and over-counts for a database hoisted to module scope and reused across
requests — warning once is what keeps that case from being misleading, and the message
says so. Left unset, neither warning fires.

`plan` does not change the bound-parameter budget. That is 100 on both plans; `maxParams`
is the option that changes it.

## Bundle size

Bundling a Worker that imports the driver and the schema DSL and runs one
`select().from(users).where(eq(...))`, with esbuild, minified:

| | minified | gzipped |
| --- | --- | --- |
| `drizzle-orm/d1` + `drizzle-orm/sqlite-core` | 77.8 kB | 22.2 kB |
| `d1zzle` | 44.1 kB | 15.3 kB |
| | −43% | −31% |

Drizzle ships 25 MB across 718 export paths with `sideEffects: false`, and tree-shaking
removes about 97% of it before it reaches a bundle. The remaining difference is code that
is reachable from the SQLite entry point and therefore cannot be dropped by a bundler: the
dialect indirection, the transaction and savepoint subsystem, and the prepared-statement
abstractions that cover both synchronous and asynchronous drivers. d1zzle does not contain
them.

On Workers the minified column is the relevant one, because startup CPU is billed and
parse time tracks uncompressed bytes; the 3 MB / 10 MB compressed limits are not a
constraint for a library of this size.

These two numbers come from a one-off measurement, not from a tracked harness — the
project's own design rules call that out as an outstanding gap. The size claim that *is*
tested is which library ends up in the bundle, in
`test/unit/module-resolution.test.ts`; see
[15-migrating-from-drizzle](./15-migrating-from-drizzle.md).

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
database size (see [Plan-dependent limits](#plan-dependent-limits)).

Left to D1: maximum query duration (30 s), and maximum string / BLOB / row size
(2,000,000 bytes), which is a property of the values rather than of the query. A pattern
supplied through `ph()` is filled after compilation, so its length is left to D1 as well.

Verify the current values against
<https://developers.cloudflare.com/d1/platform/limits/> before relying on a specific
number; the ones above were last checked on 2026-07-27. Full table:
[02-d1-platform](./02-d1-platform.md#documented-limits).

## What is not a difference

The schema DSL, the query builder, the inferred types and the `db.query` interface are
Drizzle's. What each supported symbol means, and the list of what is deliberately absent,
is [08-drizzle-compatibility](./08-drizzle-compatibility.md); how Drizzle's own adapters
still recognise a d1zzle table is [10-ecosystem-interop](./10-ecosystem-interop.md).
