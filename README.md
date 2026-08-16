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

## Differences from drizzle-orm on D1

The API is Drizzle's. The behaviour differs in ten places, each following from a property
of D1: cost tracks round trips, a statement carries at most 100 bound parameters,
`batch()` is the only atomicity, and Worker startup CPU is billed. Each row links to the
case in full — the call, what `drizzle-orm@1.0.0-rc.4` does with it on D1, and what d1zzle
does.

| The call | On `drizzle-orm@1.0.0-rc.4` | On d1zzle |
| --- | --- | --- |
| [`db.insert(users).values(rows)`][d-insert]<br>500 rows, 4 columns each | One statement carrying 2,000 bound parameters. D1 rejects it: `D1_ERROR: too many SQL variables`. Splitting the array is left to the caller, and the pieces are then separate writes — a failure in the fourth leaves the first three applied. | `floor(100 / 4) = 25` rows per statement, computed while compiling: 20 statements sent as one `batch()`. One round trip, and a conflict in the last chunk inserts nothing. `.returning()` rows come back in input order. |
| [`where(inArray(users.id, ids))`][d-inarray]<br>201 ids | `in (?, ?, ?, …)` — one parameter per value, so the same 100-parameter limit rejects it. Staying under it means splitting the query and merging the results. | `in (select "value" from json_each(?))`: the list travels as one JSON parameter, so its length stops mattering. Under 30 values, and for `blob`s that have no JSON spelling, values are bound individually as before. |
| [`db.transaction(async (tx) => …)`][d-batch] | Runs `begin`, your statements, then `commit` as separate statements. D1 does not guarantee they reach the same connection, so the `begin` can apply where the writes do not: a failure part-way leaves earlier writes applied and `rollback` with nothing to undo. | No `transaction()` — calling it throws, naming `db.batch([...])`. D1 executes a batch as one transaction, and the return value is one typed result per statement. |
| [`db.batch([db.select({ a: users.id, b: posts.id })…])`][d-collision]<br>a join projecting two `id` columns | `batch()` returns keyed row objects, and two columns named `id` occupy one key. The conversion back to an array (`Object.keys(row).map(…)`) therefore runs on a row that is already one value short. Drizzle's source notes the case in a comment. | The collision is found while compiling, when the projection is still known, and the two columns are emitted as `c0`, `c1`. Both values arrive. |
| [`db.withSession(bookmark)`][d-session] | Not available: `withSession` does not appear in the package. Reading from a replica means calling `env.DB.withSession()` directly and writing the SQL by hand. | Returns the same API — `select`, `insert`, `db.query` — plus `session.bookmark()`, so the consistency point can be stored in a cookie and passed back on the next request. |
| [`drizzle(env.DB, { onQuery })`][d-onquery]<br>reading `rows_read` / `rows_written` | `logger` receives the SQL and its parameters. Selects read through `.raw()`, which returns rows without D1's `meta`, so the billed row counts never reach the caller. | `onQuery` fires once per executed statement — each member of a `batch()`, each chunk of a chunked insert — with `rowsRead`, `rowsWritten`, `durationMs`, `d1DurationMs`, `servedByPrimary` and `attempts`. |
| [`query.select()…compile()`][d-compile]<br>building SQL once per isolate | `.prepare()` is a method on a builder that holds a session, and the session holds the binding. On Workers the binding arrives with the request, so the SQL string is built again inside every `fetch`. | Compilation is separate from execution: `query.select()` needs no binding, so a query compiles at module scope and is reused for the isolate's lifetime. Values arrive through `ph()` placeholders at `db.get(compiled, { email })`. |
| [Exceeding another D1 limit][d-limits] | The statement is sent and D1's error comes back naming the constraint but not the call site: `too many SQL variables` does not say which `inArray`, and `too many arguments on function coalesce` does not say which `coalesce`. | The limits knowable at compile time are checked there, once per isolate, and the message names the call and the option that moves it (`maxParams`, `jsonEachThreshold`) — before the code ever runs against D1. |
| [Free and paid plan caps][d-plan] | No plan awareness. 50 statements per Worker invocation and 500 MB on the free plan are found by hitting them. | `plan: 'free'` counts the statements an invocation has issued and reads `size_after` off each response, warning once in a development build at 90% of the cap. |
| [Bundle size][d-size] | 77.8 kB minified, 22.2 kB gzipped, for driver + schema DSL: the dialect indirection, the transaction and savepoint subsystem, and prepared-statement abstractions covering sync and async drivers are all reachable from the entry point. | 44.1 kB / 15.3 kB for the same Worker, built the same way. None of those layers exist to be tree-shaken. |

## Documentation

| Document | Contents |
| --- | --- |
| [Differences from drizzle-orm on D1][differences] | The ten cases above, each with the SQL and the error text, and the table of which D1 limit is checked where |
| [Beyond Drizzle][beyond] | Features with no spelling in Drizzle: append-only tables and columns, `latestPerGroup`, `impact`, `backfill`, roundtrip drafts, vocabulary drift |
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
  bundle-size difference in the table above. Drizzle covers portability.
- **Interactive transactions.** D1 has none.
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
  guarantee, but that is not a substitute for reviewing the copy you run, and no fix is
  promised on any timeline.

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
