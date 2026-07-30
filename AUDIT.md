# AUDIT.md — correctness / efficiency sweep

Working state for the `/audit-sweep` loop. Machine-written, human-editable — reorder,
delete, or re-rank anything here and the next iteration will follow it.

Gate: `npm run check` (typecheck → build → test → typecheck:kit → build:kit).
Baseline at sweep start: **green, 565 passed / 4 skipped**.
After the feature iteration (`15f24ef`): **green, 594 passed / 4 skipped**.

## Rotation

One lens per iteration, rotating `feature` → `efficiency + bugs` → `security` → repeat.
Advanced in every terminal case, including blocked and nothing-found, so a lens that keeps
failing cannot starve the other two.

- Next lens: **efficiency + bugs**
- Last ran: feature — 2026-07-30, merged `15f24ef` **over an unresolved round-2 rejection**.
  Seven `COMPAT-DEFECT` fixes landed; the round-2 reviewer's six open objections are
  recorded as `[F-017]`–`[F-022]` and are now claims about code on `main`. `[F-017]` and
  `[F-018]` are regressions this batch introduced and should be the next thing fixed,
  whichever lens picks them up.

The `## Audit areas` checklist below predates the rotation and is correctness-shaped, so it
feeds **lens 2 (efficiency + bugs)**. It is a hint, not a schedule: each lens reviews the
whole codebase, and ticking an area off there does not retire it from future passes.

## Item format

```
### [F-00N] <title> — status: todo — severity: high|med|low — area: <area>
- **Where**: `path:line`
- **Defect**: one sentence
- **Failure scenario**: specific schema/query → specific wrong SQL, wrong rows, or dropped constraint
- **Fix**: the exact change (a low-effort coder must be able to apply this without deciding anything)
- **Prove it**: the test to add and the command that must go from red to green
```

Statuses: `todo` → `in-progress` → `done` (+ commit SHA) | `blocked` (+ reason) |
`needs-human` (+ the question).

## Findings

### [F-001] No regression harness against a large real-world schema — status: todo — severity: high — area: kit/render
- **Where**: `kit/test/` (new file), alongside `kit/test/workers/foreign-schema.test.ts`
- **Defect**: every fixture in the suite is small and written by this project, so a
  constraint that the renderer or the snapshotter drops on a *realistic* schema has no
  test that would notice. This is the exact shape of the failure that motivated the
  project: drizzle-kit dropped column-level `.unique()` across 64 tables and the
  generated-vs-committed CI stayed green because both artifacts shared the bug.
- **Failure scenario**: a 64-table schema using column-level `.unique()`, composite
  primary keys, `check()`, FK `on delete`, partial indexes, `STRICT` and `WITHOUT ROWID`
  round-trips through snapshot → DDL → apply → introspect → snapshot with a constraint
  missing, and no test fails.
- **Fix**: add a harness that loads a schema module from an **env var path**
  (`D1ZZLE_FIXTURE_SCHEMA`), skipping cleanly when unset, and asserts round-trip
  fidelity: every `unique`, composite PK, `check`, FK action, index (including partial
  `where`), `STRICT` and `WITHOUT ROWID` present in the loaded schema appears in the
  rendered DDL, and re-introspecting the applied DDL diffs empty against the original
  snapshot. Do **not** vendor anyone's schema into this repo — read it from disk.
- **Prove it**: with `D1ZZLE_FIXTURE_SCHEMA` pointing at acme's schema — 64 real
  tables, `WITHOUT ROWID` and append-only triggers via a sidecar `tableOptions` — the
  harness runs and passes; unset, the suite skips it and
  `npm run check` still exits 0. Needs `d1zzle/sqlite-core` added to the alias map in
  `vitest.config.ts` — that fixture imports it.
- **Where the path points**: in the d1zzle devcontainer the variable is preset to
  `/fixture/apps/api/src/db/schema/index.ts` (the parent checkout, mounted read-only by
  `docker-compose.yml`). Running inside the acme container instead, it is
  `/workspace/apps/api/src/db/schema/index.ts`.
- **Loading mechanism — settled empirically 2026-07-30, do not re-derive**: two throwaway
  probes (since deleted) established that `await import(<abs path>)` of the out-of-tree
  fixture works in **both** vitest projects, loading all 64 tables with every one of them
  recognised by *our* aliased copy of d1zzle — so there is no two-copy `instanceof`
  hazard. Two config lines are required, and are **already applied uncommitted** in
  `vitest.config.ts`:
  1. `'d1zzle/sqlite-core'` in the alias map, placed *before* the bare `'d1zzle'` key
     (prefix matching — after it, the shorter key wins and the import fails to resolve).
  2. The workers project cannot see `process.env`, so the path must be threaded in as a
     `define`d global (`__D1ZZLE_FIXTURE_SCHEMA__`). A `define` on
     `process.env.D1ZZLE_FIXTURE_SCHEMA` is *not* enough on its own: `define` is literal
     text substitution, so a bracket-notation read (`process.env['…']`, which this repo's
     tsconfig forces) is never substituted and the suite silently skips.
  Because the round-trip needs a real D1, the harness belongs in `kit/test/workers/`.
  Remaining work is only writing the test file against this recipe.
- **Fixture shape**, for the assertions: the sidecar is
  `/fixture/apps/api/src/db/table-options.ts` (default-exports a `tableOptions()` map),
  wired by `/fixture/apps/api/d1zzle.config.ts`. It sets `strict: true` on **all 64**
  tables, with `withoutRowid` and `appendOnly` drawn from a `hardening.ts` roster.

### [F-002] `dataTypeOf()` returns Drizzle v0 `dataType` strings — status: done (`15f24ef`, runtime only — see `[F-017]`) — severity: high — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/drizzle-entity.ts:91` (+ `ToDrizzleDataType`, `DataTypeOf<CT>` at `src/schema/columns.ts:407`)
- **Defect**: emits the flat v0 vocabulary (`'number'`, `'date'`, `'json'`, `'buffer'`, `'bigint'`, `'string'`) where Drizzle v1 uses a `"<type> <constraint>"` pair split on the space by `drizzle-orm/column-builder.js:4` `extractExtendedColumnType`; the *type-level* shape already uses v1 spellings, so type and runtime disagree.
- **Failure scenario**: `drizzle-orm/zod`'s `createSelectSchema` on the same table gives `ZodAny` for every timestamp/JSON/blob column, plain `ZodString` where the enum was, and an unchecked `ZodNumber` for ids. Generated request validators silently stop validating; nothing throws.
- **Fix**: return v1 strings (`'number int53'`, `'number double'`, `'object date'`, `'object json'`, `'object buffer'`, `'bigint int64'`, `'string numeric'`, `'string enum'` when `enumValues` set else `'string'`, `'boolean'`, `'custom'`) and delete `ToDrizzleDataType`'s remapping so the type derives from the same source.
- **Prove it**: `test/unit/drizzle-interop.test.ts:85-104` currently hard-codes d1zzle's own answers — replace with a table-driven comparison against a `drizzle-orm/sqlite-core` fixture asserting `d1.col.dataType === dz.col.dataType` for all column types, plus one `createSelectSchema` behavioural assertion.

### [F-003] `blob()` with no `mode` defaults to `buffer`; Drizzle v1 defaults to `json` — status: done (`15f24ef`) — severity: high — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:590`
- **Defect**: `mode = options?.mode ?? 'buffer'` contradicts `drizzle-orm/sqlite-core/columns/blob.js`, which falls through to `SQLiteBlobJsonBuilder`; the package declares `"drizzle-orm": ">=1.0.0-rc.1 <2"`.
- **Failure scenario**: `metadata: blob('metadata').$type<Meta>()` ported by changing the import specifier — writes hand the raw object to `.bind()` and fail with `D1_TYPE_ERROR: Type 'object' not supported`; reads of existing rows return a `Uint8Array` of raw JSON bytes while the declared TS type hides it. DDL is `blob` either way so `d1zzle-migrate check` stays green.
- **Fix**: `const mode = options?.mode ?? 'json'`, and flip the `BlobData<TMode>` / `BlobColumnType<TMode>` defaults so the type follows.
- **Prove it**: `test/unit/drizzle-interop.test.ts` — `blob('x').build('x').columnType === 'SQLiteBlobJson'` and a `mapToDriverValue`/`mapFromDriverValue` round trip; `test/workers/blob.test.ts` for the real-D1 half.
- **Note**: this is a behaviour change to an existing default. If any file under `docs/` states the old default, it is left untouched — see `[F-011]`.

### [F-004] `and()` / `or()` do not parenthesise their operands — status: done (`15f24ef`, split path only — see `[F-019]`) — severity: high — area: sql/compile — lens: feature — COMPAT-DEFECT
- **Where**: `src/sql/expressions.ts:98`
- **Defect**: operands are joined bare and only the whole is wrapped; Drizzle wraps each (`sql.join(conditions.map((c) => sql\`(${c})\`), ' and ')`). d1zzle's own `or()` self-parenthesises, so the hole is any operand it did not build — a `sql` fragment or a `RAW` filter.
- **Failure scenario**: `and(sql\`title like 'a%' or title like 'b%'\`, eq(posts.views, 0))` renders `(a like ? or b like ? and views = ?)`, which parses as `a OR (b AND views = 0)` — every row matching the first `like` comes back regardless of `views`. Reachable from the RQB, where `RAW` is combined with column filters by `and(...parts)` at `src/relations/filter.ts:425`; `src/relations/filter.ts:15` notes Pothos builds its batching predicate through `RAW`, so this is on an adapter path.
- **Fix**: in `combine`, wrap each present condition before joining — `sql.join(present.map((c) => sql\`(${c})\`), \` ${keyword} \`)`. Keep the single-condition passthrough (Drizzle does the same).
- **Prove it**: `test/unit/compile-select.test.ts` asserting the parenthesised SQL, plus a workers test inserting one row satisfying only the `or` branch and asserting the `RAW` `findMany` returns it zero times.

### [F-005] `$onUpdate()` is not applied on insert, but the column is marked defaulted — status: done (`15f24ef`) — severity: high — area: sql/compile — lens: feature — COMPAT-DEFECT
- **Where**: `src/plan/compile.ts:439`; `hasDefault` set at `src/schema/columns.ts:349`
- **Defect**: the insert field filter tests `defaultFn` alone, while Drizzle's `buildInsertQuery` also populates a column with only `onUpdateFn` (`else if (!col.default && col.onUpdateFn !== undefined)`). `InferInsert`'s `RequiredKeys` reads `hasDefault`, so TypeScript says the key is optional and the compiler then omits the column entirely.
- **Failure scenario**: `updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$onUpdate(() => new Date())` — `db.insert(t).values({ id: 1, name: 'x' })` typechecks and compiles without `updated_at`, giving `SQLITE_CONSTRAINT: NOT NULL constraint failed` at runtime. Without `.notNull()` it is worse: a silent `NULL` where Drizzle stores a timestamp.
- **Fix**: extend the filter with `|| (columns[field]!.config.onUpdateFn !== undefined && columns[field]!.config.default === undefined)` and make `defaultChunk` fall back to `onUpdateFn` under the same condition, matching Drizzle's `!col.default` guard exactly.
- **Prove it**: `test/unit/compile-write.test.ts` — the compiled insert includes `"updated_at"` with an `{ k: 'fn' }` slot; plus a workers test reading back a non-null `updatedAt`. `test/schema.ts`'s `users.updatedAt` already has `$onUpdate` and currently inserts NULL.

### [F-006] `customType`'s declared SQL type is discarded and replaced by a substring guess — status: done (`15f24ef`, but see `[F-021]`) — severity: high — area: ddl/render — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:666`; surfaced by `src/schema/columns.ts:214` `getSQLType()` and rendered at `src/ddl.ts:201`
- **Defect**: the string `dataType(config)` returns is thrown away, keeping only whichever of five storage classes it happens to *contain*, falling back to `'text'`. `'int'`, `'boolean'`, `'timestamp'`, `'json'`, `'datetime'` — all of Drizzle's own documented examples — contain none and become `text`.
- **Failure scenario**: `customType<{data:number}>({ dataType: () => 'int' })` renders `"n" text`; against real D1 the values `9`/`10` store as the strings `"9"`/`"10"`, `typeof(n)` is `text`, and `order by n` returns them **reversed**. `max`, `sum` and every range predicate compare lexicographically. Separately `kit/src/core/snapshot.ts:411 typeAffinity()` puts `int` in `integer`, so pointing `d1zzle-migrate` at a drizzle-kit-created database reports a spurious type change and `push` rebuilds the table.
- **Fix**: keep the declared string on `ColumnConfig` (e.g. `declaredType`), return it from `getSQLType()`, emit it from `ddl.ts:201 typeName()`. Reduce to a storage class only where the runtime needs a `SQLiteType`, using SQLite's real affinity rules — `typeAffinity()` in `kit/src/core/snapshot.ts:411` already implements them, including the `INT`-before-`CHAR` ordering the substring `.find()` gets wrong.
- **Prove it**: `test/unit/ddl.test.ts` — `dataType: () => 'int'` emits `"n" int`, `` dataType: (c) => `varchar(${c.length})` `` emits `varchar(10)`, and `col.getSQLType() === 'int'`; a workers probe pins the affinity.

### [F-007] `length` is stored but never surfaced on the column — status: done (`15f24ef`) — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:214`
- **Defect**: Drizzle exposes `length` and `isLengthExact` as public `Column` fields (`drizzle-orm/column.js:27`); d1zzle keeps `length` in `config` only, so anything reading the column object sees `undefined`.
- **Failure scenario**: `drizzle-orm/zod`'s `stringColumnToSchema` destructures `{ name, length, isLengthExact }` and applies `.max(length)`. With `text('name', { length: 5 })`, d1zzle's generated validator accepts `"abcdefghij"` and Drizzle's rejects it — the declared constraint disappears from every generated request schema.
- **Fix**: add `get length()` / `get isLengthExact()` to `Column`, reading from `config`.
- **Prove it**: `test/unit/drizzle-interop.test.ts` — `t.short.length === 5` and `isLengthExact` matching a `drizzle-orm/sqlite-core` fixture built the same way.
- **Split**: the reviewer also proposed emitting `text(5)` from `typeName()`/`getSQLType()` to match drizzle-kit's DDL bytes. That changes emitted migration output for every existing `text({length})` column and is parked as `[F-012]` — only the getters are in this batch.

### [F-008] `columns: {}` in a relational query selects every column; Drizzle selects none — status: done (`15f24ef`, split path only — see `[F-018]`) — severity: med — area: relations — lens: feature — COMPAT-DEFECT
- **Where**: `src/relations/projection.ts:20`
- **Defect**: `pickColumns` treats "no explicit `true`" as "everything except the `false`s", so an empty object falls through to all keys. Drizzle's `getSelectedTableColumns` (`drizzle-orm/sqlite-core/dialect.js:296`) leaves `colSelectionMode` `undefined` for an empty record and returns `[]`.
- **Failure scenario**: `db.query.users.findMany({ columns: {}, with: { posts: true } })` — the documented Drizzle idiom for "only the relations" — returns the full user row alongside `posts`, including a JSON blob the caller deliberately excluded. Under a Pothos layer deriving `columns` from the selection set, that is the whole table read on every field resolution.
- **Fix**: distinguish "no `columns` key" from "empty `columns` object" — `if (!selection) return keys;` then treat an entry-less selection as `[]` before the existing two branches. `compileSelect` already throws `'A select must project at least one column'` when nothing survives, which matches Drizzle throwing in the same spot.
- **Prove it**: `pickColumns(cols, {})` → `[]`; a workers test asserting `findMany({ columns: {}, with: { posts: true } })` rows have exactly the key `posts`.

### [F-009] `sum()` / `avg()` decode to `number`; Drizzle decodes to `string` — status: needs-human — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/sql/functions.ts:36,39`
- **Defect**: `drizzle-orm/sql/functions/aggregate.js` uses `.mapWith(String)` for `sum`/`avg` in every dialect, deliberately, because a 64-bit sum does not survive an IEEE double. d1zzle uses `nullable(Number)`.
- **Failure scenario**: `select({ total: sum(orders.cents) })` over a ledger past 2^53 returns a silently rounded number; code ported from Drizzle doing `BigInt(row.total)` throws `Cannot convert 1.2e+21 to a BigInt`.
- **Question for the human**: parity (`nullable(String)`, matching Drizzle, breaking every existing d1zzle caller) or keep `number` and document the divergence in `docs/08`'s "what compatibility does not extend to"? The reviewer flagged this as a judgement call, not a mechanical fix. Either answer touches published behaviour or `docs/`.

### [F-010] Three schema-facing spellings `drizzle-orm/sqlite-core` does not have — status: needs-human — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/core.ts:25` (`boolean`), `src/schema/constraints.ts:51` (`index()` with no name), `src/schema/constraints.ts:99` (`IndexConstraint.onOnly()`)
- **Defect**: `docs/08:67` makes "a symbol usable in a schema must also exist in Drizzle" a standing constraint, and the reverse-alias path (studio delegation) depends on it. `drizzle-orm/sqlite-core` has no `boolean` export; its `index(name: string)` requires the name; `onOnly` exists on Postgres' `IndexBuilderOn`, not SQLite's.
- **Failure scenario**: a schema using `boolean('active')` or `index().on(t.a)` cannot be aliased back to Drizzle — `boolean is not exported`. `json()` already carries a `@deprecated` block explaining exactly this (`src/schema/columns.ts:627`); `boolean` carries none.
- **Question for the human**: deprecate-and-keep (mirroring `json()`), or remove from the root entry? All three options change the published API surface, which this sweep may not do.
- **Reviewer's suggested test, if accepted**: a static assertion that every value exported from `src/sqlite-core.ts` is also a key of `import * as dz from 'drizzle-orm/sqlite-core'`.

### [F-011] `blob()` default-mode change may contradict `docs/` — status: needs-human — severity: low — area: docs — lens: feature
- Follow-up to `[F-003]`. If any design doc states the old `buffer` default, the doc is now wrong. The sweep may not edit `docs/`, so a human decides the wording.

### [F-012] `text(n)` / `getSQLType()` length in emitted DDL — status: needs-human — severity: low — area: ddl/render — lens: feature — COMPAT-DEFECT
- Split out of `[F-007]`. drizzle-kit writes `text(5)`; d1zzle writes `text`, so an emitted migration stops being byte-comparable with one an existing project has committed. `kit/src/core/snapshot.ts:411 typeAffinity` maps `TEXT(5)` → `text`, so the reviewer expects the snapshot diff to be unaffected — but this changes migration bytes for every existing `text({length})` column and needs a human to accept that.

### [F-013] `NEW-SURFACE` proposals from the feature lens — status: needs-human — severity: n/a — area: api — lens: feature
Recorded, not built — this sweep may not add published API surface. Ranked as the reviewer ranked them:

1. **`d1zzle-migrate generate --custom`** (`kit/src/cli.ts:16`) — the reviewer's highest-value item. drizzle-kit's escape hatch for an empty journalled migration you fill in by hand. Without it there is no supported way to put a data backfill, a trigger, or a `PRAGMA` into the migration history, and since `docs/09` makes each migration one `batch()`, hand-written SQL applied outside the journal loses that atomicity and desynchronises `meta/`.
2. **`.toSQL()` on every builder** (`src/builders/*`) — Drizzle's builders all have it; d1zzle has `.compile()` and `.toQuery()`. A three-line `toSQL(): { sql, params }` alias, a few dozen bundle bytes.
3. **`$dynamic()`** — d1zzle's builders are already immutable and re-assignable, so it can be `return this`; zero runtime cost and a very common Drizzle helper file compiles unchanged.
4. **`int` alias for `integer`** — one line (`drizzle-orm/sqlite-core/columns/integer.js` has `const int = integer`); a schema using `int` currently fails to import.
5. **`numeric(name, { mode: 'number' | 'bigint' })`** — v1 added `SQLiteNumericNumber`/`SQLiteNumericBigInt`; d1zzle's `numeric` takes only a name so the file does not port.
6. **`db.$count(table, where)`** — v1 shorthand, trivial over the existing select builder.
7. **`insert().select()`** — the only way to move rows between tables in one statement, which on D1 (no interactive transactions) is the difference between atomic and not.
8. **`update().from()` / `.orderBy()` / `.limit()`, `delete().orderBy()` / `.limit()`** — `.from()` is supported by D1 and currently unexpressible. `LIMIT` on `UPDATE`/`DELETE` needs `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which `docs/10:252` records D1 as lacking, so those must throw with that explanation rather than emit SQL D1 rejects.
9. **Set operations, CTEs, views, window functions** — already deferred at `docs/07:207`. `sqliteView`/`getViewConfig` additionally gate two adapter paths: Drizzle's `getColumns()` branches on `is(table, View)`, and Pothos accepts a view in `SchemaEntry`.

### [F-014] Interop tests assert against constants, not against Drizzle — status: todo — severity: med — area: test-harness — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `test/unit/drizzle-interop.test.ts:85-104`
- **Defect**: the file imports real `drizzle-orm` but asserts d1zzle's own `dataType` values as literals rather than comparing them against a Drizzle-built fixture. That shape — assert against a constant read off the implementation — is what let `[F-002]` and `[F-007]` ship, while `docs/10-ecosystem-interop.md:76` claims "Verified, not assumed".
- **Fix**: sweep the interop suite for assertions that never actually reference the `drizzle-orm` import, and convert them to comparisons.

### [F-015] Foreign-key derived name differs from Drizzle's — status: todo — severity: low — area: drizzle-compat — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/schema/table.ts:301`
- **Defect**: d1zzle derives `${table}_${column}_fk`; Drizzle's `ForeignKey.getName()` derives `${table}_${cols}_${foreignTable}_${foreignCols}_fk`. The kit compares FKs by content (`canonicalFk`, `kit/src/core/snapshot.ts:385`) so migrations are unaffected, but `getTableConfig(t).foreignKeys[i].name` differs from what an adapter reading Drizzle's would expect. No consumer found — recorded, not claimed.

### [F-016] `through.source` / `through.target` hold raw `Column`s, not `ColumnRef`s — status: todo — severity: low — area: relations — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/relations/define.ts:245`
- **Defect**: Drizzle's `Relation.through` holds `ColumnRef`s (`drizzle-orm/relations.js` maps `.map((c) => c._.through)`). `asDrizzleRelations()` copies the field verbatim, so an adapter reading `relation.through.source[0]._.column` off a re-prototyped relation gets `undefined`. Nothing shipped reads it today.

## Unresolved objections merged anyway (`15f24ef`)

The round-2 reviewer of `sweep/feature-20260730-160017` rejected the batch. Two review
rounds is the cap, the gate was green, so it merged under the sweep's own rule. These six
are the reviewer's objections, recorded verbatim because they are now claims about code on
`main`. `[F-017]` and `[F-018]` are **regressions this batch introduced** — a fix that
closed one hole and opened another — and are the highest-value work available to any lens.
The whole batch is revertible as one unit: `git revert -m 1 15f24ef`.

### [F-017] The `text()` enum fix inverts the mismatch it closed: every plain `text()` column now types as `'string enum'` — status: todo — severity: high — area: drizzle-compat — REGRESSION
- **Where**: `src/schema/columns.ts:459`
- **Defect**: `DataTypeOf` compares against the **readonly** tuple, but `Meta` is instantiated with `Writable<T>`, which strips `readonly`. Drizzle's own `text.d.ts:9` compares against the **mutable** `[string, ...string[]]`, matching the `SQLiteTextBuilder<Writable<T>>` it passes. For `text('c')` the uninferred `T` falls back to `Readonly<[U, ...U[]]>`, so `TEnum` = `[string, ...string[]]`, which is *not* `Equal` to the readonly target → `'string enum'`. The runtime correctly says `'string'`.
- **Failure scenario**: through the reverse-alias path `docs/08` exists to protect — `createSelectSchema(aliased).shape.email` is `ZodEnum<{[x: string]: string}>` where Drizzle gives `ZodString` (`drizzle-orm/zod/column.types.d.ts:23` branches on `constraint extends 'enum'`). At runtime the adapter reads `'string'` and builds a `z.string()`, so `.shape.email.options` type-checks and is `undefined` at execution. The same wrong branch reaches Pothos and drizzle-graphql via `_['dataType']`. Confirmed for `text('c')`, `text('c', { length: 5 })` and `text()`.
- **Fix**: change line 459 to `Equal<TEnum, [string, ...string[]]>`. The reviewer copied `src/` to a scratch dir, applied exactly that, and all four assertions pass (`text('c')`, `text('c',{length})`, `text()` → `'string'`; `text('c',{enum:['x','y']})` → `'string enum'` with `data: 'x'|'y'`).
- **Why nothing caught it**: the added type-level test in `test/unit/drizzle-interop.test.ts` only asserts the enum case, and the table-driven `dataTypeCases` has no plain `text()` row. Add one.

### [F-018] `columns: {}` on a nested relation emits `select  from …` under `relationalStrategy: 'joined'` — status: todo — severity: high — area: relations — REGRESSION
- **Where**: `src/relations/projection.ts:22` + `src/relations/joined.ts:253-262`
- **Defect**: new. Before `[F-008]`, `columns: {}` meant "all columns", so the joined builder always had a projection. Now `pickColumns` returns `[]`, `buildLevel` produces an empty `selection`, and `renderInner`'s `sql.join([], ', ')` yields nothing between `select` and `from`.
- **Failure scenario**: `db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: {} } } })`. Split strategy returns `[{id:1,posts:[{},{}]}, …]`; joined gives `D1_ERROR: near "from": syntax error at offset 79: SQLITE_ERROR` on `select json_group_array(json_object()) from (select  from "posts" …)`. This violates the invariant stated at `src/relations/joined.ts:85` — "`relationalStrategy` is a performance switch: it must not change which queries are legal" — which `supportsJoined` exists to uphold. Drizzle raises a clear `No fields selected for table "posts" ("posts")` (`sqlite-core/dialect.js:387`); d1zzle leaks a raw SQLite parse error.
- **Fix**: either `payloadIsExpressible` returns `false` for an empty payload (falling back to split, as it already does for blob payloads), or `buildLevel` raises Drizzle's message. Top-level `columns: {}` with a `with` is fine; only nested levels with no columns, no nested `with` and no `extras` break.

### [F-019] `[F-004]` is not closed on the joined path: predicates still concatenated with a bare `' and '` — status: todo — severity: high — area: relations — pre-existing
- **Where**: `src/relations/joined.ts:262`
- **Defect**: `combine()` in `expressions.ts` is fixed, but `renderInner` joins the correlation predicate, the caller's filter and the relation's declared `where` by raw string. `compileFilter` returns a lone `RAW` fragment unwrapped (`and()` of one operand returns it bare, matching Drizzle), so the fragment's own `or` binds looser than the correlation `and` — the exact defect `[F-004]` describes, on the exact path it names (RAW filter, the Pothos path).
- **Failure scenario**: `with: { posts: { where: { RAW: (t, { sql }) => sql\`${t.title} like 'f%' or ${t.views} = 1\` } } }` gives `("d0"."id" = "d1"."author_id" and title like 'f%') or views = 1`. Split returns `[{id:1,posts:[{id:10}]},{id:2,posts:[{id:12}]}]`; joined returns post 12 (author 2) materialised under user 1 as well.
- **Fix**: wrap each predicate — `predicates.map(p => sql\`(${p})\`)`.
- **Note**: pre-existing, but inside the blast radius of `[F-004]`; the new `relations.test.ts` RAW test only exercises the split path.

### [F-020] `InferInsert` still makes a `customType(...).primaryKey()` optional — status: todo — severity: high — area: sql/compile
- **Where**: `src/schema/columns.ts:334`
- **Defect**: the runtime half of `[F-005]`'s sibling gap was fixed but `primaryKey()`'s **return type** unconditionally adds `hasDefault: true`, so the type half was never fixed. Drizzle gates it: `ColumnBuilder.primaryKey(): TExtraConfig['primaryKeyHasDefault'] extends true ? IsPrimaryKey<HasDefault<this>> : IsPrimaryKey<this>` (`column-builder.d.ts:217`), and only the integer builders set `primaryKeyHasDefault: true` (`sqlite-core/columns/integer.d.ts:17`).
- **Failure scenario**: `const uuid = customType<string>({ dataType: () => 'text' }); db.insert(t).values({ name: 'x' })` type-checks with no cast, compiles to `insert into "t" ("name") values (?)` against `"id" text primary key not null`, and gives `NOT NULL constraint failed` at D1. The runtime `hasDefault` is now `false` (correct), so external adapters are fixed; d1zzle's own insert model is not.

### [F-021] `affinityOf` moves `ColumnSnapshot.type` for most customTypes — one unannounced destructive rebuild on upgrade — status: todo — severity: high — area: kit/diff
- **Where**: `kit/src/core/snapshot.ts:125` + `src/schema/columns.ts:732`
- **Defect**: the backward-compat claim holds only for the fixture chosen. `columnDifference` (`snapshot.ts:361`) compares `typeAffinity(column.type)` and ignores `declaredType`, so the added `ct2` test proves only that the *new field* is invisible. But `config.type` itself changed: the old reduction was a substring `.find()` over `['integer','text','real','blob','numeric']` with a `'text'` fallback; `affinityOf` applies SQLite's real rules. They disagree for `int`, `bigint`, `double`, `float`, `decimal(…)`, `boolean`, `datetime`, `point`, `jsonb` — everything except the five canonical spellings and strings whose old fallback happened to be `text`. `varchar(10)`, the fixture chosen for both new tests, is one of the coincidences.
- **Failure scenario**: reconstructing what 0.1.3 wrote (`type: 'text'`, no `declaredType`) for `customType(() => 'int')` produces `create table "__new_ct3" … reason: column "n" changes type` / `drop table "ct3"` with `destructive: true`. The migration is *right* — the live column really is `TEXT` and the schema means `int` — but every project with such a column gets an unannounced destructive-marked rebuild on the first `generate` after upgrading, which is the opposite of what `kit/test/unit/diff.test.ts`'s comment asserts.
- **Also**: the round-trip fixture table got only `varchar(10)`; the plain `int` case is not in it.

### [F-022] The rowid-alias test is case-sensitive; SQLite's is not — status: todo — severity: med — area: schema
- **Where**: `src/schema/columns.ts:346`
- **Defect**: `(this.config.declaredType ?? this.config.type) === 'integer'` misses `'INTEGER'`, `'Integer'`, `' integer'`.
- **Failure scenario**: verified on real D1 — `customType({ dataType: () => 'INTEGER' })('id').primaryKey()` gives `hasDefault === false`, yet `insert into "ct_pk2" ("name") values ('x')` succeeds with `id` auto-assigned. SQLite *does* treat it as the rowid alias while d1zzle reports the key as required. The direction is safe (an adapter supplies an id that would have been generated), but it is the case-insensitivity the previous round asked to confirm.
- **Fix**: `.trim().toLowerCase()` before the comparison.

### [F-023] Three minor items from the round-2 review — status: todo — severity: low — area: mixed
- `src/relations/projection.ts:23` — `keys.filter(key => entries.find(([k, v]) => k === key && v === true))` is an O(n·m) scan plus an `Object.entries` allocation per call, for an answer identical to `selection[key] === true` (an entry can only be `true` if it survived the `!== undefined` filter). Called per query per relation level. **Efficiency-lens item.**
- `src/schema/columns.ts:48,233` — `isLengthExact` is declared and exposed but never assigned by any column factory, so it is permanently `undefined`. That happens to match Drizzle for SQLite (only `pg-core`/`cockroach-core` set it), so `[F-007]`'s new test passes for a reason unrelated to the getter; it is dead weight in the shipped bundle.
- `test/unit/ddl.test.ts:141` — the pre-existing `expect(createTable(t)).toContain('"short" text')` now passes against `"short" text(10)`; the assertion survived a behaviour change without noticing it. A `toContain` where an equality belongs.

## Audit areas

Unchecked areas, roughly in descending order of what a bug there would cost. One
audit iteration takes exactly one line, scoped tightly, and appends findings above.

- [ ] **DDL rendering — what gets dropped.** `src/ddl.ts` and the kit's renderer against
      every constraint spelling: column/table `unique`, composite PK, `check`, FK actions,
      `not null`, defaults (literal, `sql`, `$defaultFn`), collations, generated columns,
      partial-index `where`, `STRICT`, `WITHOUT ROWID`.
- [ ] **Identifier quoting and binding.** Every path where an identifier or a value
      reaches a SQL string: quoting, escaping of embedded quotes, and whether any user
      value is interpolated rather than bound.
- [ ] **Predicate composition.** Operator precedence and parenthesization when `and`/`or`/
      `not` nest, and placeholder order vs. bound-parameter order.
- [ ] **Relational loading.** `src/relations/`: `Many` vs single-object resolution, parent
      duplication after a join, left→inner join degradation, all-null rows materialized as
      objects. (`instanceof Many` breaking silently is a known failure mode when two
      `drizzle-orm` copies are resolved.)
- [ ] **Migration applier.** `kit/src/core/apply.ts`: the 12-step rebuild preserving data,
      indexes, triggers, FKs; one `batch()` per migration (atomicity on D1); destructive
      statements marked and refused without `--accept-data-loss`.
- [ ] **Journal / snapshot consistency.** `kit/src/core/journal.ts`, `snapshot.ts`: can the
      emitted `.sql` and the snapshot disagree? That divergence is invisible to `check`.
- [ ] **Introspection fidelity.** `kit/src/core/introspect.ts`: type affinity, default
      normalization, and any comparison that reports a spurious diff (which `generate`
      turns into a destructive rebuild) or misses a real one.
- [ ] **D1 platform limits.** `src/limits.ts` and `docs/02`: bound-parameter ceiling,
      statement size, batch size, subrequest count — especially unbounded `in (...)`
      lists and unbounded batches.
- [ ] **Drizzle-compatibility subset.** `docs/08`: any schema-facing symbol that Drizzle
      lacks, and the reverse-alias path.
- [ ] **Hot-path cost.** Per-query allocation and string building in `src/sql/` and
      `src/plan/`; work done per row that could be hoisted per query.
- [ ] **Bundle bytes.** What `src/` contributes to a Worker bundle, and whether anything
      pulled in is dead weight (`test/unit/module-resolution.test.ts` already measures).
- [ ] **`better-auth` integration.** `src/better-auth.ts` against the peer's expectations.

## Blocked

_(nothing yet)_

## Notes for the human

- **Fixture privacy.** acme's schema is used as a *local* fixture through
  `D1ZZLE_FIXTURE_SCHEMA` and is never copied into this repo — d1zzle is published to
  npm, and a private product's table and column names should not ship in the tarball or
  land in public git history. If a bug is found through it, the committed regression test
  is a **minimal anonymized repro** in this repo's own fixture style.
- **`node_modules` is bind-mounted from a macOS host**, so platform binaries can be the
  wrong architecture in the container. Repaired for this session: esbuild
  (`node node_modules/esbuild/install.js`) and tsgo
  (`npm i --no-save @typescript/native-preview-linux-x64@7.0.0-dev.20260707.2`). Neither
  touched `package.json` or the lockfile. Re-run `npm install` on the host to restore its
  own binaries.
