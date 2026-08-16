# 07 — Roadmap

## Current status

M0 through M9 are implemented and tested. `npm run check` runs the type checker, both test
projects (Node for the pure layers, workerd with a real D1 binding for the rest), the build,
and the kit's type check.

| Milestone | State |
| --- | --- |
| M0 toolchain | Done. `tsgo` emits usable declarations; `vitest-pool-workers` reaches a local D1 binding. |
| M1 foundations | Done. `sql/` `schema/` `plan/` `builders/` `runtime/` per [03](./03-architecture.md), plus `ddl.ts`. |
| M1.5 Drizzle compatibility | Done, and taken further than planned — see below. |
| M2 select | Done, including subqueries, placeholders and the db-less `query` root. |
| M3 writes | Done, including `onConflict*`, `.returning()` and multi-row chunking. |
| M4 batch and sessions | Done, including collision aliasing and bookmarks. |
| M5 joins | Done: inner/left/right/full/cross, aliasing, nullable groups. |
| M6 observability | Done: `onQuery`, `D1zzleQueryError`, `__DEV__` diagnostics. |
| M7 relations | Done, split strategy — see the deviation below. |
| M8 kit: generate/migrate | Done, with property tests against real D1. |
| M9 kit: pull/check/push | Done. |

### Deviations from the design, and why

1. **Ecosystem interop was raised from a goal to a constraint.** [08](./08-drizzle-compatibility.md)
   scoped compatibility at "source level, internals out of scope". In practice every Drizzle
   adapter reads internals — `entityKind`, `Symbol.for('drizzle:Columns')`, `db._.relations` — so
   d1zzle now matches them exactly (`src/schema/drizzle-entity.ts`). `drizzle-orm`'s own `is()`,
   `getTableColumns()` and `getTableName()` work on d1zzle objects, verified in
   `test/unit/drizzle-interop.test.ts`.

   This breaks the "no class hierarchy deeper than 1" rule from [03](./03-architecture.md):
   recognition walks the constructor's `entityKind` chain, so tables and columns need real
   ancestors. The classes are empty and the cost is a few dozen bytes.

2. **Type-level assignability to Drizzle's own types needs a cast.** Drizzle's `Column`
   declares a `protected` member, and TypeScript accepts protected members only from the same
   declaration — so no independent implementation can ever be assignable. `d1zzle/drizzle`
   closes the gap with `asDrizzleSchema()`, identity at runtime, whose result type is computed
   from the metadata each column already carries. `test/unit/drizzle-types.test.ts` asserts
   Drizzle's `InferSelectModel` / `InferInsertModel` on that result match our own inference.

3. **Relations ship with the split strategy, not JSON aggregation.**
   [06](./06-runtime.md#relational-queries) planned JSON aggregation as the default but recorded
   it as a hypothesis. Split shipped first because its failure modes are all visible: predictable
   `rows_read`, no SQLite function-argument cap, readable SQL. Relations at one level are fetched
   concurrently. JSON aggregation stays open, and the benchmark still decides.

4. **`onQuery` costs the keyed read path.** `.raw()` returns no `D1Meta`, so a select can be
   read positionally *or* reported on, not both. With no `onQuery` hook and outside `__DEV__`,
   selects take the positional path; installing a hook switches them to `.all()`. The trade is
   explicit rather than silent.

5. **The root entry reaches `relations/`.** Rule R5 wanted the core entry free of it, but
   `drizzle({ client, relations })` has to return `db.query` for a one-line migration to work.
   `d1zzle/core` is the entry that keeps R5 exactly.

6. **`casing` is process-global.** It is applied by a module-level setting that `d1zzle()` and
   the kit configure, rather than threaded through compilation, so a schema module can be
   imported before the option is known. Two databases with different casings in one isolate
   would conflict; that is not a case D1 presents.

## What is not built

- Views, CTEs, window functions, set operations (`union` / `intersect` / `except`).
  One exception: `latestPerGroup` (`src/builders/window.ts`) compiles a `row_number()`
  window internally. It is a single named query, not a composable `over()` — the general
  window surface is still unbuilt.
- Zod / Valibot / ArkType adapters — the Drizzle ones are *believed* to work via
  `asDrizzleSchema()`, but no test imports them, so that is a survey rather than a result.
  [10](./10-ecosystem-interop.md#p1--validator-adapters-test-only) has the plan.
- An Auth.js / NextAuth adapter. `@auth/drizzle-adapter` drives Drizzle's query builder, so
  the bridge cannot serve it and a native adapter is needed, the same way Better Auth got
  one. Scoped in [10](./10-ecosystem-interop.md#p2--authjs--nextauth-a-native-adapter).
- A native studio (see [09](./09-d1zzle-migrate.md#studio)).
- Importing an existing `drizzle-kit` snapshot history. `pull` produces a baseline instead.
- The benchmark harness from M1: bundle-size, cold-start and instantiation-count budgets are
  not yet wired into CI, so the size claims in these documents remain unmeasured.

## Milestones

The list below is the **original plan**, kept as written for provenance. Where it and the
status table above disagree, the table is what shipped — and the deviations section says
why. A few details here are stale on purpose: `test/compat/` became the shared fixture
schema ([08](./08-drizzle-compatibility.md#verification)), and schema loading needs no
worker thread because Node runs TypeScript directly ([09](./09-d1zzle-migrate.md)).

### M0 — Toolchain proof

Install, build, and run one trivial test end to end. Confirm `tsgo` emits usable
declarations and that `vitest-pool-workers` reaches a local D1 binding.

*Done when:* `npm run build && npm run typecheck && npm test` all pass on a stub.

### M1 — Foundations and the measurement harness

Per rule R7, the harness comes **before** the optimizations it is meant to justify.

- Move sources to the layout in [03-architecture.md](./03-architecture.md).
- `sql/` — template tag, chunks, `Query`.
- `schema/` — `table()`, columns with the `ColumnMeta` record, `InferSelect` / `InferInsert`.
  Column factories take the **Drizzle-compatible signatures from the start**
  ([08](./08-drizzle-compatibility.md)) — retrofitting `mode` options and the full modifier
  chain later would mean rewriting every column type.
- `ddl.ts` — schema → `CREATE TABLE`, needed both for integration tests and as the
  foundation `d1zzle-migrate` generates migrations from.
- Benchmarks: bundle size per entry point, cold-start CPU, `rows_read` per operation.
- CI budgets: bundle size, and type-instantiation count from `tsgo --extendedDiagnostics`.

*Done when:* a schema type-checks, `ddl.ts` creates real tables in workerd, and CI reports
size + instantiation numbers with a Drizzle baseline to compare against.

### M1.5 — Drizzle schema compatibility

- `sqliteTable` and the rest of the Drizzle-named aliases.
- Full column `mode` variants, `.$defaultFn()` / `.$onUpdate()` / `.references()`, both
  table-extras forms.
- `test/compat/` — a schema exercising the Tier 1 surface, DDL snapshots, and
  `expectTypeOf` assertions.
- Confirm the revised ≤ 20 KB core budget still holds; if not, split the aliases into a
  `d1zzle/sqlite-core` entry point.

*Done when:* a real Drizzle schema file compiles and produces identical DDL and identical
inferred types after changing only its import specifier.

### M2 — Select

- `SelectPlan` IR, `compile.ts`, param plans, flat row mapper.
- Expressions: `eq ne gt gte lt lte and or not like inArray isNull between`.
- `where` / `orderBy` / `limit` / `offset` / `groupBy` / `having` / `distinct`.
- Positional `.raw()` read path; `__DEV__` header assertion.
- Placeholders (`ph`) and the db-less `query` root with `.compile()`.

*Done when:* compile-to-SQL snapshot tests pass and selects return correctly typed,
correctly decoded rows from real D1.

### M3 — Writes

- `insert` / `update` / `delete` plans and builders, with `.returning()`.
- `onConflictDoNothing` / `onConflictDoUpdate`.
- Multi-row insert chunking against the bound-parameter limit.

*Done when:* a 500-row insert into a 10-column table succeeds as a single atomic `batch()`
and `.returning()` yields all 500 rows in order.

### M4 — Batch and sessions

- `db.batch([...])` with tuple-typed results and the keyed mapper path.
- Projection collision detection and `c0…cN` aliasing.
- `db.withSession(constraint | bookmark)`, `session.bookmark()`.
- `db.transaction()` stub that throws with a pointer to `batch()`.

*Done when:* a batch mixing selects and writes returns a correctly typed tuple, a join with
duplicate column names maps correctly **inside** a batch, and a bookmark round-trips across
two requests with read-your-writes verified.

### M5 — Joins

- `innerJoin` / `leftJoin` / `rightJoin` / `fullJoin`, table aliasing, subqueries.
- `nullableTables` threading so `leftJoin` columns widen to `| null`.
- Nested selection shapes and the tree mapper.

*Done when:* type tests confirm left-joined columns are nullable and runtime tests confirm
duplicate column names survive both read paths.

### M6 — Observability and errors

- `onQuery` hook, `QueryEvent`, `D1zzleQueryError`.
- `__DEV__` diagnostics: full-scan heuristic, projection assertions, helpful messages.
- Verify the production build strips every `__DEV__` branch.

*Done when:* the production bundle contains no diagnostic strings and the size budget from
M1 still passes.

### M7 — Relations *(separate entry point)*

- `defineRelations()`, `db.query.users.findMany({ with: ... })`.
- Both fetch strategies implemented; **benchmark decides the default**, and
  [06-runtime.md](./06-runtime.md#relational-queries) gets rewritten with the numbers.

*Done when:* nested queries return correct shapes and the core entry's size budget is
unchanged, proving the entry-point split holds.

### M8 — `d1zzle-migrate`: generate and apply

Separate package. Can start once M1's `ddl.ts` exists — it does **not** need the query
builder, so it can proceed in parallel with M2–M6.

- Snapshot format, `_journal.json`, schema loading via a Node worker thread.
- `generate` (diff → SQL), including the full table-recreation procedure.
- `migrate` applying each migration as one atomic `batch()`, local and remote.
- Wrangler-compatible output layout and migration state table.
- Property/fuzz tests: random schema A → B, assert introspected result equals B, with
  seeded rows asserted to survive.

*Done when:* every fuzz-generated migration preserves data and round-trips through `pull`.

### M9 — `d1zzle-migrate`: introspection, drift, and push

- `pull` from a live database → `schema.ts` + baseline snapshot.
- Import of existing `drizzle-kit` snapshot history where feasible.
- `check` drift detection with a non-zero exit for CI.
- `push` for development loops.

*Done when:* an existing `drizzle-kit`-managed D1 database can be adopted without a
baseline reset, and `check` catches a manual `wrangler d1 execute` ALTER.

## Deferred

- **A natively built studio.** Users get the Drizzle Studio browser extension (works today,
  ORM-agnostic, zero effort) or an opt-in `d1zzle-migrate studio` that delegates to
  `drizzle-kit studio` via reverse import aliasing. See
  [09](./09-d1zzle-migrate.md#studio) — the delegation path is gated on verifying Drizzle
  Studio's licensing terms.
- Views, CTEs, window functions, set operations (`union` / `intersect` / `except`).
  One exception: `latestPerGroup` (`src/builders/window.ts`) compiles a `row_number()`
  window internally. It is a single named query, not a composable `over()` — the general
  window surface is still unbuilt.
- Zod / Valibot / ArkType schema adapters.
- Custom column types beyond `$type<T>()`.
- The rest of the adapter ecosystem, surveyed and prioritised in
  [10](./10-ecosystem-interop.md#the-rest-of-the-ecosystem). Several entries there are
  **declined** rather than deferred — an adapter that only runs in a Node process is not a
  gap in a Workers-only ORM.

## Open questions

1. **Relational fetch strategy default** — needs the M1 harness plus M7 implementations.
2. **`inArray` → `json_each` crossover point** — where does one JSON param beat N bound
   params? Probably well below the 100-param ceiling, but that is a guess.
3. **Exact bound-parameter limit** — design assumes ~100; confirm against current D1 docs
   and make it configurable regardless.
4. **`PromiseLike` builders** — ergonomic (`await db.select().from(users)`), but they make
   accidental double-execution and floating-promise mistakes easier. Worth having, or
   should `.all()` always be explicit?
5. **Does Drizzle compatibility fit in 20 KB?** M1.5 answers it. If not, the aliases move
   to a `d1zzle/sqlite-core` entry point — decide before building on the assumption.
6. **Which PRAGMAs does D1 actually support?** The table-recreation procedure depends on
   `foreign_keys` / `defer_foreign_keys`; introspection depends on `table_info` /
   `index_list`. Verify empirically in M8, not from documentation.
7. **Can `drizzle-kit` snapshot history be imported wholesale?** Determines whether
   adoption is seamless or starts from a baseline.
8. **`casing: 'snake_case'`** — convenient, but it means the SQL a user reads in logs does
   not match the identifiers they wrote. Default `'preserve'` is chosen for that reason;
   revisit if it proves annoying in practice.
