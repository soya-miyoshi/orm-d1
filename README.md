# d1zzle

[![CI](https://github.com/soya-miyoshi/d1zzle/actions/workflows/ci.yml/badge.svg)](https://github.com/soya-miyoshi/d1zzle/actions/workflows/ci.yml)
[![Release](https://github.com/soya-miyoshi/d1zzle/actions/workflows/release.yml/badge.svg)](https://github.com/soya-miyoshi/d1zzle/actions/workflows/release.yml)
[![d1zzle on npm](https://img.shields.io/npm/v/d1zzle?label=d1zzle)](https://www.npmjs.com/package/d1zzle)
[![d1zzle-migrate on npm](https://img.shields.io/npm/v/d1zzle-migrate?label=d1zzle-migrate)](https://www.npmjs.com/package/d1zzle-migrate)

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
specifier; see [Migrating an existing project][migrating].

## Differences from drizzle-orm and drizzle-kit

The API is Drizzle's. Ten calls behave differently, each following from a property of D1:
cost tracks round trips, a statement carries at most 100 bound parameters, `batch()` is
the only atomicity, and Worker startup CPU is billed. Seven more have no Drizzle spelling
at all: each is specific to D1 or to SQLite, which is why a library targeting several
databases has no place to put it. Each heading links to the case in full — the call, the
SQL it emits, and the error text.

### [`db.insert(users).values(rows)`][d-insert] — 500 rows, 4 columns each

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

One statement carrying 2,000 bound parameters. D1 rejects it: `D1_ERROR: too many SQL variables`. Splitting the array is left to the caller, and the pieces are then separate writes — a failure in the fourth leaves the first three applied.

</td><td>

`floor(100 / 4) = 25` rows per statement, computed while compiling: 20 statements sent as one `batch()`. One round trip, and a conflict in the last chunk inserts nothing. `.returning()` rows come back in input order.

</td></tr>
</table>

### [`where(inArray(users.id, ids))`][d-inarray] — 201 ids

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

`in (?, ?, ?, …)` — one parameter per value, so the same 100-parameter limit rejects it. Staying under it means splitting the query and merging the results.

</td><td>

`in (select "value" from json_each(?))`: the list travels as one JSON parameter, so its length stops mattering. Under 30 values, and for `blob`s that have no JSON spelling, values are bound individually as before.

</td></tr>
</table>

### [`db.transaction(async (tx) => …)`][d-batch]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

Runs `begin`, your statements, then `commit` as separate statements. D1 does not guarantee they reach the same connection, so the `begin` can apply where the writes do not: a failure part-way leaves earlier writes applied and `rollback` with nothing to undo.

</td><td>

**Not implemented.** The method exists only to throw `NoTransactionsError`, whose message names the replacement. `db.batch([...])` is the atomic primitive: D1 runs a batch as one transaction and returns one typed result per statement.

</td></tr>
</table>

### [`db.batch([db.select({ a: users.id, b: posts.id })…])`][d-collision] — a join projecting two `id` columns

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

`batch()` returns keyed row objects, and two columns named `id` occupy one key. The conversion back to an array (`Object.keys(row).map(…)`) therefore runs on a row that is already one value short. Drizzle's source notes the case in a comment.

</td><td>

The collision is found while compiling, when the projection is still known, and the two columns are emitted as `c0`, `c1`. Both values arrive.

</td></tr>
</table>

### [`db.withSession(bookmark)`][d-session]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

Not available: `withSession` does not appear in the package. Reading from a replica means calling `env.DB.withSession()` directly and writing the SQL by hand.

</td><td>

Returns the same API — `select`, `insert`, `db.query` — plus `session.bookmark()`, so the consistency point can be stored in a cookie and passed back on the next request.

</td></tr>
</table>

### [`drizzle(env.DB, { onQuery })`][d-onquery] — reading `rows_read` / `rows_written`

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

`logger` receives the SQL and its parameters. Selects read through `.raw()`, which returns rows without D1's `meta`, so the billed row counts never reach the caller.

</td><td>

`onQuery` fires once per executed statement — each member of a `batch()`, each chunk of a chunked insert — carrying `rowsRead`, `rowsWritten` and `durationMs` always, plus `d1DurationMs`, `servedByPrimary` and `attempts` when D1 returns them.

</td></tr>
</table>

### [`query.select()…compile()`][d-compile] — building SQL once per isolate

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

`.prepare()` is a method on a builder that holds a session, and the session holds the binding. On Workers the binding arrives with the request, so the SQL string is built again inside every `fetch`.

</td><td>

Compilation is separate from execution: `query.select()` needs no binding, so a query compiles at module scope and is reused for the isolate's lifetime. Values arrive through `ph()` placeholders at `db.get(compiled, { email })`.

</td></tr>
</table>

### [Exceeding another D1 limit][d-limits]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

The statement is sent and D1's error comes back naming the constraint but not the call site: `too many SQL variables` does not say which `inArray`, and `too many arguments on function coalesce` does not say which `coalesce`.

</td><td>

The limits knowable at compile time are checked there, once per isolate, and the message names the call and the option that moves it (`maxParams`, `jsonEachThreshold`) — before the code ever runs against D1.

</td></tr>
</table>

### [Free and paid plan caps][d-plan]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

No plan awareness. 50 statements per Worker invocation and 500 MB on the free plan are found by hitting them.

</td><td>

`plan: 'free'` counts the statements an invocation has issued and reads `size_after` off each response, warning once in a development build at 90% of the cap.

</td></tr>
</table>

### [Bundle size][d-size]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

77.8 kB minified, 22.2 kB gzipped, for driver + schema DSL: the dialect indirection, the transaction and savepoint subsystem, and prepared-statement abstractions covering sync and async drivers are all reachable from the entry point.

</td><td>

44.1 kB / 15.3 kB for the same Worker, built the same way. None of those layers exist to be tree-shaken.

</td></tr>
</table>

The seven below have no spelling in `drizzle-orm` or `drizzle-kit` at all. [Beyond
Drizzle][beyond] covers each one in full.

### [Append-only tables, and append-only columns][b-append]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

Neither `drizzle-orm/sqlite-core` nor `drizzle-kit` has a spelling for a trigger, so a `before update … raise(abort)` guard is written by hand inside a migration. The schema does not record it, and nothing reports its absence afterwards.

</td><td>

`tableOptions([[ledgerEntries, { appendOnly: true }]])` in a sidecar module: `generate` renders the trigger, `diff` compares it, `introspect` reads it back. A column list guards part of a row. The list is validated, because SQLite accepts `before update of` naming a column that does not exist and the trigger then never fires — the table reads as guarded while every `UPDATE` goes through.

</td></tr>
</table>

### [`latestPerGroup(db, table, { partitionBy, orderBy, tiebreak })`][b-latest]

<table>
<tr><th width="50%">On <code>drizzle-orm@1.0.0-rc.4</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

SQLite has no `distinct on`, and `row_number()` cannot appear in `where`. One row per group is written by hand: `order by … limit 1` per group is one query per group and not deterministic on a millisecond timestamp, and keeping the first row seen per key in JavaScript transfers the whole history to return its last page.

</td><td>

One statement: a `row_number() over (partition by …)` subquery with an outer filter on the rank. `tiebreak` is a required argument, because `orderBy` alone is not a total order and there is no default that would be correct. The rank column is projected under a name no user column can collide with, and removed from the returned rows.

</td></tr>
</table>

### [`STRICT` and `WITHOUT ROWID`][b-strict]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

No spelling for either. The clause is added to the generated `create table` by hand, and whether the table satisfies it is found out when the migration runs.

</td><td>

Table options in the same sidecar module, both validated at `generate` against behaviour confirmed on D1: `WITHOUT ROWID` on a table with no primary key fails with `PRIMARY KEY missing`, and `STRICT` with a `NUMERIC` column fails with `unknown datatype`. The alternative to checking is a migration that applies to production halfway and then fails.

</td></tr>
</table>

### [`d1zzle-migrate impact`][b-impact]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

No command. D1 rejects `PRAGMA foreign_keys = OFF` inside a migration, so rebuilding a referenced table means dropping every foreign key pointing at it first — and dropping a foreign key rebuilds the table holding it, transitively. What a rebuild costs is worked out by reading the schema.

</td><td>

`impact --table transactions` prints the closure computed from the snapshot: how many tables come apart, which reference the table directly, and — with `--remote` — `count(*)` per table, which is what the copy has to move. Checked against a 58-table schema: the closures for 20 tables matched values computed by hand.

</td></tr>
</table>

### [`d1zzle-migrate backfill`][b-backfill]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

No command. Filling a column on an append-only table means dropping the guard, writing, and re-creating it by hand. Both failure modes are silent: a re-created list one column short reads as protection without being it, and an omitted re-create leaves the table accepting `UPDATE`s indefinitely.

</td><td>

The guard is read out of `sqlite_master`, dropped, and re-created **from the captured text** — never restated — with the backfill in between, all submitted as one `batch()`. D1 runs a batch as one transaction, so a backfill that fails leaves the table as it was, guard included. `kit/test/workers/backfill.test.ts` asserts the guard is present after a statement inside the backfill fails.

</td></tr>
</table>

### [`generate --emit-roundtrip`][b-roundtrip]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

The rebuild is emitted as one migration, and splitting it into passes that D1 can apply is left to the caller. The obvious three passes — drop the children's foreign keys, rebuild the parent, restore them — do not work: dropping a child's foreign key is a rebuild of that child, refused for the same reason whenever that child has children of its own.

</td><td>

One draft file per refused table, under `<out>/roundtrip/`, holding the passes in order: detach every reference edge in the closure at once, rebuild, then one migration per level of the reference graph to restore. Each leg is rendered by the same `diffSnapshots` as every other migration. The files sit outside the journal `migrate` reads, so they are never applied automatically.

</td></tr>
</table>

### [Vocabulary divergence between `check` constraints][b-vocab]

<table>
<tr><th width="50%">On <code>drizzle-kit</code></th><th width="50%">On d1zzle</th></tr>
<tr><td>

`check ("method" in ('card', 'cash'))` is per table, and nothing compares one table's copy with another's. A vocabulary widened at three call sites and missed at the fourth fails at an `INSERT`, on the one path that writes the new value.

</td><td>

`generate` reports a pair when one value set is a **proper subset** of the other under the same column name, naming the values the smaller set rejects. Partial overlaps are not reported: two tables can share a column name with unrelated vocabularies, and only a strict subset indicates one list that was not updated.

</td></tr>
</table>

## Drizzle APIs that do not exist here

Absent, not stubbed to a no-op. The first two throw an error naming the replacement; the
rest are simply not exported, so a call to them does not type-check. Each is a decision,
and the reason is one of two: D1 cannot honour the API, or honouring it would ship bytes to
every isolate for something already reachable.

**`db.transaction(cb)` — throws `NoTransactionsError`.** D1 has no interactive
transactions. Statements in a session are not guaranteed to reach the same connection, so
an emitted `begin` can apply where the writes do not: a failure part-way leaves earlier
writes applied and `rollback` with nothing to undo. An implementation would be a claim of
atomicity the database does not make. `db.batch([...])` is the primitive that does hold —
one round trip, run as one transaction. It is a throwing method rather than an absent one
for a single reason: `db.transaction is not a function` says nothing about what to use
instead, and the thrown message does. That costs one error class in the bundle; the
transaction and savepoint subsystem it would otherwise pull in is not there.

**`experimental.joins` (Better Auth adapter) — throws `D1zzleAdapterError`, naming the
models the call asked to join.** The adapter is built on `select` / `insert` / `update` /
`delete` alone. The alternative to failing is dropping the joined models from the result,
which returns rows that look complete, so the option is refused rather than partly
honoured. Turn it off: Better Auth then fetches the related rows with follow-up queries.

**`relations()` (the v0 API), and the `where` / `orderBy` callback forms — not exported.**
v0 stated the join on whichever side happened to carry `fields` / `references` and matched
the two halves up by table, which is ambiguous as soon as two relations point at the same
table. `defineRelations()` states the join once, explicitly, on either side. Keeping v0
as well would ship a second relation resolver to every isolate to express the same graph
less precisely.

**Views (`sqliteView`) — not exported.** `d1zzle-migrate` reads
`type in ('table', 'index', 'trigger')` out of `sqlite_master`, so a view declared in a
schema file would never be created, diffed, or dropped: the schema would name an object the
migrations do not manage. Create one in a migration and query it with
`db.execute(sql, params)`.

**CTEs, `union` / `intersect` / `except` — not exported.** Each is compiler surface parsed
on every cold isolate and billed as startup CPU, for statements `db.execute(sql, params)`
runs with their values still bound. Not shipping them is part of the 44.1 kB under
[Bundle size][d-size].

**`.prepare()` on a query builder — not implemented.** In Drizzle it hangs off a builder
that holds a session, and the session holds the binding; on Workers the binding arrives
with the request, so a prepared statement cannot outlive it and the SQL is built again in
every `fetch`. Separating compilation from execution is what makes reuse possible instead:
`query.select()…compile()` at module scope, then `db.get(compiled, input)`.

**`logger`, and the v0 `schema` option — accepted and ignored, with no warning.** Both are
accepted so that an options object carried over from Drizzle keeps type-checking during a
port. `logger` reports the SQL and its parameters; on D1 the numbers that decide what a
query cost are `rows_read` and `rows_written`, which arrive on the response `meta`, and
`onQuery` reports those. `schema` took a v0 schema module; the v1 replacement is
`relations`.

**`drizzle-kit studio` — `d1zzle-migrate` has no `studio` command.** There is nothing to
reimplement: the Drizzle Studio browser extension introspects the live database and never
loads a schema file, so it works against a d1zzle project unchanged, and Cloudflare's D1
console covers ad-hoc queries.

## Documentation

| Document | Contents |
| --- | --- |
| [Differences from drizzle-orm on D1][differences] | The ten behavioural cases above, each with the SQL and the error text, and the table of which D1 limit is checked where |
| [Beyond Drizzle][beyond] | The seven features above in full: append-only tables and columns, `latestPerGroup`, `STRICT` / `WITHOUT ROWID`, `impact`, `backfill`, roundtrip drafts, vocabulary drift |
| [Relational queries][relational] | `defineRelations`, the `db.query` filter DSL, `count`, and the SQL each of the two `with` strategies emits |
| [Migrating an existing project][migrating] | The import change, the path alias, its silent failure mode, and the supported and unsupported lists |
| [Adapters][adapters] | `@pothos/plugin-drizzle`, and the Better Auth adapter |
| [Entry points and dependencies][entry-points] | The seven import paths, and which optional peer each needs |
| [Security][security] | What the compiler guarantees, the three APIs that opt out of it, and why the filter DSL is a trust boundary |
| [`d1zzle-migrate`][kit] | The CLI: configuration, environment resolution, commands, and what it does differently from `drizzle-kit` |

## Scope

Supported: Cloudflare D1, on Workers.

Not supported, by decision:

- **Other databases.** No Postgres, MySQL, better-sqlite3, `bun:sqlite`, or Durable Object
  SQLite. A second backend reinstates the abstraction layer that accounts for the
  bundle-size difference under [Bundle size][d-size]. Drizzle covers portability.
- **A runtime migration engine.** Migrations are generated and applied by the CLI, never
  from inside a Worker.
- **Query result caching.** Workers have the Cache API and KV.
- **Runtime schema validation.** Zod and Valibot adapters would be a separate package.

## Development

```bash
npm install
npm test        # unit tests in Node, integration tests inside workerd against real D1
npm run check   # typecheck + build + tests + kit typecheck + kit build
```

`npm run check` is what the CI badge above reports, on every push to `main` and every pull
request.

Tests are in two layers: `test/unit/` and `kit/test/unit/` run in Node and assert on
compilation output; `test/workers/` and `kit/test/workers/` run inside workerd against a
real D1 binding, and every claim about SQLite's or D1's actual behaviour is asserted
there.

`d1zzle` and `d1zzle-migrate` are published together from one GitHub Release — the Release
badge above is that workflow — using npm trusted publishing (OIDC, no long-lived token),
with provenance attestations. `npm run version:set <version>` moves both packages and the
kit's peer range together. See [RELEASING.md](./RELEASING.md).

## Support and maintenance

This project is maintained, but it is not open to contributions. Those are two different
things, and the distinction is what matters when deciding whether to depend on it.

- **Pull requests are very unlikely to be merged**, and feature requests are very unlikely
  to be accepted. Reviewing a patch properly means owning it afterwards, and that is the
  part I (soya-miyoshi) cannot take on at the moment — so please do not spend an evening
  on a patch for this repository expecting it to land.
- **Issues are welcome, and a reply is not guaranteed.** A described bug or a reproduction
  is worth having written down; it helps anyone running a fork whether or not I answer.
- **The security of this software is not guaranteed.** It is tested against a real D1
  binding, and [the security document][security] states what the compiler does and does not
  guarantee. Neither is a substitute for reviewing the copy you run, and no fix is promised
  on any timeline.

**If you intend to depend on this, fork it and maintain your own copy.** You take on the
risk and the maintenance deliberately, and the MIT license exists so that you can.
[CONTRIBUTING](./CONTRIBUTING.md) covers what a usable fork needs.

If funding or a volunteer maintainer appears, the contribution side of this can change.
That is not the situation today.

## License

MIT — see [LICENSE](./LICENSE). The warranty and liability clauses mean what they say.

<!-- Absolute URLs: npm rewrites relative links against a branch that may not exist. -->

[kit]: https://github.com/soya-miyoshi/d1zzle/blob/main/kit/README.md
[security]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/07-security.md
[differences]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md
[beyond]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md
[relational]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/03-relational-queries.md
[migrating]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/04-migrating-from-drizzle.md
[adapters]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/05-adapters.md
[entry-points]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/06-entry-points.md
[d-insert]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#inserting-more-rows-than-one-statement-can-carry
[d-inarray]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#matching-a-column-against-a-long-list
[d-batch]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#grouping-writes-so-that-they-all-succeed-or-all-fail
[d-collision]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#a-joined-select-inside-batch-that-projects-two-columns-with-the-same-name
[d-session]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#reading-from-a-replica-and-reading-your-own-writes
[d-onquery]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#seeing-what-a-query-cost
[d-compile]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#building-a-query-once-per-isolate-instead-of-once-per-request
[d-limits]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#d1s-other-limits
[d-plan]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#plan-dependent-limits
[d-size]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/01-differences.md#bundle-size
[b-append]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#append-only-tables-and-append-only-columns
[b-latest]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#latestpergroup
[b-strict]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#strict-and-without-rowid
[b-impact]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#impact
[b-backfill]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#backfill
[b-roundtrip]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#generate---emit-roundtrip
[b-vocab]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/02-beyond-drizzle.md#vocabulary-divergence
