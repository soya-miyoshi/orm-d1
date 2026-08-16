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
specifier; see [Migrating an existing project][migrating].

## Documentation

| Document | What it covers |
| --- | --- |
| [Differences from drizzle-orm on D1][differences] | Where the behaviour departs from `drizzle-orm` on D1, case by case — summarised below |
| [Beyond Drizzle][beyond] | What has no spelling in Drizzle at all: append-only tables and columns, `latestPerGroup`, `impact`, `backfill`, roundtrip drafts |
| [Relational queries][relational] | `defineRelations`, the `db.query` filter DSL, and the two plans a `with` can run under |
| [Migrations][migrations] | `d1zzle-migrate`, and the five things it does differently from `drizzle-kit` because the target is D1 |
| [Migrating an existing project][migrating] | The one-line import change, the zero-diff path alias, and what is and is not supported |
| [Adapters: Pothos and Better Auth][adapters] | Being recognised by Drizzle's adapters, and the native Better Auth adapter |
| [Entry points and dependencies][entry-points] | The seven import paths, and which two optional peers each one needs |
| [D1 limits, and where each is enforced][limits] | What is checked while compiling, what after execution, and what is left to D1 |
| [`d1zzle-migrate` CLI][kit] | Every command, flag and config key of the migration CLI |

The design documents — the goals and the rules that break ties, the platform description
most decisions come from, the compilation model, and what the compiler does and does not
guarantee — are in [docs/][docs].

## Differences from drizzle-orm on D1

The API is Drizzle's; the behaviour on D1 differs in ten places, all of them consequences
of the same four properties of the platform. The database is reached over the network, so
cost tracks the number of calls; a statement accepts at most 100 bound parameters;
`batch()` is the only atomicity available, because there are no interactive transactions;
and Worker startup CPU is billed, so library size is a per-request cost on cold isolates.

Each case is written out in full — what `drizzle-orm@1.0.0-rc.4` does on D1, read from
that version's own source, and what d1zzle does instead — in
**[Differences from drizzle-orm on D1][differences]**.

| Case | `drizzle-orm` on D1 | d1zzle |
| --- | --- | --- |
| [Inserting more rows than one statement can carry][d-insert] | one statement, 2,000 parameters, `too many SQL variables` | chunked at compile time and submitted as one atomic `batch()` |
| [Matching a column against a long list][d-inarray] | one parameter per value; over 100 values fails | collapses to `json_each(?)` past a threshold |
| [Grouping writes so that they all succeed or all fail][d-batch] | `transaction()` emits `BEGIN`/`COMMIT`, which D1 does not honour | no `transaction()`; `batch()`, with typed per-statement results |
| [A joined select inside `batch()` with two columns of the same name][d-collision] | the duplicate key is already lost when the row is converted | collision detected while compiling; aliases emitted |
| [Reading from a replica, and reading your own writes][d-session] | no session API; use the binding directly | `withSession()` returns the same API, plus `bookmark()` |
| [Seeing what a query cost][d-onquery] | `logger` gets SQL and params; selects lose D1's metadata | `onQuery` with `rowsRead` / `rowsWritten` / timings per statement |
| [Building a query once per isolate][d-compile] | `.prepare()` needs a session, so SQL is built inside `fetch` | compilation is separate from execution; compile at module scope |
| [D1's other limits][d-limits] | reported by D1, naming the constraint but not the call | checked while compiling, naming the lever |
| [Plan-dependent limits][d-plan] | — | opt-in `plan: 'free' \| 'paid'` warnings in development |
| [Bundle size][d-size] | 77.8 kB minified for driver + schema DSL | 44.1 kB — the dialect, transaction and prepared-statement layers are absent |

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
  against a real D1 binding, and [11-security][security] documents what the compiler does
  and does not guarantee, but that is not a substitute for reviewing the copy you run, and
  no fix is promised on any timeline.

**If you intend to depend on this, fork it and maintain your own copy.** You take on the
risk and the maintenance deliberately, and the MIT license exists so that you can.
[CONTRIBUTING](./CONTRIBUTING.md) covers what a usable fork needs.

If funding or a volunteer maintainer appears, the contribution side of this can change.
That is not the situation today.

## License

MIT — see [LICENSE](./LICENSE). The warranty and liability clauses mean what they say.

<!-- Absolute URLs: npm rewrites relative links in a README, but resolves them against a
     branch that may not exist, so these are spelled out to work on both sites. -->

[docs]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/README.md
[kit]: https://github.com/soya-miyoshi/d1zzle/blob/main/kit/README.md
[security]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/11-security.md
[differences]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md
[beyond]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/18-beyond-drizzle.md
[relational]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/13-relational-queries.md
[migrations]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/14-migrations.md
[migrating]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/15-migrating-from-drizzle.md
[adapters]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/16-adapters.md
[entry-points]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/17-entry-points.md
[limits]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#d1-limits-and-where-each-is-enforced
[d-insert]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#inserting-more-rows-than-one-statement-can-carry
[d-inarray]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#matching-a-column-against-a-long-list
[d-batch]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#grouping-writes-so-that-they-all-succeed-or-all-fail
[d-collision]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#a-joined-select-inside-batch-that-projects-two-columns-with-the-same-name
[d-session]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#reading-from-a-replica-and-reading-your-own-writes
[d-onquery]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#seeing-what-a-query-cost
[d-compile]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#building-a-query-once-per-isolate-instead-of-once-per-request
[d-limits]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#d1s-other-limits
[d-plan]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#plan-dependent-limits
[d-size]: https://github.com/soya-miyoshi/d1zzle/blob/main/docs/12-drizzle-differences.md#bundle-size
