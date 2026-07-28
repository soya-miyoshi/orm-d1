# 06 — Runtime

The only layer that touches `D1Database`. Everything above it is pure.

## Entry point

```ts
export interface D1zzleOptions {
  /** Applied at compile time to column names that don't specify one explicitly. */
  casing?: 'preserve' | 'snake_case';
  /** Called after every executed statement, including each statement in a batch. */
  onQuery?: (event: QueryEvent) => void;
  /** Bound-parameter ceiling used for insert chunking and inArray strategy. */
  maxParams?: number;   // default 100
  /** Which Workers plan this database is on. Turns on two dev-only warnings. */
  plan?: 'free' | 'paid';
}

export function d1zzle(binding: D1Database, options?: D1zzleOptions): D1zzleDatabase;

/** Same function, Drizzle's name — the one-line migration. */
export const drizzle = d1zzle;
```

As built, `D1zzleOptions` also accepts `jsonEachThreshold`, and — on the root entry —
`schema`, which turns on `db.query` and `db._`. `logger` is accepted and ignored, so the
Drizzle setup line migrates without edits.

`plan` is the only option describing the *account* rather than the query. It exists
because exactly two D1 limits differ between the free and paid plans — statements per
Worker invocation and database size — and neither is knowable until a statement has
already run, which makes them warnings rather than compile errors. Everything else d1zzle
enforces is identical on both plans, `maxParams` included; `plan` is not a shorthand for
a parameter budget. Unset, neither warning fires. See
[02](./02-d1-platform.md#the-plan-option) for the counting rule and its one honest caveat.

`d1zzle(env.DB)` is called per request. It is a thin object literal over the binding — no
schema parsing, no registry construction — so per-request cost is one allocation. `plan`
adds one counter object to that, shared with any session derived from the database.

Note the asymmetry with Drizzle: `schema` is **optional**. Tables are imported and
referenced directly, so the query builder never needs a registry — which removes both the
setup step and the "table not in schema" class of runtime errors. Passing `schema` is only
required for the relational API, and for the ecosystem metadata on `db._`
([10](./10-ecosystem-interop.md)).

## Execution path

```ts
async function run(db: D1Database, q: CompiledQuery, input?: Record<string, unknown>) {
  const params = bindParams(q.params, input ?? {});
  const stmt = db.prepare(q.sql).bind(...params);

  if (q.kind === 'select') {
    const rows = await stmt.raw();          // positional — see doc 02
    return q.map(rows as unknown[][]);
  }
  const res = await stmt.run();
  return res;
}
```

`prepare()` is called per execution. It is a local object construction in workerd, not a
server round trip, so caching `D1PreparedStatement` objects across requests buys nothing
and risks holding a stale binding. **What we cache is the SQL string and the mapper, not
the statement.**

### The one trade-off this forces

`.raw()` returns rows and nothing else — **no `D1Meta`**. So a select can be read
positionally *or* reported on, not both. As built:

| Condition | Path |
| --- | --- |
| No `onQuery`, not `__DEV__` | `.raw()` + `map` — the fast path, no metadata |
| `onQuery` installed, or `__DEV__` | `.all()` + `mapKeyed` — one keyed object per row, full metadata |

Turning on observability costs the allocation it was meant to measure. That is an honest
trade rather than a hidden one, and it is why `onQuery` is opt-in per database rather than
always on. Under `__DEV__` the keyed path also asserts that the returned keys match the
compiled projection, which catches aliasing and index drift for free.

## Result mapping

| Path | D1 call | Shape | Mapper |
| --- | --- | --- | --- |
| direct select | `.raw()` | `unknown[][]` | `q.map` (positional) |
| select with `onQuery` or `__DEV__` | `.all()` | `Record<string, unknown>[]` | `q.mapKeyed` |
| select in `batch()` | `.batch()` | `Record<string, unknown>[]` | `q.mapKeyed` |
| insert/update/delete | `.run()` | `D1Result` | meta only, or `q.map` if `.returning()` |

The two mappers are both built at compile time; only one is ever called for a given
execution.

## `batch()`

```ts
async batch<T extends readonly Runnable[]>(items: T): Promise<BatchResult<T>> {
  const compiled = items.map((i) => i.compile());
  const stmts = compiled.map((c, n) =>
    this.binding.prepare(c.sql).bind(...bindParams(c.params, inputs[n])));
  const results = await this.binding.batch(stmts);
  return compiled.map((c, n) => c.kind === 'select'
    ? c.mapKeyed(results[n]!.results as Record<string, unknown>[])
    : results[n]!) as BatchResult<T>;
}
```

`BatchResult<T>` maps the input tuple to per-statement result types, so destructuring stays
typed. One round trip, all-or-nothing.

The real implementation carries one extra wrinkle: a statement whose compilation produced
several `parts` (a chunked insert) contributes several D1 statements, so the executor keeps
a span per input item and re-joins the results before mapping. A chunked insert inside a
batch therefore stays a single element of the result tuple.

## Multi-row inserts

D1 caps bound parameters per statement (~100 — verify against current limits). A 10-column
table therefore fits ~10 rows per statement. This is not an edge case; it is the ordinary
bulk-insert path, and it is exactly the kind of thing a portable ORM does not handle for
you.

```
rowsPerChunk = floor(maxParams / columnsPerRow)
```

If the input exceeds that, the compiler produces one statement per chunk and the runtime
submits them as a single `batch()` — preserving atomicity across chunks **and** keeping it
to one round trip. `.returning()` results are concatenated in order.

Two consequences worth documenting for users:

- A chunked insert is still atomic, because `batch()` is.
- `columnsPerRow > maxParams` is impossible to satisfy and throws at compile time with a
  clear message rather than failing at D1.

## Sessions and read replication

```ts
const s = db.withSession('first-unconstrained');  // or 'first-primary', or a bookmark
const users = await s.select().from(usersTable);
const bookmark = s.bookmark();                    // → stash in a cookie / DO
```

`withSession()` returns the same query API backed by a `D1DatabaseSession` instead of the
`D1Database`. Since both expose `prepare()` and `batch()` with identical signatures, the
execution layer is written against that intersection (`D1Target`) and needs no branching.

A session is the *same class* with `bookmark()` attached, not a subclass — composition
keeps rule R3 intact and means every method added to the database is available on a session
automatically, with no override to forget.

Read-your-writes across requests:

```ts
const bookmark = req.headers.get('Cookie')?.match(/d1_bookmark=([^;]+)/)?.[1];
const s = db.withSession(bookmark ?? 'first-unconstrained');
// … queries …
res.headers.set('Set-Cookie', `d1_bookmark=${s.bookmark()}; Path=/; HttpOnly`);
```

This is the piece with no analogue in Postgres or MySQL drivers, which is why a
dialect-agnostic ORM has nowhere natural to put it — and why making it a first-class,
typed API is one of the clearest wins available here.

## Observability

`D1Meta` arrives free on every response and contains the **billing units**. Throwing it
away, as most ORMs do, discards the most actionable signal D1 gives you.

```ts
interface QueryEvent {
  sql: string;
  kind: 'select' | 'insert' | 'update' | 'delete';
  tables: readonly string[];
  durationMs: number;        // meta.duration — includes network
  sqlDurationMs?: number;    // meta.timings?.sql_duration_ms — excludes network
  rowsRead: number;
  rowsWritten: number;
  servedByPrimary?: boolean;
  servedByRegion?: string;
  attempts?: number;         // > 1 means D1 auto-retried
  params?: readonly D1Param[];   // __DEV__ only — parameters routinely contain PII
}
```

Typical use:

```ts
const db = d1zzle(env.DB, {
  onQuery: (e) => {
    if (e.rowsRead > 1000) console.warn(`${e.rowsRead} rows read: ${e.sql}`);
  },
});
```

`durationMs - sqlDurationMs` is the network share, which is usually most of it — the number
that justifies optimizing round trips rather than string building.

Under `__DEV__` a default heuristic warns on likely full scans (high `rows_read` relative
to returned rows), which is the cheapest possible missing-index detector. It compiles out
of production builds entirely.

**Parameters are never included outside `__DEV__`.** They contain user data, and query logs
end up in places query logs end up. `test/workers/integration.test.ts` asserts this rather
than trusting it, because a leak here is silent.

`onQuery` fires once per statement, including each statement inside a `batch()` and each
part of a chunked insert, so the events add up to the bill.

## Errors

D1 throws `Error` with messages prefixed `D1_ERROR:`. The runtime wraps these:

```ts
export class D1zzleQueryError extends Error {
  readonly sql: string;
  readonly params?: readonly D1Param[];   // __DEV__ only
  override readonly cause: unknown;
}
```

The SQL text is always attached — it is not sensitive and it is what makes the error
actionable. Parameters follow the same PII rule as logging.

`errors.ts` is the one module permitted to use `extends` (rule R3): subclassing `Error` is
the only way to get `instanceof` working for consumers.

Every execution path wraps — direct, batched and chunked — so a failure inside a 10-part
insert still names the SQL that failed rather than reporting `D1_ERROR` with no context.

## Relational queries

Behind the `d1zzle/relations` entry point, and reachable from the root entry by passing
`schema`, so users who never touch it never parse it.

The design question is how to fetch a parent with its children. Two strategies:

**JSON aggregation** (one round trip): `json_group_array(json_array(...))` in a correlated
subquery, then `JSON.parse` the column. One RPC, but the SQL side does real work, the
payload is larger, and SQLite caps function arguments (~32), which bounds how wide a child
projection can be.

**Split queries** (two round trips): fetch parents, then fetch children by parent ids and
stitch in JS. Simpler SQL, predictable `rows_read`, no argument cap — but `batch()` cannot
express it, because statement N cannot reference statement N−1's results. So it is
genuinely two sequential RPCs.

**Split is the default.** The earlier draft of this document planned JSON aggregation as
the default, on the reasoning that a second round trip costs more than the JSON work — and
labelled that reasoning a hypothesis. Rule R7 says a hypothesis does not get to be the
default. Split's failure modes are all visible: `rows_read` is predictable, no function
argument cap constrains the projection, and the SQL in a log is readable.

**JSON aggregation is now implemented too**, as `relationalStrategy: 'joined'`
(`relations/joined.ts`). It is opt-in for exactly the reason above: it is still the
hypothesis, and R7 has not been discharged — no benchmark has run. What has been
established is that the two are *interchangeable*, which is what makes measuring them
cheap: a matrix of queries is run through both plans and deep-compared against a real D1
database, so switching cannot change results, only timing.

The function-argument cap the draft worried about is real and measured: `json_object`
costs two arguments per key against SQLite's 127, so **63 keys** is the ceiling for a
relation payload — 63 passes on D1, 70 does not. It is a fallback rather than an error;
so are a `blob` in a payload (`JSON cannot hold BLOB values`) and a junction relation.

One thing worth writing down, because it is load-bearing and undocumented in SQLite:
ordering inside `json_group_array` relies on the planner not flattening a subquery that
carries `ORDER BY` into the aggregate. It holds on D1 today and Drizzle depends on it too,
but it is not a guarantee SQLite makes in writing. If a nested `orderBy` ever comes back
unordered under `'joined'`, this is the reason.

What the implementation does do is **fetch relations at the same level concurrently**, so
the cost is the *depth* of the `with` tree, not the number of relations in it:

```ts
const rows = await db.query.users.findMany({
  columns: { id: true },
  with: {
    posts: { columns: { title: true }, with: { tags: true } },   // depth 3 → 3 round trips
    profile: true,                                               // fetched alongside posts
  },
});
```

Three details worth stating, because they are where a split implementation usually leaks:

- **Join keys are fetched whether or not you selected them**, and deleted from the rows
  before they are returned. `columns: { name: true }` gives you `{ name, posts }`, never a
  stray `id`.
- **A parent with no children gets `[]` for a `many` and `null` for a `one`** — never a
  missing key.
- **Children can be filtered independently of parents.** A `where` on a child narrows the
  children, not the parents, so a parent whose children all fail the predicate still comes
  back with an empty array.

A relation that omits `from`/`to` takes its join from the relation pointing the other way
— the usual spelling for a `many` side. That is unambiguous only when exactly one such
relation exists, so two relations between the same pair of tables have to be paired up by
giving both the same `alias`. All three failures — no relation back, more than one, and
neither side stating the join — are refused at `defineRelations` time, naming the relation
and both tables, rather than failing somewhere inside a query.

A nested `limit`/`offset` is a page **per parent**, taken with a `row_number()` window so
the whole level stays one query; fanning out per parent key would be an unbounded N+1
against a Workers subrequest limit. That also means those two cannot be placeholders on a
nested relation, since the window bounds are part of the SQL text.

**Many-to-many** goes through a junction table, declared with `.through()` on both ends.
The junction's key column is projected alongside the target's own columns and dropped once
the buckets are keyed — a target row can belong to several parents, so it carries nothing
that says which one it arrived by.
