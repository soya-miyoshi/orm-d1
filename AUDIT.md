# AUDIT.md — correctness / efficiency sweep

Working state for the `/audit-sweep` loop. Machine-written, human-editable — reorder,
delete, or re-rank anything here and the next iteration will follow it.

Gate: `npm run check` (typecheck → build → test → typecheck:kit → build:kit).
Baseline at sweep start: **green, 565 passed / 4 skipped**.
After the feature iteration (`15f24ef`): **green, 594 passed / 4 skipped**.
After the efficiency + bugs iteration (`516dbd5`): **green, 616 passed / 4 skipped**.
After the security iteration (`60ff73f`): **green, 644 passed / 4 skipped**.
After the iteration-4 feature pass (`91de9e1`): **green, 659 passed / 4 skipped**. Minified `src/core.ts` is 41,298 bytes (+1,083 this batch; `docs/01`'s target is ≤ 20 KB, blown long before this).

## Rotation

One lens per iteration, rotating `feature` → `efficiency + bugs` → `security` → repeat.
Advanced in every terminal case, including blocked and nothing-found, so a lens that keeps
failing cannot starve the other two.

- Next lens: **efficiency + bugs**
- Last ran: feature — 2026-07-30, merged `91de9e1` **over an unresolved round-2 rejection**.
  Three `COMPAT-DEFECT`s closed (`$onUpdate` in upserts, nullable-group collapsing, Drizzle's
  exact `snake_case`). Open from it: `[F-055]` (a regression — a `CompileError` that fires on
  queries which used to work, at the default budget), `[F-056]`, `[F-057]`, `[F-058]`, `[F-059]`.
- Ran before that: security — 2026-07-30, merged `60ff73f` **over an unresolved round-2 rejection**.
  Four findings; the round-2 reviewer confirmed the `pull` RCE (`[F-035]`) and the
  append-only gate (`[F-036]`) genuinely closed and rejected on six further points.
  `[F-043]` and `[F-044]` are misleading tests now on `main` and should be fixed before the
  defects they claim to cover. Also open: `[F-041]`, `[F-042]`, `[F-045]`, `[F-046]`, `[F-047]`.
- Ran before that: efficiency + bugs — 2026-07-30, merged `516dbd5` **over an unresolved round-2
  rejection**. Eight findings in the batch; the round-2 reviewer verified seven closed and
  rejected on the eighth. `[F-029]` is a regression against `main` and is the highest-value
  open item in this file. Also open from this iteration: `[F-030]`, `[F-031]`, `[F-032]`.
- Ran before that: feature — 2026-07-30, merged `15f24ef` **over an unresolved round-2 rejection**.
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

### [F-017] The `text()` enum fix inverts the mismatch it closed: every plain `text()` column now types as `'string enum'` — status: done (`516dbd5`) — severity: high — area: drizzle-compat — REGRESSION
- **Where**: `src/schema/columns.ts:459`
- **Defect**: `DataTypeOf` compares against the **readonly** tuple, but `Meta` is instantiated with `Writable<T>`, which strips `readonly`. Drizzle's own `text.d.ts:9` compares against the **mutable** `[string, ...string[]]`, matching the `SQLiteTextBuilder<Writable<T>>` it passes. For `text('c')` the uninferred `T` falls back to `Readonly<[U, ...U[]]>`, so `TEnum` = `[string, ...string[]]`, which is *not* `Equal` to the readonly target → `'string enum'`. The runtime correctly says `'string'`.
- **Failure scenario**: through the reverse-alias path `docs/08` exists to protect — `createSelectSchema(aliased).shape.email` is `ZodEnum<{[x: string]: string}>` where Drizzle gives `ZodString` (`drizzle-orm/zod/column.types.d.ts:23` branches on `constraint extends 'enum'`). At runtime the adapter reads `'string'` and builds a `z.string()`, so `.shape.email.options` type-checks and is `undefined` at execution. The same wrong branch reaches Pothos and drizzle-graphql via `_['dataType']`. Confirmed for `text('c')`, `text('c', { length: 5 })` and `text()`.
- **Fix**: change line 459 to `Equal<TEnum, [string, ...string[]]>`. The reviewer copied `src/` to a scratch dir, applied exactly that, and all four assertions pass (`text('c')`, `text('c',{length})`, `text()` → `'string'`; `text('c',{enum:['x','y']})` → `'string enum'` with `data: 'x'|'y'`).
- **Why nothing caught it**: the added type-level test in `test/unit/drizzle-interop.test.ts` only asserts the enum case, and the table-driven `dataTypeCases` has no plain `text()` row. Add one.

### [F-018] `columns: {}` on a nested relation emits `select  from …` under `relationalStrategy: 'joined'` — status: done (`516dbd5`) — severity: high — area: relations — REGRESSION
- **Where**: `src/relations/projection.ts:22` + `src/relations/joined.ts:253-262`
- **Defect**: new. Before `[F-008]`, `columns: {}` meant "all columns", so the joined builder always had a projection. Now `pickColumns` returns `[]`, `buildLevel` produces an empty `selection`, and `renderInner`'s `sql.join([], ', ')` yields nothing between `select` and `from`.
- **Failure scenario**: `db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: {} } } })`. Split strategy returns `[{id:1,posts:[{},{}]}, …]`; joined gives `D1_ERROR: near "from": syntax error at offset 79: SQLITE_ERROR` on `select json_group_array(json_object()) from (select  from "posts" …)`. This violates the invariant stated at `src/relations/joined.ts:85` — "`relationalStrategy` is a performance switch: it must not change which queries are legal" — which `supportsJoined` exists to uphold. Drizzle raises a clear `No fields selected for table "posts" ("posts")` (`sqlite-core/dialect.js:387`); d1zzle leaks a raw SQLite parse error.
- **Fix**: either `payloadIsExpressible` returns `false` for an empty payload (falling back to split, as it already does for blob payloads), or `buildLevel` raises Drizzle's message. Top-level `columns: {}` with a `with` is fine; only nested levels with no columns, no nested `with` and no `extras` break.

### [F-019] `[F-004]` is not closed on the joined path: predicates still concatenated with a bare `' and '` — status: done (`516dbd5`) — severity: high — area: relations — pre-existing
- **Where**: `src/relations/joined.ts:262`
- **Defect**: `combine()` in `expressions.ts` is fixed, but `renderInner` joins the correlation predicate, the caller's filter and the relation's declared `where` by raw string. `compileFilter` returns a lone `RAW` fragment unwrapped (`and()` of one operand returns it bare, matching Drizzle), so the fragment's own `or` binds looser than the correlation `and` — the exact defect `[F-004]` describes, on the exact path it names (RAW filter, the Pothos path).
- **Failure scenario**: `with: { posts: { where: { RAW: (t, { sql }) => sql\`${t.title} like 'f%' or ${t.views} = 1\` } } }` gives `("d0"."id" = "d1"."author_id" and title like 'f%') or views = 1`. Split returns `[{id:1,posts:[{id:10}]},{id:2,posts:[{id:12}]}]`; joined returns post 12 (author 2) materialised under user 1 as well.
- **Fix**: wrap each predicate — `predicates.map(p => sql\`(${p})\`)`.
- **Note**: pre-existing, but inside the blast radius of `[F-004]`; the new `relations.test.ts` RAW test only exercises the split path.

### [F-020] `InferInsert` still makes a `customType(...).primaryKey()` optional — status: done (`516dbd5`) — severity: high — area: sql/compile
- **Where**: `src/schema/columns.ts:334`
- **Defect**: the runtime half of `[F-005]`'s sibling gap was fixed but `primaryKey()`'s **return type** unconditionally adds `hasDefault: true`, so the type half was never fixed. Drizzle gates it: `ColumnBuilder.primaryKey(): TExtraConfig['primaryKeyHasDefault'] extends true ? IsPrimaryKey<HasDefault<this>> : IsPrimaryKey<this>` (`column-builder.d.ts:217`), and only the integer builders set `primaryKeyHasDefault: true` (`sqlite-core/columns/integer.d.ts:17`).
- **Failure scenario**: `const uuid = customType<string>({ dataType: () => 'text' }); db.insert(t).values({ name: 'x' })` type-checks with no cast, compiles to `insert into "t" ("name") values (?)` against `"id" text primary key not null`, and gives `NOT NULL constraint failed` at D1. The runtime `hasDefault` is now `false` (correct), so external adapters are fixed; d1zzle's own insert model is not.

### [F-021] `affinityOf` moves `ColumnSnapshot.type` for most customTypes — one unannounced destructive rebuild on upgrade — status: **failed twice** — superseded by `[F-029]` — severity: high — area: kit/diff
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

## Findings — efficiency + bugs lens (iteration 2)

**Batch composition, iteration 2.** The eight highest-severity implementable items went to
the coder: `[F-017]`, `[F-018]`, `[F-019]`, `[F-020]`, `[F-021]` (carried from iteration 1's
unresolved rejection) plus `[F-024]`, `[F-025]`, `[F-026]` (new). **Deferred from this
iteration for batch size**, not because they were judged unimportant: `[F-022]`
(case-sensitive rowid-alias test), `[F-023]` (three minor items), `[F-014]` (interop tests
assert against constants), `[F-015]` (FK derived name), `[F-016]` (`through` holds raw
columns). They stay `todo` and the next efficiency + bugs iteration owns them.

### [F-024] Expression indexes are quoted as identifiers — the kit emits an index on a constant string — status: done (`516dbd5`) — severity: high — area: kit/diff
- **Where**: `kit/src/core/snapshot.ts:312` (`createIndexFromSnapshot`), fed by `kit/src/core/snapshot.ts:189` and `kit/src/core/introspect.ts:282`
- **Defect**: `IndexSnapshot.columns` is a flat `readonly string[]` that cannot say whether an entry is an identifier or an expression. `snapshotFromSchema` writes `renderInline(chunk)` into it for a non-column entry and `createIndexFromSnapshot` then wraps every entry in `quote()`.
- **Failure scenario**: `index('users_lower_email_idx').on(sql\`lower(${t.email})\`)`. `src/ddl.ts:300` (the *other* emitter) gets it right; `d1zzle-migrate generate` emits `create index "users_lower_email_idx" on "users" ("lower(""email"")")`. SQLite's double-quoted-string-literal fallback makes that an index on the constant `'lower("email")'` — created, named, listed in `sqlite_master`, and never used (`SCAN t` vs `SEARCH t USING INDEX good (<expr>=?)`, verified on D1). The `uniqueIndex` variant is worse: every row hashes to the same constant, so the second insert gives `UNIQUE constraint failed` — a migration after which the table accepts exactly one row.
- **Second half**: `pragma index_info` reports an expression member as `{seqno:0, cid:-2, name:null}` and `introspect.ts:282` filters `null` out, so an expression index introspects as `columns: []`. Against a correctly-built database `check` exits non-zero forever and `push` runs `drop index` + recreate-the-constant-one — and `drop index` is marked `destructive: false`, so `--accept-data-loss` is not required. `pull` then renders `index('…').on()` with no columns (`kit/src/node/commands.ts:360`), a schema module that cannot compile back to valid DDL.
- **Fix**: `IndexSnapshot.columns` must carry the distinction — drizzle-kit's own snapshot stores `{ expression, isExpression }` per entry, and matching it keeps the import story. `createIndexFromSnapshot` quotes only when `!isExpression`; `snapshotFromSchema:189` sets `isExpression: !isColumn(c)`; `snapshotFromIntrospection` recovers the expression text from `sqlite_master.sql` (the column list between the `(` after `on "<table>"` and its matching paren — the same source `parseIndexWhere` already reads) instead of dropping `null` members.
- **Prove it**: add `index('flags_lower_name_idx').on(sql\`lower(${t.name})\`)` to the `flags` fixture in `kit/test/workers/roundtrip.test.ts` — the existing `expect(diffSnapshots(live, expected).statements).toEqual([])` fails immediately. Plus a `kit/test/unit/diff.test.ts` assertion that the statement contains `(lower("email"))` and not `("lower(""email"")")`. The current fixtures and the `fuzz.test.ts` generator only ever produce column-list indexes, which is why this survived.

### [F-025] The relational child chunker undercounts reserved parameters — `too many SQL variables` at the default budget — status: done (`516dbd5`) — severity: high — area: relations
- **Where**: `src/relations/query.ts:596`
- **Defect**: `reserved` counts the child's `where`, the relation's declared `where`, and the window bounds, then sizes each key chunk to `$maxParams - reserved`. The child's `orderBy` and `extras` bind into the *same* statement and are not counted, so the chunk it computes overflows the budget it was computed from. The comment directly above the calculation names exactly this hazard for `where` and the window bounds, then omits the two other places `#run` binds.
- **Failure scenario**: default `maxParams: 100`, a composite two-column relation key, 50 parents, and a nested `orderBy` that interpolates one value gives `D1_ERROR: too many SQL variables` — 50 × 2 key params + 1 = 101, because `maxKeys` was 50 with `reserved` at 0. The whole `findMany` throws. Same for `extras` (`Object.assign(selection, resolveExtras(...))` at `query.ts:427`).
- **Fix**: count them the same way `childFilter` is counted, in `#fetchChild` before `budget` — a `chunksOf` helper reducing `render(c, renderContextOf(this.db)).params.length` over `resolveOrderBy(entry.config.orderBy, targetColumns)` and `Object.values(resolveExtras(entry.config.extras, targetColumns))`. Both resolvers are module-scope in the same file and take exactly those arguments; double-invoking a callback is the cost the code already accepts for `compileFilter` ("Rendering the filters twice … is cheap next to the round trip it protects").
- **Prove it**: `test/workers/relations.test.ts`, in the existing `composite-key relations` block — 50 parents, default `maxParams`, a nested `orderBy` callback interpolating one value; assert the query resolves and that no statement's parameter count exceeds `$maxParams`.

### [F-026] `introspect()` issues `1 + 3T + I` sequential round trips — status: done (`516dbd5`, bounded at 12 in flight — see `[F-031]`) — severity: med — area: kit/efficiency
- **Where**: `kit/src/core/apply.ts:44-58`
- **Defect**: the per-table pragmas are `await`ed one at a time inside a `for` loop, and `pragma index_info` is `await`ed once per index inside that. Instrumented against the 3-table fixture: 16 queries for 3 tables and 6 indexes, confirming the formula.
- **Failure scenario**: a 64-table schema with ~3 indexes per table (counting the `sqlite_autoindex_*` entries every `UNIQUE`/composite PK creates, which `index_list` returns and this loop dutifully probes) is `1 + 192 + 192 ≈ 385` sequential POSTs to the Cloudflare API — `remoteRunner.all` is one `fetch` per call (`kit/src/node/runners.ts:157`). At a ~120 ms round trip that is ~46 s of wall clock for a single `d1zzle-migrate check --remote`, per CI run, and again for `push --remote` and `pull --remote`. There is no dependency between tables, and none between the `index_info` calls within a table.
- **Fix**: two dependent waves instead of `3T + I` serial trips — `Promise.all` over tables, and inside each table `Promise.all` over `[table_xinfo, foreign_key_list, index_list]` then `Promise.all` over that table's `index_info` calls. `SqlRunner.all` is already `async`; `localRunner` is synchronous underneath so `Promise.all` costs it nothing, and the workerd test runner is concurrency-safe. Nothing in `core/` changes shape, so the Node-free constraint holds.
- **Prove it**: a `kit/test/workers` case wrapping `SqlRunner.all` in a counter that also records concurrency depth — assert the number of *sequential waves* is O(1) rather than O(tables). Today the harness records 16 strictly serial calls for 3 tables.

### [F-027] `pull` emits introspected text straight into template literals — status: done (`60ff73f`, superseded by `[F-035]`) — severity: low — area: kit/node — lens: security (OFF-LENS from efficiency + bugs)
- **Where**: `kit/src/node/commands.ts:335,339,391`
- **Defect**: `.default(sql\`${column.default}\`)`, `check('${c.name}', sql\`${c.value}\`)` and `sqliteTable('${table.name}'` interpolate live database text into generated source. A backtick or `${` in a check expression, a default, or a table name produces a schema module that does not parse. Contrived to hit, but `uniqueIdentifier` right below it exists precisely because "files that do not compile, from a command whose whole job is to write one" is treated as a bug class here.

### [F-028] Index name recovered by regexing the rendered `CREATE INDEX` — status: todo — severity: low — area: kit/diff
- **Where**: `kit/src/core/snapshot.ts:184-186`
- **Defect**: recovers an index's name by rendering the full statement (including `renderInline` of the partial-index predicate) and regexing the name back out, when `indexName(extra.meta, name)` is exported from `src/schema/constraints.ts` and already imported by its two siblings (`foreignKeyName`, `uniqueConstraintName`) in the same import statement. Not a live defect; a fragile derivation next to two direct ones.

### Dropped by the reviewer after investigation (no failure scenario) — do not re-file
- `lowerIn` in `src/better-auth.ts:169` builds an unbounded `in (…)` with no budget check, unlike `inArray` — unreachable, `mode: 'insensitive'` appears nowhere in `better-auth`'s shipped `dist`.
- `compileInsert`'s per-row `Object.keys(columns).filter(...)` and `last.fields.join(...)` (`src/plan/compile.ts:446,456`) are hoistable, but a 500-row × 20-column insert compiles in 2.87 ms total, on a path that ends in a 100-statement `batch()`.
- `readRow`'s per-row closure allocation on the nested mapper path (`src/plan/mapper.ts:151,163`) — real but sub-microsecond against the RPC.
- `alter table … add column … references … default 'x'` is accepted by D1, so `isAddable` needs no extra guard.
- A kitchen-sink round trip (composite FK with `on delete set null`/`on update cascade`, `customType` declared type, enum text, `numeric` default, `sql` default, a default containing a quote, partial index, unique index, table-level unique, check) drifts by **zero** statements. The diff engine is solid; expression indexes are the hole.

## Unresolved objections merged anyway (`516dbd5`)

The round-2 reviewer of `sweep/efficiency-bugs-20260730-174800` verified seven of the eight
findings genuinely closed and rejected the batch on the eighth. Two review rounds is the
cap, the gate was green (616 passed / 4 skipped), so it merged under the sweep's own rule.
Revert the batch as one unit with `git revert -m 1 516dbd5`.

**`[F-029]` is the most serious thing in this file.** It is a *regression against `main`* on
this project's bug class #1 — a type change that silently disappears while CI stays green —
and it was introduced by the attempt to fix `[F-021]`. Two iterations have now failed to
land a correct fix for the `declaredType` comparison; the third attempt should probably
start by reverting `[F-021]`'s suppression entirely and accepting the noisy-but-visible
destructive rebuild instead, since a loud wrong answer beats a silent one here.

### [F-029] The legacy `declaredType` hatch fires on every ordinary column, so genuine type changes produce no migration — status: todo — severity: **high** — area: kit/diff — REGRESSION vs `main`
- **Where**: `kit/src/core/snapshot.ts:434` (`typeMatchesAcrossUpgrade`)
- **Defect**: the hatch gates on `old.declaredType === undefined`, treating that as "this snapshot predates `declaredType`". It is not. `kit/src/core/snapshot.ts:152` writes `declaredType: column.config.declaredType`, and `config.declaredType` is set **only** by `customType` (`src/schema/columns.ts:756`) — so *every* `integer`/`text`/`real`/`blob`/`numeric` column in a current, freshly-generated snapshot has `declaredType: undefined`, while `kit/src/core/introspect.ts:384` now guarantees the other side always has one. The hatch is live on the ordinary path, not the legacy one. Compounding it, `legacyAffinity` reproduces 0.1.3's rule, but 0.1.3 applied that substring rule *only inside `customType`* (`git show v0.1.3:src/schema/columns.ts:666`) — it is being applied to pairs it never described.
- **Failure scenario A — `generate`, no legacy snapshot involved, both sides current**: `customType(() => 'int')('amount')` → `text('amount')` gives `diffSnapshots(before, after).statements === []`. Same in reverse, and same for `text()` → `customType(() => 'double')`. The column changes from INTEGER (or REAL) affinity to TEXT and `generate` writes an empty migration. The branch's new test only covers `customType`-vs-`customType`, the one pair where both sides carry `declaredType`.
- **Failure scenario B — `check`/`push`/`verify` against a real D1**, schema says `text('amount')`, live column declared as shown: `INT`, `BIGINT` (integer affinity) → **0 statements**; `DECIMAL(10,5)`, `BOOLEAN`, `DATETIME` (numeric) → **0**; `FLOAT`, `DOUBLE` (real) → **0**; no type at all (blob) → **0**. Controls `INTEGER`/`REAL`/`BLOB` correctly emit 5. On `main` before this branch all eleven reported the change. `INT` is the ordinary hand-written and drizzle-kit spelling, so this is the common case: a table whose `amount` is `INT` in the database and `text()` in the schema passes `check` silently, `push` emits nothing, and the ORM binds strings into an INTEGER-affinity column.
- **`verify` is hit by the same hole** (`kit/src/node/commands.ts:596`) — and its own docstring says it exists precisely because "the renderer drops a constraint, both artifacts are self-consistent, and CI stays green". That is now true of column types.
- **Fix**: the hatch needs a signal that actually means "written before `declaredType` existed" (`Snapshot.version`, or `origin` — neither of which `canonicalTable`/`columnDifference` currently sees), or it must be restricted to pairs where the side carrying `declaredType` is a `customType` column. Stamping `declaredType` on introspected snapshots (`introspect.ts:384`) is fine on its own — the reviewer confirmed byte-identical `pull` round trips and that everything else reading it only emits DDL from the *target* side — but it fixes only one of the two sides.

### [F-030] `canonicalizeExpression` strips whitespace inside quoted identifiers, so two different columns compare equal — status: todo — severity: med — area: kit/diff
- **Where**: `kit/src/core/diff.ts:584`
- **Defect**: the regex `/'(?:[^']|'')*'|\s+/g` protects single-quoted literals but not quoted identifiers, and SQLite allows a space in a column name.
- **Failure scenario**: with columns `"a b"` and `"ab"` both on the table, `index('t_idx').on(sql\`lower("a b")\`)` → `index('t_idx').on(sql\`lower("ab")\`)` gives `statements === []`. The control (`lower("x")` → `lower("y")`) correctly emits a drop and a create. The index keeps pointing at the wrong column forever, with no diff.
- **Fix**: keep `"…"`, `` `…` `` and `[…]` segments verbatim, the same way the single-quoted-literal branch already does.

### [F-031] `ConcurrencyGate` is not a correct semaphore — status: todo — severity: low (latent) — area: kit/core
- **Where**: `kit/src/core/apply.ts:56`
- **Defect**: `run` releases with `inFlight--` *before* `queue.shift()?.()`, and the woken waiter never re-checks `inFlight` after resuming. A caller arriving in the microtask window between the release and the waiter's resumption sees a free slot and takes it; the waiter then increments on top. With `limit = 1` the reviewer measured a peak of 2.
- **Not live today**: across 64 tables × 3 indexes with microtask, macrotask, randomised and zero delay the peak was exactly 12 every time, because a table's `index_info` dispatch is always ordered after the woken waiter's resumption by `Promise.all`'s extra tick. It is a hazard for the next call site, not this one.
- **Fix**: loop `while (this.inFlight >= this.limit) await …`, or increment the count in the releaser on behalf of the waiter.

### [F-032] `IndexColumnSnapshot` / `normalizeIndexColumn` are unexported from the kit's public entry — status: needs-human — severity: low — area: api
- **Where**: `kit/src/core/index.ts:27`
- `IndexSnapshot.columns` is exported from `d1zzle-migrate/core`, but the new `IndexColumnSnapshot` member type and the `normalizeIndexColumn` helper are not, so an external consumer now reads a union whose object member is unnameable from the public entry. Construction still compiles; only reading is affected. Exporting them changes the published API surface, which the sweep may not do.

## Findings — security lens (iteration 3)

### [F-033] A migration split across batches cuts through a table rebuild — `drop table` commits without its `rename` — status: done (`60ff73f`, **partial** — see `[F-041]`, `[F-043]`, `[F-044]`) — severity: high — area: kit/apply
- **Where**: `kit/src/core/apply.ts:189-192`, and the identical loop in `kit/src/node/commands.ts:232-234` for `push`
- **Defect**: the split is a blind fixed stride over a flat statement list, so it can fall *inside* the five-statement rebuild group `recreateTable` emits (`kit/src/core/diff.ts:263-284`) — between `drop table "X"` and `alter table "__new_X" rename to "X"`. The first batch commits.
- **Failure scenario** (reproduced): a migration creating 96 tables then rebuilding `orders` compiles to 102 statements; statement 100 is `drop table "orders"` and 101 is the rename. With the second batch failing (a D1 500, a 429, a dropped connection on `--remote`, or CI being killed), `orders` is gone and the rows survive only in `__new_orders`.
- **Three things compound it**: (1) the `record` insert is a *separate* batch (`apply.ts:192`), so the migration is unrecorded — the retry replays statements 1–100 and throws `table … already exists`, permanently stuck; (2) `PRAGMA defer_foreign_keys = ON` (`diff.ts:270`) is transaction-scoped, so a `drop table` landing in a later batch is no longer deferred and fails against any child table, turning a merely-large migration into this failure by construction; (3) `isInternalTable` (`kit/src/core/introspect.ts:72-73`) does not exclude `__new_*`, so the next `push` emits `create table "orders"` **plus** `drop table "__new_orders"` — destroying the only remaining copy of the rows.
- **The warning is not a mitigation**: `migrate` logs it at `kit/src/node/commands.ts:189`, *after* `applyMigrations` has returned. (`push` at line 228 does log first.)
- **Fix**: make the rebuild an indivisible unit the packer can see — give `Statement` a `group` id (or return `readonly Statement[][]` from `diffSnapshots`) and have both `applyMigration` and `push` pack whole groups into batches, never splitting one; refuse outright if a single group exceeds `MAX_STATEMENTS_PER_BATCH`. Append `record` to the last batch rather than issuing it alone. Log the split warning before the first `runner.batch`.
- **Prove it**: a fake `SqlRunner` recording each batch, asserting no batch contains `drop table "X"` unless the same batch contains its rename, and that the final batch carries the `d1_migrations` insert; plus the >100-statement migration above in `kit/test/workers/migrate.test.ts` with a runner that throws on batch 2, asserting `orders` still exists with its rows.

### [F-034] The 12-step rebuild destroys every trigger except the append-only guard, and nothing can detect the loss — status: done (`60ff73f`, conservative refusal — bypasses remain, see `[F-042]`, `[F-045]`) — severity: high — area: kit/diff
- **Where**: `kit/src/core/diff.ts:286-296` (rebuild re-creates `after.indexes` and, if set, `appendOnlyTrigger`, nothing else); `kit/src/core/introspect.ts:288-293` (`snapshotFromIntrospection` reads triggers only through `isAppendOnlyTrigger`)
- **Defect**: `docs/09-d1zzle-migrate.md:127` specifies the recipe as "recreate indexes, triggers, and views that referenced the table". Triggers are not recreated, are not in `TableSnapshot`, and are not compared by `canonicalTable` — so `check`, `verify` and the next `push` all report the table as matching.
- **Failure scenario** (reproduced): a live `BEFORE INSERT` trigger raising `ABORT` unless `email = lower(email)`. Change `age` from `text` to `integer` and `push` emits the five rebuild statements with no `create trigger` anywhere. The guard is gone, mixed-case emails insert cleanly, and introspecting the result diffs `statements: [], errors: []` — `check` prints "Up to date, no drift." Exactly the `docs/09` failure mode the project exists to prevent, one object over from `unique()`.
- **Same class, smaller**: when a rebuild fires for any other reason, `diff.ts:459` `continue`s past the `appendOnly` transition block at `diff.ts:505-515`, so a live append-only table rebuilt while `tableOptions` no longer marks it append-only loses the guard with no `reason` line naming it.
- **Two fixes the reviewer offered**: (a) carry triggers in the snapshot — `introspect()` already selects `type = 'trigger'` (`apply.ts:79-81`) so the SQL text is in hand; add `triggers` to `TableSnapshot`, re-emit after the rename, include in `canonicalTable`. (b) Minimum viable: refuse the rebuild when the live table carries a trigger the kit did not author, the same way `recreateTable` already refuses on dependents (`diff.ts:220-233`).
- **This iteration implements (b)**, deliberately. (a) changes `TableSnapshot`'s shape, and the two previous iterations both drew their unresolved rejections from snapshot-shape changes — `[F-029]` is still open from exactly that class. (b) converts silent invariant loss into a loud refusal with no format change. **`[F-040]` carries (a) as the real fix for a human to schedule.**

### [F-035] `pull` reaches arbitrary code execution in the CLI's own Node process — status: **done** (`60ff73f`, confirmed closed by round-2 review) — severity: **high** — area: kit/node
- **Where**: `kit/src/node/commands.ts:298` (table name), `:335` (generated expression), `:339` (default), `:363` (expression index member), `:367` (partial-index `where`), `:369`, `:379` (index / unique names), `:397` (check name and body)
- **Defect**: this is the escalation of the previously-known "produces a module that does not parse" (`[F-027]`). Everything introspected is dropped into `` sql`…` ``, so a `${` in the source text becomes a **JavaScript expression evaluated at module load**.
- **Failure scenario (a)** — no quote balancing needed. A plain SQLite `DEFAULT` text literal: `create table "notes" ("id" integer primary key, "body" text default '${globalThis.__PWNED__ = 1}')`. `renderSchemaModule` emits `` body: text('body').default(sql`'${globalThis.__PWNED__ = 1}'`) ``. The module parses, and the interpolation runs the moment it is imported. The check-constraint path is identical via a comment inside a `CHECK` body.
- **Failure scenario (b)** — quote break-out that still compiles. Table names go into a single-quoted literal with no escaping; a table named `` a', {}); globalThis.__PWNED3__ = 3; export const zz = sqliteTable('b `` yields a module the reviewer confirmed compiles cleanly through esbuild's TS loader.
- **Why it is reachable**: `pull` exists to adopt a database you did not create (`kit/README.md:41`). The workflow is `pull` → point `d1zzle.config.ts` at the emitted `schema.ts` → `generate`. `generate` calls `loadSchema` → `importModule` (`kit/src/node/import.ts:75`), which **imports the module in the CLI's own Node process** — with `CLOUDFLARE_API_TOKEN` in `process.env` and the developer's credentials on disk. Code execution happens on the next command. If the module is then deployed, it runs in the Worker too. The precondition is an actor able to run DDL on the introspected database — precisely the situation `pull` is for.
- **Fix**: stop building the module by interpolation. Emit every string literal with `JSON.stringify(value)`, and every SQL fragment as `sql.raw(${JSON.stringify(text)})` instead of `` sql`${text}` `` — `Raw` has `toQuery`, so `ColumnBuilder.default` still classifies it as `kind: 'sql'` and `renderInline` reproduces the same DDL.
- **Prove it**: `kit/test/unit/cli.test.ts` — `renderSchemaModule` over a snapshot whose table name, index name, check name, check body, default and partial-index `where` each contain `` ` ``, `${`, `'` and `\`; feed the output through `esbuild.transform({ loader: 'ts' })` and assert it parses, that the emitted code contains no `${` beyond the ones the renderer itself wrote, and that re-parsing reproduces the input snapshot.

### [F-036] Dropping the append-only guard escapes `--accept-data-loss` when the table is renamed in the same migration — status: **done** (`60ff73f`, confirmed closed by round-2 review) — severity: med — area: kit/diff
- **Where**: `kit/src/core/diff.ts:334`
- **Defect**: `if (t.appendOnly) statements.push({ sql: dropAppendOnlyTrigger(name), destructive: false })`. The in-place transition at `diff.ts:509-513` marks the identical statement `destructive: true` with the reason `"X" is no longer append-only, so UPDATE is permitted again` — the code explicitly argues that removing this protection is "worth saying out loud rather than doing quietly". The rename path does it quietly, and because line 335 sets `appendOnly: false` on the carried-forward table, the destructive branch at 505 never fires afterwards.
- **Failure scenario** (reproduced): with `tableOptions([[auditLog, { appendOnly: true }]])`, renaming `audit_log` → `audit_events` and dropping it from `tableOptions` gives `generate --rename-table audit_log=audit_events` success with no flag — the audit table becomes rewritable. The identical change without the rename is refused with "This migration would lose data … Re-run with `--accept-data-loss`".
- **Fix**: at `diff.ts:334`, mark it `destructive: true` with the reason from line 512 unless the guard is re-created under the new name in the same diff — non-destructive only when `after.tables[renamed]?.appendOnly === true`.
- **Prove it**: `kit/test/unit/diff.test.ts` — the pair above, asserting `diff.statements.some(s => s.destructive)` in *both* the in-place and the renamed case, and that renaming an append-only table that *stays* append-only emits `drop trigger` + `create trigger` with neither marked destructive.

### [F-037] `AUDIT.md` names a private product and its schema shape, in a repo that is published to npm — status: **needs-human** — severity: med — area: privacy
- **Where**: this file — the `[F-001]` block and the fixture note near the end
- **What it discloses**: the customer name "acme", its container mount paths (`/fixture/apps/api/src/db/schema/index.ts`, `.../table-options.ts`, `d1zzle.config.ts`), and structural facts about its schema — 64 tables, `strict: true` on all 64, `withoutRowid` and `appendOnly` drawn from a `hardening.ts` roster. No table or column names leak, and `AUDIT.md` is excluded from the npm tarball (`files` does not list it), so this is disclosure of a customer name and coarse schema shape rather than of the schema itself.
- **Not yet published**: `AUDIT.md` first appears in `c9aabd7`, which is on no remote branch — `origin/main` is still `a027589`. **It becomes a disclosure the moment these commits are pushed.** The authors already flagged fixture privacy in the note at the end of this file; the metadata in the same file is the part that was not scrubbed.
- **Question for the human**: scrub the name and the paths (replacing them with "the parent checkout" and an env var reference), add `AUDIT.md` to `.gitignore` and keep it untracked, or accept the disclosure? The sweep will not decide this. Note that keeping it untracked would also restore the assumption the `/audit-sweep` skill makes about this file.

### [F-038] `importModule` writes a copy of the user's schema into their source tree — status: todo — severity: low — area: kit/node
- **Where**: `kit/src/node/import.ts:79-85`
- **Defect**: writes a `.d1zzle-<pid>-<n>.mts` copy of a schema module *inside the user's source tree* and removes it in a `finally`. A crash or `SIGKILL` between the two leaves an importable duplicate of the schema next to the original, which a `**/*.mts` glob in a build or test config will pick up.

### [F-039] `drop index` is non-destructive even for a unique index — status: todo — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:609`
- **Defect**: marked `destructive: false` even for a unique index, while the table-level `unique()` spelling of the same removal forces a rebuild and is therefore gated. Same semantic loss, two different gates. The reviewer filed it as an inconsistency, not a finding — there is no failure scenario beyond the asymmetry.

### [F-040] Carry triggers in `TableSnapshot` — the real fix for `[F-034]` — status: needs-human — severity: high — area: kit/diff
- `[F-034]` lands the conservative half (refuse a rebuild that would silently drop a foreign trigger). The complete fix is to add `triggers: Record<string, { name: string; sql: string }>` to `TableSnapshot`, re-emit each after the rename in `recreateTable`, and include them in `canonicalTable` so drift is visible. That changes the snapshot format and `TableSnapshot` is exported from `d1zzle-migrate/core`, so it is an API change the sweep may not make — and the last two snapshot-shape changes both produced unresolved rejections (`[F-029]` is still open). A human should schedule this deliberately.

### Checked and found sound by the security lens — do not re-file
- **Identifier quoting in `src/`**: every path goes through `quoteIdentifier` (`src/sql/sql.ts:130`), `Identifier`, `joined.ts:50`'s `quote`, or `snapshot.ts`/`diff.ts`'s local `quote` — all escape `"` by doubling. `writeFrom`, `writeProjection`, `writeAssignments`, `compileInsert/Update/Delete`, `filter.ts:331/336`, `joined.ts:229/258/265` and `better-auth.ts:500` all covered. No unquoted identifier reaches SQL.
- **Values are bound**: `limit`/`offset` are the only literals in the text (`plan/compile.ts:281-293`), `Number.isFinite`-validated and `Math.trunc`ed; the joined plan binds them through the `sql` tag. `fromDrizzleSQL` passes `inlineParams: false` with a correct `escapeString`/`escapeName`.
- **Prototype keys in the object filter DSL fail closed**: `filter.ts:406/412` will pick up `columns['constructor']`, but the result binds a function as a parameter and D1 rejects it — no predicate is widened or dropped.
- **Isolate-scoped state in `src/`**: the only module-level mutables are `casingMode` (`schema/columns.ts:75-79`, throws on conflicting reconfiguration), `devEnabled`/`warnFn` (`dev.ts:10,23`), a stateless `TextEncoder` cache (`limits.ts:51`) and a fixed-key class cache (`columns.ts:309`). Compiled queries, `InvocationBudget` and `withRelations` are per-object. No cross-request or cross-tenant leak constructible.
- **Published tarball and git history are clean**: `npm pack --dry-run` gives 162 files — `dist` + 11 `docs/*.md` + README + LICENSE. No credentials, no `.env`, no `.tsbuildinfo`; the `.js.map` files carry no `sourcesContent`. `wrangler.jsonc` has `"database_id": "local"`. No high-entropy token, account id or database id anywhere in `git rev-list --all`, and no private schema module was ever committed.
- **`check` is genuinely read-only** (`commands.ts:538` passes `create = false`; `introspect` issues only reads).
- **`--accept-data-loss` parsing fails closed**: `--accept-data-loss=true` yields the string `'true'`, which `asTargetFlags` (`cli.ts:137`) rejects. `--local`/`--remote` default to local.

## Unresolved objections merged anyway (`60ff73f`)

The round-2 reviewer of `sweep/security-20260730-191312` confirmed the `pull` RCE fix and the
append-only rename gate genuinely closed, and rejected the batch on six further points. Two
review rounds is the cap, the gate was green (644 passed / 4 skipped), so it merged under the
sweep's own rule. Revert as one unit with `git revert -m 1 60ff73f`.

**`[F-043]` and `[F-044]` are two misleading tests now on `main`** — one asserts the opposite
of what its own title claims, the other passes against untouched state. A test that pins the
bug under a name claiming the fix is worse than no test, and it is the same
"both artifacts agree so CI stays green" shape `docs/09` describes. Fix those two first,
before the defects they were supposed to cover.

### [F-041] The rebuild group stops at the rename, so a `UNIQUE` index can still be split off and silently lost — status: todo — severity: **high** — area: kit/apply
- **Where**: `kit/src/core/sql.ts:161-203` (`statementGroups`), against `kit/src/core/diff.ts:311-321`
- **Defect**: `statementGroups` closes the group at `alter table "__new_X" rename to "X"`, but `recreateTable` emits the table's indexes and its append-only trigger *after* that rename — that is where the rebuild restores its constraints. Those become singleton groups, so `packIntoBatches` will put the boundary immediately after the rename.
- **Failure scenario** (95 filler creates + a rebuild of a table carrying `uniqueIndex('orders_code')`, batch 2 failing on a D1 500 / 429 / dropped `--remote` connection): batches are `[100, 2]` with batch 2 = `create unique index "orders_code" …` + the `d1_migrations` insert. On real D1: `indexes on orders after the failed migration: []`, two rows now share `code='A'` — the UNIQUE constraint is gone — the migration is unrecorded, and the retry dies on `table "f0" already exists`. `push` self-heals on re-run; `migrate` does not.
- **Why it matters more than it looks**: this is `docs/09`'s reason-for-existence failure — a `unique()` constraint gone with nothing reporting it — reproduced *through the code path this batch rewrote*. It is not a new hole (fixed-stride slicing could cut here too), but the fix redefines "what must stay in one batch" and leaves the constraint-restoring tail of the rebuild outside that definition.
- **Fix**: extend the group through the index and trigger statements `recreateTable` emits after the rename, so the whole rebuild — including constraint restoration — is indivisible.

### [F-042] A rename in an *earlier pending migration* still bypasses the trigger guard — status: todo — severity: high — area: kit/apply
- **Where**: `kit/src/core/apply.ts:284-304`
- **Defect**: `parsed` computes `renames` per migration and the lookup is `migration.renames[table] ?? table`, so only a rename inside the *same file* is resolved. Renames from earlier pending migrations in the same `migrate` run are not accumulated, while the live `foreignTriggers` map is keyed by the pre-run `tbl_name`.
- **Failure scenario** (proven on real D1): `0001_rename` = `alter table "orders" rename to "sales"`, `0002_retype` = a type change forcing a rebuild of `sales`, with trigger `orders_audit` live on `orders`. `applyMigrations(runner, [m1, m2])` issues no refusal; triggers after migrate: `[]`. Generating a rename migration, then a schema change, then deploying and running `migrate` once is the ordinary workflow. The same hole swallows the error message's own recommended remedy: a `create trigger` hand-added to migration N and a rebuild in migration N+1, both pending, applies with no refusal.
- **Fix**: fold each migration's renames into a running name→live map *before* checking that migration's rebuilt tables, instead of resetting per file.
- **Secondary**: the scanner only recognises the kit's own double-quoted spelling — a hand-written `alter table orders rename to sales;` is not seen.

### [F-043] The gap-2 fix is a no-op, and its test asserts the opposite of its own title — status: todo — severity: **high** — area: kit/apply + test-integrity
- **Where**: `kit/src/core/apply.ts:215`; test at `kit/test/unit/apply.test.ts:122-133`
- **Defect**: replacing the explicit "append record to last batch if room" with `packIntoBatches([...statements, record], MAX)` is byte-for-byte identical in every case. Measured side by side: 99 → `[100]`, 100 → `[100, 1]`, 101 → `[100, 2]`, 200 → `[100, 100, 1]` — identical for both implementations. At any exact fill the record is still alone in its own trailing batch.
- **Failure scenario**: a 100-statement migration commits batch 1, batch 2 (the record alone) fails, the schema change is applied but unrecorded, and the next `migrate` dies on `table … already exists` — permanently stuck.
- **The test integrity problem**: `kit/test/unit/apply.test.ts:122-133` is titled `does not push the record into its own trailing batch when the real statements fill the last batch exactly (gap 2)` and **asserts** `expect(batches[1]).toEqual([insert into "d1_migrations" …])` — i.e. it pins the behaviour its own name says is fixed.
- **Fix**: either do the real work (shift the last singleton run into the trailing batch with the record, or reserve a slot) or withdraw the claim and rename the test to describe what it actually pins. It cannot stay as it is.

### [F-044] The flagship regression test for the batch-split finding exercises nothing — status: todo — severity: **high** — area: test-integrity
- **Where**: `kit/test/workers/migrate.test.ts:238-247`
- **Defect**: `applyMigrations` issues `ensureMigrationsTable` as its own `batch()` first, so `calls === 2` is the *first real batch*, not the second. The migration applies zero statements, and the assertions (`rebuilt` present, one row, `Number(age) === 30`) pass against the untouched pre-migration state — `age` is still the text `'30'`. The split-across-batches failure the test is named for is never reached.
- **Fix**: correct the off-by-one to `calls === 3`. The reviewer notes that doing so is exactly what exposed `[F-041]`, so expect this test to go red until `[F-041]` is fixed too.

### [F-045] `from.startsWith('__new_')` excludes real renames, giving a third guard bypass — status: todo — severity: med — area: kit/apply
- **Where**: `kit/src/core/apply.ts:253`
- **Defect**: the exclusion rule cannot distinguish a rebuild's closing rename from a genuine `--rename-table` whose *source* table is named `__new_*` — a table the codebase itself acknowledges exists (`diff.ts:412`, "a real table someone genuinely named `__new_orders`").
- **Failure scenario** (verified): for live table `__new_orders` with trigger `nn_audit`, `generate --rename-table __new_orders=orders_v2` plus a type change produces a migration where `checkForeignTriggerConflicts` does not throw, and `drop table "orders_v2"` takes the trigger. Narrow precondition, same silent-loss outcome. The non-renamed rebuild of a `__new_*` table is handled correctly — the temp name becomes `__new___new_stuff` and the guard fires.

### [F-046] A *refused* rebuild now emits a statement — status: todo — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:553-559`
- **Defect**: `recreateTable`'s contract is "no statements alongside the refusal" (`diff.ts:237-240`), but the new append-only block runs after the `recreateTable` call regardless of whether it refused, so both refusal paths emit a lone destructive `drop trigger if exists …`. Also reproduces for the pre-existing dependents refusal.
- **Not reachable as a bad outcome** — `generate` and `push` throw on `errors` before reading `statements` — but `check` now prints a `Drift:` line for a table it simultaneously reports as blocked.

### [F-047] `applyMigrations` gained an optional `onWarning` parameter and can now throw where it previously applied — status: needs-human — severity: med — area: api
- **Where**: `kit/src/core/apply.ts:339-372`; exported from `kit/src/core/index.ts:8`
- The parameter itself is additive, optional, and cannot break a consumer in either assignment direction. **The undisclosed change is behavioural**: `applyMigrations` now issues an extra `sqlite_master` read and can **throw** (the foreign-trigger refusal) where it previously applied. If the standing rule is "no changes to published functions", that behavioural change is covered by it, and it is the part a human should sign off on — not the parameter.
- **Related**: `applyMigration` (singular) is also public and does **not** call the guard, so the protection is inconsistent across the two published entry points. `checkForeignTriggerConflicts` is correctly not exported.

### Confirmed closed by the round-2 reviewer
- **`[F-035]` the `pull` RCE**: no `` sql`${…}` `` or `'${…}'` interpolation of introspected text survives in `renderSchemaModule`; identifiers go through `toIdentifier`, which strips to `[A-Za-z0-9_]`. Inert against U+2028, U+2029, lone surrogates, `\\`, `\n`, `\r`, backtick, `*/`, `'))//` and `</script>`. `sql.raw('(unixepoch())')` snapshots identically to `` sql`(unixepoch())` `` — zero migration churn.
- **`[F-036]` the append-only gate**: destructive with a reason in both the renamed and in-place transitions.
- **`[F-034]`'s refusal is not too eager**: verified on real D1 that an append-only table still rebuilds through `migrate` with its guard re-created, and that the refusal fires on neither the kit's own guard nor a table with no triggers. Wired into `push`, `check`, `verify` and `migrate`.
- **The gap-4 introspection saving is correct and cheap**: 0 queries when nothing rebuilds, 1 `sqlite_master` read otherwise, and that row set is everything the guard reads.
- **The `[F-033]` leftover-`__new_X` warning** fires with both names, never emits the drop, does not fire for a `__new_*` table present in the schema, and reaches the operator on `push`, `check` and `generate`.

## Findings — feature lens (iteration 4)

### [F-048] `onConflictDoUpdate()` silently drops `$onUpdate` columns from the `DO UPDATE SET` clause — status: **done** (`91de9e1`, confirmed byte-identical to Drizzle by round-2 review) — severity: high — area: sql/compile — COMPAT-DEFECT
- **Where**: `src/plan/compile.ts:545` (`writeOnConflict` → `definedValues(conflict.set)` → `writeAssignments`)
- **Defect**: `compileUpdate` folds every `$onUpdate` column into the assignment list (`src/plan/compile.ts:580-584`), but `writeOnConflict` does not — so the update half of an upsert writes only the keys the caller listed. Drizzle routes both through the same `buildUpdateSet`, which includes any column with `onUpdateFn` (`drizzle-orm/sqlite-core/dialect.js:55`).
- **Failure scenario** (both verified): `db.insert(users).values({ id: 1, email: 'a@b.c' }).onConflictDoUpdate({ target: users.id, set: { email: 'x@y.z' } })` gives d1zzle `… on conflict ("id") do update set "email" = ?` where Drizzle gives `… do update set "email" = ?, "updated_at" = ?`. On the insert path `updated_at` *is* written; on the conflict path it is not. A session/token/counter table upserted on every request keeps its very first `updated_at` forever. `updatedAt` is the canonical `$onUpdate` column and "upsert a session row" is the canonical use of `onConflictDoUpdate`.
- **Fix**: in `writeOnConflict`, after `definedValues(conflict.set)` decides the `do nothing` fallback — **keep that decision based on the user's set alone**; Drizzle throws `No values to set` there, so d1zzle's `do nothing` is a deliberate, better divergence and must not change — fold in `$onUpdate` columns before rendering, exactly as `compileUpdate` does. Extracting the six lines at `compile.ts:580-584` into a shared `withOnUpdate(values, columns)` avoids a third copy.
- **Prove it**: `test/unit/compile-write.test.ts` — the fixture `users` already has `updatedAt.$onUpdate(...)`. The existing assertion at `compile-write.test.ts:76` will go red and must gain `, "updated_at" = ?`; that it passes today is the evidence the case was never considered.

### [F-049] A nested *explicit* selection over an outer join materialises an object of nulls where Drizzle returns `null` — status: done (`91de9e1`, depth-2 groups only — see `[F-056]`) — severity: high — area: sql/compile — COMPAT-DEFECT
- **Where**: `src/plan/compile.ts:338` (`const nullableGroups = implicit?.nullable ?? new Set<string>()`) and `src/plan/compile.ts:206` (`projectedNullableGroups`)
- **Defect**: nullable-group collapsing is derived only when `plan.selection === undefined`. A hand-written nested projection over a `leftJoin`/`rightJoin`/`fullJoin` therefore never collapses, and the missed side comes back as `{ id: null, title: null }`. Drizzle's `mapResultRow` nullifies any depth-2 group whose columns all come from a table the join map marks nullable.
- **Failure scenario** (both implementations run on the same driver row `[1, 'alice', null, null]`): `db.select({ u: { id: users.id, name: users.name }, p: { id: posts.id, title: posts.title } }).from(users).leftJoin(posts, …)` gives Drizzle `{ u: {...}, p: null }` and d1zzle `{ u: {...}, p: { id: null, title: null } }`. A ported handler reading `row.p ? render(row.p) : renderEmpty()` takes the truthy branch for every author with no posts. The type is wrong too — `SelectionToRow` (`src/builders/select.ts:67`) never adds `| null` to a nested group, so TypeScript agrees with the wrong runtime.
- **This is the same bug the project already fixed for the implicit path** through `.as()`: `test/unit/compile-select.test.ts:330` is titled "returns null for that group rather than an object of nulls". Only the explicit-selection path was left open, and the comment at `compile.ts:200-204` records that as intentional.
- **Fix**: hoist the table-nullability computation out of `implicitSelection` into `nullableTables(plan): Set<string>` (the loop at `compile.ts:159-160` is already exactly this), then for an explicit selection compute the group set from the leaves — for each depth-1 group, if every leaf is a `Column` and they all share one `column.tableName` that is in `nullableTables(plan)`, add the group's path. Use it at `compile.ts:338` and in `projectedNullableGroups` so `.as()` inherits it. The mapper needs no change: `readRow` (`src/plan/mapper.ts:122`) already collapses a `nullable` group whose indexes are all null. Widen `SelectionToRow`'s object branch to `… | null` for a group whose columns come from a nullable side.
- **Prove it**: `test/unit/compile-select.test.ts`, beside the existing `.as()` test — `expect(c.map([[1, null, null]])[0]!.p).toBeNull()`.

### [F-050] `casing: 'snake_case'` uses a different algorithm from Drizzle's, so some columns get a different database name — status: **done** (`91de9e1`, 17,593 adversarial inputs vs `drizzle-orm/casing`, 0 mismatches — but see `[F-059]`) — severity: high — area: schema — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:125-136` (`toSnakeCase`/`applyCasing`), reached from `src/runtime/database.ts:29` and `kit/src/node/config.ts:44`
- **Defect**: d1zzle uses two boundary-insertion regexes; Drizzle (`drizzle-orm/casing.js:3`) tokenises with `/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g` after stripping apostrophes, then lowercases and joins. They disagree on any key with an uppercase run followed by a digit, and on any key with leading underscores or non-word characters: `apiV2` → Drizzle `api_v_2` vs d1zzle `api_v2`; `utf8MB4` → `utf8_mb_4` vs `utf8_mb4`; `_id` → `id` vs `_id`; `__typename` → `typename` vs `__typename`; `user’sName` → `users_name` vs `user’s_name`; `some name` → `some_name` vs `some name`. (`firstName`, `userID`, `HTTPServer`, `emailVerified`, `oauth2Token`, `myURLPath`, `ABCDef`, `iOS`, `fooBAR` all agree.)
- **Failure scenario**: a Drizzle project with `casing: 'snake_case'` and a column `apiV2: integer()` has `api_v_2` in production. Porting to d1zzle emits `"api_v2" integer` (verified), so every query gives `D1_ERROR: no such column: api_v2` and `d1zzle-migrate generate` proposes `ADD COLUMN "api_v2"` plus a destructive drop of `api_v_2`. The leading-underscore case silently *renames* rather than errors during `push`.
- **Fix**: replace `toSnakeCase` with Drizzle's exact expression — `(name.replace(/['’]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? []).map(w => w.toLowerCase()).join('_')`. Six extra bytes, and it is the only spelling that can be right since the reference is Drizzle's literal output.
- **Prove it**: `test/unit/casing.test.ts` — add `apiV2`, `_id`, `utf8MB4` and assert the emitted DDL names against `toSnakeCase` **imported from `drizzle-orm/casing`**, not against string literals. This is exactly the `[F-014]` shape: assert against the real package, not a constant read off the implementation.
- **Worth flagging alongside**: `casing` was **removed from `DrizzleConfig` in v1** (`drizzle-orm/utils.d.ts:62` has only `logger`/`schema`/`relations`/`cache`/`jit`); v1 binds casing at table-definition time via `sqliteTableWithCasing`/`sqliteTableCreator`. Keeping it on `drizzle()` as a process global (`configureCasing`) is a v0 spelling, and it means two schemas in one isolate cannot have different casings. See `[F-051]`.

### [F-051] `NEW-SURFACE` proposals from the iteration-4 feature lens — status: needs-human — severity: n/a — area: api
Recorded, not built. Ranked as the reviewer ranked them:
1. **`sqliteTableCreator` / `sqliteTableWithCasing`** (`src/sqlite-core.ts:26`). Both are exported by `drizzle-orm/sqlite-core` (`table.js:50`) and neither exists here. `sqliteTableCreator` is how `create-t3-app` and every multi-app-per-database schema prefixes table names; in v1 `sqliteTableWithCasing('snake_case')` is *the* supported way to ask for snake-case, replacing the removed `drizzle({ casing })`. A schema built on either cannot be ported by changing one import specifier, which is the whole adoption story in `docs/08`. Both are thin wrappers over the existing `table()` — `sqliteTableCreator(fn, casing)` returns `(name, cols, extras) => table(fn(name), cols, extras)` with the original name kept for `DrizzleBaseName` (`src/schema/table.ts:120` already carries a `baseName` slot). The `casing` argument is the harder half: d1zzle's casing is a module global rather than a per-table binding, so a per-table `casing` needs `applyCasing` to move from `Column.name`'s getter to `ColumnBuilder.build(key)`.
2. **`.as()` / `.mapWith()` on a `sql` fragment** (`src/sql/sql.ts:180`). A d1zzle fragment's prototype has exactly `toQuery`; `sql<number>\`count(*)\`.mapWith(Number)` and `sql\`lower(x)\`.as('lower_name')` are both in Drizzle's documentation and both throw `TypeError: … is not a function` here — at module load, if the query was hoisted to module scope as `docs/05` recommends. Both are three-line adapters onto machinery that exists: `.as(name)` renders `<inner> as "name"`, `.mapWith(fn)` returns `withDecode(this, fn)`. Adding `getSQL()` at the same time would make d1zzle fragments satisfy Drizzle's `isSQLWrapper`, which is what any adapter accepting a user-supplied fragment checks.
3. **`setWhere` on `onConflictDoUpdate`** (`src/builders/insert.ts:52`). d1zzle has `targetWhere` and `where`; Drizzle has all three and *throws* when `where` is combined with either. d1zzle's `where` → set-where mapping is correct (verified against Drizzle's emitted clause order), so this is a one-line alias plus the conflict check.
4. **Multiple `on conflict` clauses.** Drizzle's `config.onConflict` is an array it pushes to; d1zzle's `#next({ onConflict })` replaces, so `.onConflictDoNothing({target: a}).onConflictDoUpdate({target: b, …})` silently keeps only the last. SQLite supports several.
5. **`sumDistinct` / `avgDistinct`** — d1zzle has `countDistinct` only.
6. **Root `placeholder` / `param` / `name`** — d1zzle has `ph`, `sql.placeholder`, `sql.identifier` and the `Param` class, but not Drizzle's free functions, so `import { placeholder } from 'drizzle-orm'` in a ported file fails to resolve.
7. **`d1zzle-migrate drop` and `export`** (`kit/src/cli.ts:16` claims the surface "deliberately mirrors drizzle-kit"). `drop` is the one that matters — without it, un-journalling a bad migration is a hand-edit of `meta/_journal.json`, the file `docs/09` says must stay consistent with the emitted SQL.

### [F-052] `getTableConfig`'s element shapes do not match Drizzle's, despite the parity claim — status: todo — severity: low — area: drizzle-compat — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/schema/table.ts:207` (the claim), `src/schema/table.ts:237-253` (the shapes), `src/schema/constraints.ts:151`
- **Defect**: Drizzle's `Index` nests everything under `.config` (`{ config: { name, columns, unique, where, table }, isNameExplicit }`) and its `ForeignKey` exposes `reference()` as a *function* plus `getName()`; d1zzle returns flat records for both. `primaryKeys[i].name` also differs — d1zzle derives `${table}_pk` where Drizzle derives `${table}_${cols}_pk`, the same divergence `[F-015]` records for foreign keys.
- **Not claimed as a defect**: the reviewer searched every package in `node_modules` and the only consumer is Pothos, which reads `columns` and `primaryKeys[].columns` — both of which match. Recorded because the doc's parity claim ("field for field") is false and the next adapter to read `indexes` will get `undefined`.

### [F-053] `renderSchemaModule`'s reserved-name list is missing `numeric` — status: todo — severity: low — area: kit/node — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `kit/src/node/commands.ts:499` (`RESERVED`), against `commands.ts:330`
- **Defect**: `factory` can be `'numeric'` and the import is added, but `numeric` is not in `RESERVED`, so a live table named `numeric` makes `pull` emit `export const numeric = sqliteTable("numeric", { x: numeric("x") })` — a TDZ error in a file whose entire job is to compile.

### [F-054] `lowerIn` has no bound-parameter guard — status: todo — severity: low — area: better-auth — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/better-auth.ts:169`
- **Defect**: the case-sensitive path goes through `inArray`, which collapses to `json_each` above the threshold and names the budget above `maxParams`; the `mode: 'insensitive'` path binds one parameter per value unconditionally, so an `in` of >100 values surfaces as a bare `too many SQL variables` from D1. Reachable only when a caller sets `mode: 'insensitive'` on an `in`, which the reviewer could not find better-auth doing on its own — latent rather than confirmed. (A previous lens dropped this for the same reason; it is recorded now because the *guard* asymmetry is concrete even if the caller is not.)

## Unresolved objections merged anyway (`91de9e1`)

The round-2 reviewer of `sweep/feature-20260730-205013` confirmed all three findings closed
and rejected on three further points. Two review rounds is the cap, the gate was green
(659 passed / 4 skipped), so it merged. Revert as one unit with `git revert -m 1 91de9e1`.

**`[F-055]` is a regression against `main` reachable at the default budget** — a query that
compiled and ran fine now throws `CompileError`. Fix it first.

### [F-055] The new bound-parameter guard counts *columns*, not parameters, and rejects inserts that worked — status: todo — severity: **high** — area: sql/compile — REGRESSION
- **Where**: `src/plan/compile.ts:539`
- **Defect**: `cols.length + conflictParams > ctx.maxParams` treats every column in the row as one bound parameter, but a value supplied as a zero-parameter `sql` fragment occupies a column without binding anything. The `CompileError` therefore fires on queries whose emitted statement is nowhere near the budget — **at the default `maxParams: 100`**, not only under a lowered one.
- **Failure scenario** (verified against both revisions, default budget): an 80-column table where 40 values are SQL literals binding nothing, upserted with `set: { c0: sql\`excluded."c0"\` }` (0 params) and `where: inArray(wide.c1, [25 ids])` (25 params). `main` compiles to **one statement with 65 bound parameters**, which D1 accepts. HEAD throws `CompileError: A row of 80 columns plus 25 bound parameter(s) from "on conflict" exceed the bound-parameter limit of 100; no chunking can satisfy it.` A realistic instance: a 98-column table (legal), three values written as `sql\`unixepoch()\``, an upsert binding 3 → `98 + 3 = 101` throws, while the real statement binds `95 + 3 = 98`.
- **The pre-existing sibling check** (`cols.length > ctx.maxParams`, line 533) has the same flaw but is unreachable at the default budget — D1 caps a table at 100 columns (`src/limits.ts:46`). Adding `conflictParams` to it is what makes the flaw reachable.
- **Second, narrower window**: `maxParams` is documented as a chunking *lever* (`docs/02-d1-platform.md:183`, `src/plan/compile.ts:378`), not only as D1's ceiling. A 10-column table with `maxParams: 10` and an upsert on a table carrying `$onUpdate` compiled to a valid 11-parameter statement on `main` and now throws.
- **Fix**: count the row's actual bound parameters — render or count them the way `countOnConflictParams` already does for the conflict clause — rather than equating columns with parameters. The same conflation makes `rowsPerChunk` (line 546) inexact in both directions, but that part is pre-existing; only the *throw* is new.

### [F-056] A group mixing a depth-2 leaf with a deeper leaf does not do what Drizzle does — status: todo — severity: med — area: sql/compile
- **Where**: `src/plan/compile.ts:213` — `if (leaves.some((leaf) => leaf.path.length !== 2)) continue;`
- **Defect**: this applies Drizzle's `path.length === 2` rule as a group-wide veto. Drizzle applies it *per leaf*: a deeper leaf is simply skipped (`drizzle-orm/utils.js:136`) and the group's own depth-2 Column leaves still decide. The comment above the line ("Only a group's *own* depth matters") describes Drizzle's rule; the code implements a stricter one.
- **Failure scenario**, both implementations on driver row `[7, null, null]`: `select({ postId: posts.id, author: { id: users.id, contact: { email: users.email } } }).from(posts).leftJoin(users, …)` gives Drizzle `[{ postId: 7, author: null }]` and d1zzle `[{ postId: 7, author: { id: null, contact: { email: null } } }]`. This is the exact "null row materialized as an object of nulls" shape the batch exists to fix.
- **Not a regression against `main`** (equally wrong there), but note that `fd11e75` happened to get this shape right and `4b70c35` traded it for the depth-3 fix.
- **Fix**: skip deeper leaves rather than vetoing the group. **Matching Drizzle also requires `GroupSpec.columnIndexes` to hold only the group's *direct* depth-2 column leaves** — today `buildShape` pushes each column index into every ancestor (`src/plan/mapper.ts:99`), so a naive relaxation of line 213 would test the wrong indexes.

### [F-057] `GroupSpec.indexes` is now write-only — dead allocations and 75 bundle bytes — status: todo — severity: low — area: efficiency
- **Where**: `src/plan/mapper.ts:38`
- **Defect**: `readRow` was the only reader and now reads `columnIndexes` (line 145). `indexes` is still declared, initialized in four places, pushed to once per (field × ancestor depth) in `buildShape` (line 98), and copied into every `GroupSpec` (line 120). Deleting it gives 41,223 bytes vs 41,298 — **75 of this batch's 1,083 bytes are dead weight** parsed on every cold isolate, plus one dead array allocation per group and one dead push per column per level on every compile.
- **Careful**: `[F-056]`'s fix needs `columnIndexes` to change meaning, so do these two together.

### [F-058] The same `too many SQL variables` remains reachable through `returning()` and multi-parameter `values()` — status: todo — severity: med — area: sql/compile
- **Where**: `src/plan/compile.ts` (the `rowsPerChunk` computation)
- **Defect**: the chunker still assumes exactly one bound parameter per column in `VALUES` and zero from `returning`. Both reproduced against real D1 in workerd: `db.insert(t).values(40 rows × 4 cols).returning({ id: t.id, tag: sql\`${'tag'}\` })` → parts `[101, 61]` → `D1_ERROR: too many SQL variables at offset 411`; and a `values()` entry written as `sql\`${'x'} || ${'y'}\`` (2 params in one column) → parts `[125, 75]` → same error.
- **Pre-existing, not introduced by this batch** — but `countOnConflictParams` is the right shape for both, and a general "params outside/inside VALUES, rendered not guessed" reservation would close them together with `[F-055]`.

### [F-059] The casing fix is a silent breaking change for existing d1zzle users on `snake_case` — status: needs-human — severity: med — area: release
- `[F-050]` made `toSnakeCase` match Drizzle exactly, which is correct — but for a project already on d1zzle with `casing: 'snake_case'`, derived column names change: `apiV2` `api_v2` → `api_v_2`, `_id` `_id` → `id`. The kit surfaces it as a destructive diff rather than losing data quietly, so it is loud, but it needs a release note and possibly a major-version decision. Also note that `{ id, _id }` now both derive `id`; nothing detects the collision, though SQLite rejects the duplicate column loudly at apply time. That collision behaviour is Drizzle's exactly.

## Findings — efficiency + bugs lens (iteration 5)

### [F-060] A relation's inherited `where` is applied to the wrong table — status: todo — severity: **high** — area: relations
- **Where**: `src/relations/define.ts:374` sets `relation.isReversed = true` and `:376` inherits the opposite side's `where`, but **nothing in `src/` ever reads `isReversed`**. Three sites compile that predicate against the relation's *target* when it belongs to its *source*: `src/relations/query.ts:477`, `src/relations/filter.ts:345`, `src/relations/joined.ts:215`.
- **Drizzle picks the table explicitly** (`drizzle-orm/relations.js:683`, `:690`): `relationsFilterToSQL(relation.isReversed ? sourceTable : targetTable, relation.where)`.
- **Failure scenario**: the `where`-on-one-side, `many`-picks-it-up spelling that `adoptReverse` exists to serve — `posts.author = r.one.users({ from, to, where: { active: true } })` with `users.posts = r.many.posts()` adopting `from`/`to` *and* `where*`. Both `users` and `posts` have an `active` column. With user 1 active (posts 10 active, 11 archived) and user 2 inactive (post 12 active), `findMany({ with: { posts: true } })` gives Drizzle `[{id:1,posts:[10,11]},{id:2,posts:[]}]` and d1zzle `[{id:1,posts:[10]},{id:2,posts:[12]}]` — **wrong in both directions**: post 11 dropped from a user that should have it, post 12 returned for a user that should have none. Silent, because `split` and `joined` agree with each other, which is the only cross-check the suite has.
- **When the target has no column of that name it is a hard failure instead**: `Unknown filter field "active". It is neither a column nor a relation of this table.` thrown from `src/relations/filter.ts:418` via `#fetchChild`, and the same from `compileRelationFilter` on the filter path.
- **Fix**: thread `isReversed` through. In `filter.ts:345` it is local — `compileRelationFilter` already holds the outer `table` and `sourceColumns`, so compile against those when reversed; the predicate stays inside the `exists (…)` body where the outer row is in scope. In `joined.ts:215`, compile against the *parent* level's aliased table and push into `predicates`, still inside the correlated subquery, exactly as Drizzle does. In `query.ts:477` the split plan has no correlated scope, so the reversed predicate must be evaluated against the parent rows in `#fetchChild`: a parent that fails it is excluded from `byKey` and gets `[]`/`null` — the same observable answer.
- **Prove it**: no existing test can — every `where`-carrying relation in `test/workers/relations.test.ts:1322` and `:826` states `from`/`to` explicitly, so `isReversed` is always `false` there. Add the schema above with the three-way assertion the file's header prescribes (split, joined, filter path), plus a case where the target lacks the column asserting it does not throw.

### [F-061] `DESC` and `COLLATE` index members are invisible to introspection, and a rebuild drops them — status: todo — severity: **high** — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:334` falls back to parsing the raw `CREATE INDEX` only when a member's `name` is `null`. `pragma index_info` reports a `DESC` or `COLLATE`-qualified member as an ordinary named column, so the modifier never reaches the snapshot. Verified on D1: `index_info` gives `{"name":"created_at"}` where `index_xinfo` gives `{"name":"created_at","desc":1,"coll":"BINARY","key":1}`; only `cid:-2` (a true expression) triggers the fallback.
- **Failure scenario A — a unique constraint is downgraded by a routine rebuild**: live `create unique index "acct_email_ci" on "acct" ("email" collate nocase)` introspects as `columns: [{ expression: 'email', isExpression: false }]`. Any later unrelated change forcing a rebuild re-emits `create unique index "acct_email_ci" on "acct" ("email")`. The duplicate `alice@x.com` now inserts and the table holds two rows. Nothing errors, nothing warns, `diff.errors` is empty. **This is the `.unique()`-on-64-tables failure mode the project exists to prevent, one level down.**
- **Failure scenario B — permanent false drift on a schema that is in sync**: `index('evt_created_desc').on(sql\`${t.createdAt} desc\`)` is legal in the Drizzle subset. `canonicalIndex` compares `[['"created_at"desc', true]]` against `[['created_at', false]]`, so `check` exits 1 forever, `verify` reports a mismatch, and `push` drops and rebuilds the index on every run.
- **Failure scenario C — `pull` writes the modifier out of the schema module**: `renderSchemaModule` (`kit/src/node/commands.ts:381`) emits `index("i_desc").on(t.createdAt)`. The committed schema, the baseline snapshot and the modifier-blind introspection all agree, so `check` is green while the source of truth has silently lost the ordering and the collation.
- **The same blindness covers column-level modifiers**: `"email" text collate nocase`, `"code" text unique on conflict replace`, and `"pid" integer references "par"("id") deferrable initially deferred` all round-trip through `createTableFromSnapshot` stripped of the modifier.
- **Fix**: read `pragma index_xinfo` instead of `pragma index_info` at `kit/src/core/apply.ts:149` — available on D1, carries `desc` and `coll` (filter out the `key: 0` rowid tail rows). Add `desc?: boolean` and `collate?: string` to `IndexColumnSnapshot` (`kit/src/core/snapshot.ts:61`), emit in `createIndexFromSnapshot` (`:340`) and `renderSchemaModule` (`commands.ts:384`), include in `canonicalIndex` (`kit/src/core/diff.ts:688`). Keep the `parseIndexColumns` fallback for `cid === -2`. For the column-level family, which has no snapshot representation at all, `recreateTable` should refuse the way it already refuses for foreign triggers.
- **Prove it**: `kit/test/workers/roundtrip.test.ts` — add a `DESC` index and a `COLLATE NOCASE` unique index to the `flags` fixture, assert an empty diff. `kit/test/workers/migrate.test.ts` — the scenario-A sequence, asserting the duplicate insert still rejects after a rebuild.

### [F-062] `--remote=true` silently runs against the local database — status: todo — severity: med — area: kit/cli
- **Where**: `kit/src/cli.ts:75` assigns any `--flag=value` as a *string*; `:136` tests `flags['remote'] === true` strictly, so an `=`-spelled boolean is neither honoured nor rejected and falls through to the `--local` default at `kit/src/node/commands.ts:66`.
- **Failure scenario**: `d1zzle-migrate migrate --remote=true` in CI. `parseArgs` gives `{ remote: 'true' }`, `asTargetFlags` gives `{ local: false, remote: false, acceptDataLoss: false }`, `resolveRunner` falls to `localRunner`. Every pending migration is applied to `.wrangler/state`, it prints `Applied 0007_…` and exits 0. Production is untouched and nothing says so. `push --remote=true --accept-data-loss` is the same shape with a destructive payload. (`--remote true` behaves identically — the space form consumes `true` as the flag's value.)
- **Contrast**: a previous lens blessed `--accept-data-loss=true` as failing closed, which is true. The same rule applied to `--remote` fails *sideways*, onto a different database — which `resolveRunner`'s own comment calls out as "how the wrong one gets hit".
- **Fix**: in `parseArgs`, coerce a recognised boolean spelling — when `inline` is `'true'`/`'false'`, `set(name, inline === 'true')`. Or, narrower and stricter, have `asTargetFlags` throw when any of those three flags is a string rather than silently reading it as absent.
- **Prove it**: `kit/test/unit/cli.test.ts:133` — `expect(asTargetFlags(parseArgs(['migrate','--remote=true']).flags)).toMatchObject({ remote: true })`.

### [F-063] `d1zzle-migrate --help` fails with "No d1zzle config found" — status: todo — severity: low — area: kit/cli
- **Where**: `kit/src/cli.ts:53` takes `argv[0]` as the command unconditionally, so `--help` becomes the command string; the guard at `:146` only matches the literal command `help` or a `--help` flag *after* a command.
- **Failure scenario**: `npx d1zzle-migrate --help` in a project that has not written `d1zzle.config.ts` yet — the exact moment someone reaches for help — reaches `loadConfig` at `:152` and exits 1 with `No d1zzle config found`. With a config present it exits 1 with `Unknown command "--help"`. `-h` behaves the same. `generate --help` does work.
- **Fix**: at `:146`, also match when `command` starts with `-`.
- **Prove it**: `await expect(run(['--help'])).resolves.toBe(0)`.

### [F-064] Error mapping loses the failing statement on a chunked write — status: todo — severity: low — area: runtime — OFF-LENS from efficiency + bugs
- **Where**: `src/runtime/session.ts:150` throws `wrapQueryError(cause, query.sql)` where `query.sql` is `parts[0].sql`, so a 40-chunk insert failing on chunk 37 reports chunk 1's SQL and no parameters — contradicting the documented "errors carry the SQL that caused them". `src/runtime/session.ts:194` joins only each item's *first* part for the same reason.

### [F-065] `verify` replays in array order, `migrate` in `idx` order — status: todo — severity: low — area: kit/journal — OFF-LENS from efficiency + bugs
- **Where**: `kit/src/node/commands.ts:625` iterates `journal.entries` directly while `pendingMigrations` (`kit/src/core/journal.ts:40`) sorts by `idx`. A `_journal.json` whose entries end up out of order — the ordinary outcome of resolving a git conflict between two branches that each generated a migration — makes the two commands disagree about the order history applies in.

### [F-066] `pull` writes a snapshot with no `prevId` — status: todo — severity: low — area: kit/node — OFF-LENS from efficiency + bugs
- **Where**: `kit/src/node/commands.ts:278` omits it where `generate` (`:145`) sets `prevId: previous.id`, so a pulled baseline breaks the snapshot chain.

### [F-067] A Drizzle fragment inside DDL ignores `bareColumns` — status: todo — severity: med — area: sql — OFF-LENS from efficiency + bugs
- **Where**: `src/sql/drizzle-sql.ts:109` honours `ctx.paramToken` but not `ctx.bareColumns`, so `check('c', drizzleSql\`${col} > 0\`)` renders `"t"."col" > 0` inside a `CHECK`, which SQLite rejects. Concrete and in-lens; recorded rather than batched only to keep this iteration's batch small.

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
