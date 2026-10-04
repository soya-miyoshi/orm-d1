# Observability and budgets

What a caller can learn about the statements this ORM sent, and how to make it stop before D1
is hit too many times.

The surface is in two halves. `logger` and `onQuery` report **one statement at a time**.
`usage` and `budget` are the per-invocation half: the totals, and the limits that throw.

## The per-statement half

| Option | Shape | Reports |
| --- | --- | --- |
| `logger: true \| Logger` | Drizzle's `logQuery(sql, params)` | Every statement, as text. `true` installs a `console.log` logger |
| `onQuery: (event) => void` | [`QueryEvent`](../src/runtime/result.ts) | Every statement, including each member of a `batch()` and each chunk of a chunked statement: `sql`, `kind`, `tables`, `durationMs`, `d1DurationMs`, `sqlDurationMs`, `rowsRead`, `rowsWritten`, `attempts`, `servedByPrimary`, `servedByRegion` |
| `plan: D1Plan` | — | Warns **once per database object** when the statement count passes the plan's `queriesPerInvocation`, and when the database passes 90% of the plan's size limit (`InvocationBudget`, `src/limits.ts`) |

Two properties of `onQuery` carry over to everything below:

- It sees **every statement actually sent**: each member of a `batch()`, each chunk of a
  chunked statement, and `db.execute()`. A database derived from `withSession()` reuses the
  same resolved options, so a session's statements are reported too.
- It costs nothing when nobody listens: `QueryEvent` is not built at all when `onQuery` is
  absent and `__DEV__` is off.

## Why the per-statement half is not enough

A caller who wants to know what one Worker invocation cost would otherwise write the
accumulator themselves: an object, an `onQuery` closure that adds to it, and somewhere to
read it at the end. The version written outside the ORM is also worse than the one inside
it:

**`rowsRead` is the number D1 bills and the number that explains a slow request. Statement
count is not.** A caller counting `prepare()` calls from outside — by wrapping the
`D1Database` binding in a `Proxy` — gets the statement count, misses `rowsRead` entirely,
has to re-implement the `prepare`/`batch`/`exec` fan-out by hand, and counts zero on the
`withSession()` path.

`plan` **warns and continues**. A warning is the right default for "you are approaching a
platform limit you will hit later", but it does nothing for a client that re-issues the same
query in a loop: each request looks normal, the warning fires once and is then suppressed by
design, and D1 keeps being read. `budget` with `onExceeded: 'throw'` is the way to say
*stop*.

> A product using this ORM lost 55 minutes of production to exactly that shape: a React
> client put a millisecond-precision timestamp in a query variable, so its cache key changed
> on every retry and it re-issued the same read forever. One request pulled 441 statements,
> so the loop read roughly 26,000 rows per minute while every individual request returned
> 200 OK in a normal amount of time. Request-rate limiting did not see it, because the loop
> was serial and therefore slow.

## The per-invocation half

`usage` and `budget` are both opt-in. With both absent no meter is created, so nothing is
allocated and nothing is counted. What remains per statement is one optional call on
`undefined` where a statement is admitted (`Executor#prepare` / `#prepareAll`), and the
meter folded into the two gates that already existed: `if (!onQuery && !meter && !isDev())
return` in the emit tail, and the keyed-path test in `executeRows`.

With either set, the cost is what `onQuery` costs. `.raw()` carries no `meta`, so a select
switches to `.all()` and the keyed mapping, and the emit tail builds a `QueryEvent`. Without
that switch every select would report `rowsRead: 0`.

### `usage` — per-database totals

```ts
const db = drizzle({ client: env.DB, relations, usage: true });
await db.query.clubs.findMany({ with: { members: true } });
db.usage();
```

```ts
interface UsageSnapshot {
  readonly statements: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Summed `QueryEvent.durationMs` — wall clock, so it includes network. */
  readonly durationMs: number;
  readonly byTable: Record<string, TableUsage>; // { statements, rowsRead, rowsWritten }
  readonly byKind: Record<QueryEvent['kind'], number>;
  /** SQL shapes executed more than once, most repeated first. */
  readonly repeats: readonly { readonly sql: string; readonly count: number }[];
}
```

`UsageSnapshot` and `TableUsage` are exported from the core entry (`src/runtime/usage.ts`).

- `db.usage()` returns a plain snapshot, safe to pass to a structured logger. It is a copy:
  reading it does not stop the counting.
- `db.usage()` throws when neither `usage` nor `budget` was set, because a snapshot of zeros
  would read as "no queries ran". A `budget` alone also makes `usage()` available, since the
  budget counts the same things.
- `usage` and `onQuery` are independent: either, both or neither.
- Counting is **per database object**, and a `withSession()`-derived database shares the
  meter, as it shares `plan`'s statement counter. There is no `reset()`: the intended shape
  is one database per request, which is what `drizzle()` being a cheap synchronous wrapper is
  for. A database hoisted to module scope accumulates across every request its isolate
  serves.
- `statements` counts every statement D1 runs — each chunk of a chunked statement, each
  member of a `batch()` — because that is how D1 counts them. It is counted when the
  statement is admitted, before it is sent. Rows, duration, `byKind` and `byTable` are
  counted when the response arrives.
- `byKind` always carries all five kinds, at 0 when unused. `byTable` charges a statement to
  every table it names, so a join's rows appear under each table and the per-table sums can
  exceed `rowsRead`. `db.execute()` names no table and appears only in the totals and under
  `raw`.
- Every member of a `batch()` reports the whole batch's wall clock as its `durationMs`, so
  the summed `durationMs` counts a batch once per member.

### `budget` — limits that can throw

```ts
const db = drizzle({
  client: env.DB,
  relations,
  budget: { maxStatements: 200, maxRowsRead: 50_000, repeatsPerShape: 25, onExceeded: 'throw' },
});
```

```ts
interface BudgetOptions {
  maxStatements?: number;
  /** Accumulated `rowsRead`, checked against the total so far. */
  maxRowsRead?: number;
  /** How many times one SQL shape may be executed. See "Repeated shapes". */
  repeatsPerShape?: number;
  /** Default `'warn'`, matching `plan`. */
  onExceeded?: 'warn' | 'throw';
}
```

- **Checked before the statement is sent**, so `'throw'` means D1 is not read again.
- Every send is admitted as a unit: one statement, all chunks of a chunked statement, or a
  whole `batch()`. Its statements are bound, then every limit is checked, and only then is
  anything counted, logged or sent. A refused batch therefore leaves `usage()` and the
  budget exactly as they were, and nothing reaches `logger`. A batch member whose
  placeholders are missing fails before admission, with the same result.
- `maxStatements` and `repeatsPerShape` are checked and counted synchronously at admission,
  so they hold **exactly**, including under concurrency: statements in flight have already
  been counted.
- `maxRowsRead` cannot hold exactly. Rows are known only when a response arrives, so the
  check is against the total so far, and everything admitted while that total was still at
  or under the limit runs to completion. The overshoot is at least the statement that
  crossed the line. For a `batch()` or a chunked statement it is the whole send. When
  statements run concurrently it is all of them: sibling relations of a relational query,
  the chunks of a relational child read (both use `Promise.all`), and anything the caller
  runs in parallel.
- The boundaries, with `observed > limit` in every case:
  - `maxStatements: N` refuses the send that would take the count past N. `observed` is
    the count that send would have made: N + 1 for a single statement, more for a batch.
  - `maxRowsRead: N` refuses the next send once the total so far is *past* N; reaching
    exactly N does not trigger it. `observed` is the total so far.
  - `repeatsPerShape: N` allows one shape N executions and refuses execution N + 1.
    `observed` is N + 1 and `sql` is the shape.
- The options are validated in `drizzle()` / `ormD1()`. A limit that is not a finite number
  ≥ 0 — `NaN` from `Number(env.MAX)` with the variable unset, a negative number, `Infinity`,
  a string — throws. So does an `onExceeded` other than `'warn'` or `'throw'`. Accepting
  either would leave the guard off while the caller believes it is on.
- `'throw'` throws a `D1BudgetExceededError` carrying `{ reason: 'statements' | 'rowsRead' |
  'repeats', limit, observed, sql? }`. It is an ORM-level error, not a D1 error: it is not a
  subclass of `OrmD1QueryError`, and `wrapQueryError` passes it through unwrapped, so a
  caller can map it to its own response with `instanceof` instead of matching on the
  message. `D1BudgetExceededError` and `BudgetReason` live in `src/errors.ts` and are
  exported from the core entry.
- **A hoisted database never recovers.** With `onExceeded: 'throw'`, a database hoisted to
  module scope counts for the isolate's lifetime. Once that total passes a limit, **every
  statement of every later request throws** until the isolate is evicted. Use one database
  per request; a budget on a hoisted database is a lifetime budget for the isolate.
- `'warn'` warns **once per reason per database object**: past the line every further
  statement is also past it, and repeating the claim turns a signal into noise.
- Unlike `plan`'s warnings, a budget warning is **not** dropped outside `__DEV__`. It goes
  through `warnAlways` (`src/dev.ts`), which uses the same sink as `setWarn`. `plan` is a
  diagnostic nobody asked for. A budget is a number the caller passed, and a default
  `'warn'` that went silent in production would do nothing in the one place it was set.
- `budget` is independent of `plan`. `plan` describes the platform's limit and stays a
  warning; `budget` is the caller's own ceiling, usually well below the platform's. Both may
  be set, and each warns on its own terms.

### Repeated shapes (N+1)

`QueryEvent.sql` is parameterised text, so two executions of the same query with different
bound values are the **same string**. Counting identical strings is an exact and nearly free
N+1 signal, and the ORM is the only place that can act on it before the statements are sent.

- `usage().repeats` reports every shape executed more than once, most repeated first.
- `budget.repeatsPerShape` turns that count into a limit.
- A shape is counted once per **logical** statement:
  - A chunked statement — a wide insert, say, split to fit the parameter budget — is one
    execution of its shape however many chunks it sends.
  - A relational read whose child query is chunked over many parents counts each shape
    once. Chunks after the first, and everything nested under them, run on an internal
    continuation database (`OrmD1Database.$continuation()`) that counts their statements
    but not their shapes.
  - Inside one `batch()`, each item is one execution, so the same shape batched five times
    is five executions.
  - Each chunk still counts toward `statements` and `maxStatements`, as D1 counts it.
- The message gives advice that matches the statement's kind. For a read, that is one
  `inArray()` in place of a lookup per key, or one relational query with `with:` in place
  of a query per parent. For an insert, one `values([...])` with every row. For an update
  or delete, one statement whose `where` covers every row. It also says to raise the limit
  if the repetition is intended.
- The message does not say whether a repeat came from a relational query or from a loop in
  the caller's code. The meter sees SQL text and the kind of statement, nothing more. The
  SQL text and the count are enough to find either.
- The shape table is unbounded: one entry per distinct SQL text. On a per-request database
  that is a handful of entries. On a database hoisted to module scope it grows for the
  isolate's lifetime. With `db.execute()` and values pasted into the text rather than bound,
  that means one entry per call.

### `BatchStatement`

The element type of `db.batch([...])`, exported from the core entry as
`BatchStatement<TResult = unknown>` — an alias of `Runnable` (`src/builders/types.ts`). It
spares a caller that builds statements in one function and batches them in another from
writing `Parameters<Database['batch']>[0][number]`.
