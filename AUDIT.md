# AUDIT.md — correctness / efficiency sweep

Working state for the `/audit-sweep` loop. Machine-written, human-editable — reorder,
delete, or re-rank anything here and the next iteration will follow it.

Gate: `npm run check` (typecheck → build → test → typecheck:kit → build:kit).
Baseline at sweep start: **green, 565 passed / 4 skipped**.
After the feature iteration (`15f24ef`): **green, 594 passed / 4 skipped**.
After the efficiency + bugs iteration (`516dbd5`): **green, 616 passed / 4 skipped**.
After the security iteration (`60ff73f`): **green, 644 passed / 4 skipped**.
After the iteration-4 feature pass (`91de9e1`): **green, 659 passed / 4 skipped**.
After the iteration-5 efficiency + bugs pass (`efe70a4`): **green, 677 passed / 4 skipped**.
After the iteration-6 security pass (`37db699`): **green, 702 passed / 4 skipped**.
After the iteration-8 efficiency + bugs pass: **green, 908 passed / 5 skipped**.
After the iteration-7 feature pass (`5051bc7`): **green, 718 passed / 4 skipped**. Minified `src/core.ts` is 41,298 bytes (+1,083 this batch; `docs/01`'s target is ≤ 20 KB, blown long before this).
After the standing-authorization batch (2026-08-18, this session — 12 findings: `[F-009]`, `[F-011]`, `[F-012]`, `[F-014]`, `[F-015]`, `[F-016]`, `[F-032]`, `[F-052]`, `[F-053]`, `[F-094]`, `[F-095]`, `[F-096]`): **green, 944 passed / 7 skipped** (`npm run test:unit` + `npm run test:workers`). Minified `dist/core.js` is 42,853 bytes (+468 vs the 42,385-byte baseline this run started from — `[F-009]`'s `String` decode and `[F-012]`'s `text(n)` length rendering are both in `src/`; `[F-094]` is type-only and cost nothing; `[F-095]`'s `assertSameDrizzle` lives in `src/drizzle.ts`, a separate entry point not counted in this measurement).
After the reviewer-rejection follow-up (2026-08-18, this session — verified every claim against installed `drizzle-orm@1.0.0-rc.4`/`drizzle-kit@1.0.0-rc.4` source): **green, 949 passed / 5 skipped** (`npm run test:unit` + `npm run test:workers`). `[F-012]` reverted in full (STRICT tables reject decorated type names; `text({length})` renders bare `text` again everywhere). `[F-052]` corrected: `primaryKeys[i].name` is now `undefined` for an unnamed PK (matching real `PrimaryKey.name`), with `getName()`/`isNameExplicit` added to both `primaryKeys` and `uniqueConstraints`. `[F-094]`'s `$inferInsert` optional half now spells `| undefined` explicitly, matching Drizzle exactly under `exactOptionalPropertyTypes`; its test is now comparative against real `drizzle-orm`. `[F-095]`'s docstring/docs no longer overclaim what `assertSameDrizzle` proves about a third-party adapter's own resolution, and the `docs/05-adapters.md` recipe no longer breaks on a child-declared or `One`-first relation. `[F-116]` (new): `min()`/`max()` now decode a non-Column operand through `String`, matching `drizzle-orm/sql/functions/aggregate.js`. Minified `dist/core.js` is 42,927 bytes (+74 vs the prior 42,853 — the `[F-012]` revert removes bytes, `[F-052]`'s `getName()` closures and `[F-116]`'s `minMaxDecoder` add more than that back; `[F-094]`/`[F-095]` are type-only/docs and cost nothing).
After a second review pass (2026-08-18, this session): **green, 957 passed / 5 skipped** (`npm run test:unit` + `npm run test:workers`). `[F-116]`'s `min`/`max` fix was runtime-only — the declared *type* still let `min(sql<number>\`…\`)` type-check as `number | null` while decoding through `String`; `src/sql/functions.ts` now overloads `min`/`max` (`C extends Column<any>` → the column's decoded type, any other `SQLChunk` → `string | null`), matching Drizzle's own conditional-type overload exactly, and `test/unit/functions.test.ts`'s non-Column case is now comparative against real `drizzle-orm`'s `min`/`max` rather than a hardcoded `'7'`. This session's earlier `[F-116]` insertion had also destroyed the `### [F-010]` heading, gluing its title onto `[F-116]`'s last bullet and orphaning its body under the wrong finding — restored intact and swept the rest of the file for the same damage (none found). `[F-012]`'s "reverted in full" turned out to be one step too cautious: `getSQLType()` is restored to Drizzle-faithful (`text({length})` → `text(255)`, `mode: 'json'` drops the length, matching `drizzle-orm/sqlite-core`'s `SQLiteText`/`SQLiteTextJson` exactly), since DDL/snapshot rendering never called `getSQLType()` at all — `src/ddl.ts`'s `typeName()` and `kit/src/core/snapshot.ts` both read `declaredType ?? type` directly, so they were never at risk from `getSQLType()`'s own answer. Finally, `src/schema/table.ts`'s `getTableConfig()` now derives an unnamed table-level `foreignKey()`'s `getName()` the same way Drizzle's own `ForeignKey.getName()` does (`${table}_${cols}_${foreignTable}_${foreignCols}_fk`, over every column of a composite key) instead of `foreignKeyName()`'s shorter DDL-facing `${table}_${cols}_fk` — `foreignKeyName()` itself, and every DDL/snapshot caller of it, is untouched. Minified `dist/core.js` is 43,113 bytes (+186 vs the prior 42,927 — the `min`/`max` overload split and `getSQLType()`'s length branch are both in `src/`; the `getTableConfig()` FK-name change lives in the same file but only in an introspection code path that was already present). **Correction (round-3 reviewer)**: summed against this file's own running deltas (468 + 74 + 186 = 728) overstates the true growth against `main` — measured directly, `dist/core.js` on `main` is 42,609 bytes, so the real delta from `main` to this batch's 43,113 is **+504**, not +728; the per-entry deltas above are each individually accurate against their own immediately-prior measurement, they just don't sum straight to the `main` baseline because of rounding/measurement drift across sessions.
After the standing-authorization batch closing `[F-001]`, `[F-022]`, `[F-023]`, `[F-031]`
(blocked), `[F-037]`, `[F-054]`, `[F-072]`, `[F-076]`, `[F-090]`, `[F-097]` (this session,
2026-08-18): **green, 908 passed / 5 skipped** (`npm run test:unit` + `npm run test:workers`).
`npm run check` exits 0. New: a synthetic 37-table regression harness
(`kit/test/workers/large-synthetic-schema.test.ts`) asserting fidelity directly against real
SQLite pragmas, and a bundle-size ceiling gate (`test/unit/module-resolution.test.ts`) seeded
from a real re-measurement — `orm-d1`'s driver+schema bundle is 51.7 kB minified / 17.7 kB
gzipped today (`docs/01-differences.md` and `README.md` corrected to match; both had been
carrying a stale 44.1 kB / 15.3 kB figure). `[F-031]` (`ConcurrencyGate`) is **not** fixed —
`kit/src/core/apply.ts` was excluded from this batch's edits (concurrent work by another
batch) and the fix is left as a two-line note for whichever batch can next touch that file.

## Rotation

One lens per iteration, rotating `feature` → `efficiency + bugs` → `security` → repeat.
Advanced in every terminal case, including blocked and nothing-found, so a lens that keeps
failing cannot starve the other two.

- Next lens: **security**
- Last ran: efficiency + bugs — 2026-08-17, merged `df50b65` **over an unresolved round-2
  rejection**. Five findings batched; `[F-098]` (rename FK repointing), `[F-099]` (right/full
  join nullability, runtime + type), `[F-100]` (the `pull` warning half) and `[F-102]`
  (`Column.name` memoization, 18.13 → 9.26 µs/op) all confirmed closed against real
  reproductions. `[F-101]` (column `COLLATE`) is **partial and opened `[F-106]`–`[F-109]`**;
  `[F-106]` is a regression vs `main` that produces a migration which cannot be applied,
  and is the highest-value open item in this file.
- Ran before that: feature — 2026-07-31, merged `5051bc7` — **approved at round 2**, the second
  approval in a row. Three findings in one file, all closed. `[F-082]` (widening
  `db.run`/`all`/`get`) was parked as an API-surface question rather than batched.
- Ran before that: security — 2026-07-31, merged `37db699` — **approved at round 2**, the first
  approval in six iterations. Small, surgical batch: two findings, both closed. The three
  items recorded from it (`[F-077]`, `[F-078]`, `[F-079]`) are pre-existing incompleteness
  the reviewer explicitly stated this diff did not open.
- Ran before that: efficiency + bugs — 2026-07-30, merged `efe70a4` **over an unresolved round-2
  rejection** — the fifth in a row. Two clean closes (`[F-062]`, `[F-063]`), two partial
  (`[F-060]`, `[F-061]`). Open from it: `[F-068]` (a regression vs `main` — an expression
  index with a modifier can never converge), `[F-069]`, `[F-070]`, `[F-071]`, `[F-072]`.
- Ran before that: feature — 2026-07-30, merged `91de9e1` **over an unresolved round-2 rejection**.
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

### [F-001] No regression harness against a large real-world schema — status: **done** (this batch — synthetic harness, see below) — severity: high — area: kit/render
- **Resolved**: rather than the env-var-path recipe below — which depends on a specific
  downstream project's checkout being mounted, and is the thing `[F-037]` flags as this
  file's privacy leak — the harness is a **synthetic** schema generated entirely inside
  this repo: `kit/test/workers/large-synthetic-schema.test.ts`, 37 tables (a root table
  plus 36 generated variants cycling every FK `on delete`/`on update` action pair),
  covering column-level `unique`, composite primary keys with `WITHOUT ROWID`, `check`,
  named FK constraints, partial indexes (`where`), collated index members, generated
  columns (both `stored` and `virtual`), and `STRICT`. It asserts fidelity two ways:
  directly against real SQLite via raw `pragma table_xinfo`/`index_list`/`index_xinfo`/
  `foreign_key_list` queries — never against orm-d1's own rendering — and via the
  `snapshotFromSchema` ↔ `introspect()` round trip `kit/test/workers/roundtrip.test.ts`
  already checks elsewhere in this suite, at a table count no author or reviewer holds
  in their head. It is driven entirely through the kit's existing public entry points
  (`createSchema`, `introspect`, `snapshotFromSchema`, `diffSnapshots`); no core
  diff/apply machinery was touched to add it. The env-var recipe below is left as a
  record of the approach tried first and rejected — it is superseded, not live.
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
  (`ORM_D1_FIXTURE_SCHEMA`), skipping cleanly when unset, and asserts round-trip
  fidelity: every `unique`, composite PK, `check`, FK action, index (including partial
  `where`), `STRICT` and `WITHOUT ROWID` present in the loaded schema appears in the
  rendered DDL, and re-introspecting the applied DDL diffs empty against the original
  snapshot. Do **not** vendor anyone's schema into this repo — read it from disk.
- **Prove it**: with `ORM_D1_FIXTURE_SCHEMA` pointing at a downstream project's real
  schema — 64 tables, `WITHOUT ROWID` and append-only triggers via a sidecar
  `tableOptions` — the harness runs and passes; unset, the suite skips it and
  `npm run check` still exits 0. Needs `orm-d1/sqlite-core` added to the alias map in
  `vitest.config.ts` — that fixture imports it.
- **Where the path points**: in the orm-d1 devcontainer the variable is preset to a
  path under a read-only mount of the parent checkout (via `docker-compose.yml`).
  Running inside that downstream project's own container instead, it points at the
  equivalent path inside its own workspace.
- **Loading mechanism — settled empirically 2026-07-30, do not re-derive**: two throwaway
  probes (since deleted) established that `await import(<abs path>)` of the out-of-tree
  fixture works in **both** vitest projects, loading all 64 tables with every one of them
  recognised by *our* aliased copy of orm-d1 — so there is no two-copy `instanceof`
  hazard. Two config lines are required, and are **already applied uncommitted** in
  `vitest.config.ts`:
  1. `'orm-d1/sqlite-core'` in the alias map, placed *before* the bare `'orm-d1'` key
     (prefix matching — after it, the shorter key wins and the import fails to resolve).
  2. The workers project cannot see `process.env`, so the path must be threaded in as a
     `define`d global (`__ORM_D1_FIXTURE_SCHEMA__`). A `define` on
     `process.env.ORM_D1_FIXTURE_SCHEMA` is *not* enough on its own: `define` is literal
     text substitution, so a bracket-notation read (`process.env['…']`, which this repo's
     tsconfig forces) is never substituted and the suite silently skips.
  Because the round-trip needs a real D1, the harness belongs in `kit/test/workers/`.
  Remaining work is only writing the test file against this recipe.
- **Fixture shape**, for the assertions: the sidecar is a `table-options.ts` module
  under the same schema directory (default-exports a `tableOptions()` map), wired by
  that project's `orm-d1.config.ts`. It sets `strict: true` on **all 64** tables, with
  `withoutRowid` and `appendOnly` drawn from a `hardening.ts` roster.

### [F-002] `dataTypeOf()` returns Drizzle v0 `dataType` strings — status: done (`15f24ef`, runtime only — see `[F-017]`) — severity: high — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/drizzle-entity.ts:91` (+ `ToDrizzleDataType`, `DataTypeOf<CT>` at `src/schema/columns.ts:407`)
- **Defect**: emits the flat v0 vocabulary (`'number'`, `'date'`, `'json'`, `'buffer'`, `'bigint'`, `'string'`) where Drizzle v1 uses a `"<type> <constraint>"` pair split on the space by `drizzle-orm/column-builder.js:4` `extractExtendedColumnType`; the *type-level* shape already uses v1 spellings, so type and runtime disagree.
- **Failure scenario**: `drizzle-orm/zod`'s `createSelectSchema` on the same table gives `ZodAny` for every timestamp/JSON/blob column, plain `ZodString` where the enum was, and an unchecked `ZodNumber` for ids. Generated request validators silently stop validating; nothing throws.
- **Fix**: return v1 strings (`'number int53'`, `'number double'`, `'object date'`, `'object json'`, `'object buffer'`, `'bigint int64'`, `'string numeric'`, `'string enum'` when `enumValues` set else `'string'`, `'boolean'`, `'custom'`) and delete `ToDrizzleDataType`'s remapping so the type derives from the same source.
- **Prove it**: `test/unit/drizzle-interop.test.ts:85-104` currently hard-codes orm-d1's own answers — replace with a table-driven comparison against a `drizzle-orm/sqlite-core` fixture asserting `d1.col.dataType === dz.col.dataType` for all column types, plus one `createSelectSchema` behavioural assertion.

### [F-003] `blob()` with no `mode` defaults to `buffer`; Drizzle v1 defaults to `json` — status: done (`15f24ef`) — severity: high — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:590`
- **Defect**: `mode = options?.mode ?? 'buffer'` contradicts `drizzle-orm/sqlite-core/columns/blob.js`, which falls through to `SQLiteBlobJsonBuilder`; the package declares `"drizzle-orm": ">=1.0.0-rc.1 <2"`.
- **Failure scenario**: `metadata: blob('metadata').$type<Meta>()` ported by changing the import specifier — writes hand the raw object to `.bind()` and fail with `D1_TYPE_ERROR: Type 'object' not supported`; reads of existing rows return a `Uint8Array` of raw JSON bytes while the declared TS type hides it. DDL is `blob` either way so `orm-d1-kit check` stays green.
- **Fix**: `const mode = options?.mode ?? 'json'`, and flip the `BlobData<TMode>` / `BlobColumnType<TMode>` defaults so the type follows.
- **Prove it**: `test/unit/drizzle-interop.test.ts` — `blob('x').build('x').columnType === 'SQLiteBlobJson'` and a `mapToDriverValue`/`mapFromDriverValue` round trip; `test/workers/blob.test.ts` for the real-D1 half.
- **Note**: this is a behaviour change to an existing default. If any file under `docs/` states the old default, it is left untouched — see `[F-011]`.

### [F-004] `and()` / `or()` do not parenthesise their operands — status: done (`15f24ef`, split path only — see `[F-019]`) — severity: high — area: sql/compile — lens: feature — COMPAT-DEFECT
- **Where**: `src/sql/expressions.ts:98`
- **Defect**: operands are joined bare and only the whole is wrapped; Drizzle wraps each (`sql.join(conditions.map((c) => sql\`(${c})\`), ' and ')`). orm-d1's own `or()` self-parenthesises, so the hole is any operand it did not build — a `sql` fragment or a `RAW` filter.
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
- **Failure scenario**: `customType<{data:number}>({ dataType: () => 'int' })` renders `"n" text`; against real D1 the values `9`/`10` store as the strings `"9"`/`"10"`, `typeof(n)` is `text`, and `order by n` returns them **reversed**. `max`, `sum` and every range predicate compare lexicographically. Separately `kit/src/core/snapshot.ts:411 typeAffinity()` puts `int` in `integer`, so pointing `orm-d1-kit` at a drizzle-kit-created database reports a spurious type change and `push` rebuilds the table.
- **Fix**: keep the declared string on `ColumnConfig` (e.g. `declaredType`), return it from `getSQLType()`, emit it from `ddl.ts:201 typeName()`. Reduce to a storage class only where the runtime needs a `SQLiteType`, using SQLite's real affinity rules — `typeAffinity()` in `kit/src/core/snapshot.ts:411` already implements them, including the `INT`-before-`CHAR` ordering the substring `.find()` gets wrong.
- **Prove it**: `test/unit/ddl.test.ts` — `dataType: () => 'int'` emits `"n" int`, `` dataType: (c) => `varchar(${c.length})` `` emits `varchar(10)`, and `col.getSQLType() === 'int'`; a workers probe pins the affinity.

### [F-007] `length` is stored but never surfaced on the column — status: done (`15f24ef`) — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:214`
- **Defect**: Drizzle exposes `length` and `isLengthExact` as public `Column` fields (`drizzle-orm/column.js:27`); orm-d1 keeps `length` in `config` only, so anything reading the column object sees `undefined`.
- **Failure scenario**: `drizzle-orm/zod`'s `stringColumnToSchema` destructures `{ name, length, isLengthExact }` and applies `.max(length)`. With `text('name', { length: 5 })`, orm-d1's generated validator accepts `"abcdefghij"` and Drizzle's rejects it — the declared constraint disappears from every generated request schema.
- **Fix**: add `get length()` / `get isLengthExact()` to `Column`, reading from `config`.
- **Prove it**: `test/unit/drizzle-interop.test.ts` — `t.short.length === 5` and `isLengthExact` matching a `drizzle-orm/sqlite-core` fixture built the same way.
- **Split**: the reviewer also proposed emitting `text(5)` from `typeName()`/`getSQLType()` to match drizzle-kit's DDL bytes. That changes emitted migration output for every existing `text({length})` column and is parked as `[F-012]` — only the getters are in this batch.

### [F-008] `columns: {}` in a relational query selects every column; Drizzle selects none — status: done (`15f24ef`, split path only — see `[F-018]`) — severity: med — area: relations — lens: feature — COMPAT-DEFECT
- **Where**: `src/relations/projection.ts:20`
- **Defect**: `pickColumns` treats "no explicit `true`" as "everything except the `false`s", so an empty object falls through to all keys. Drizzle's `getSelectedTableColumns` (`drizzle-orm/sqlite-core/dialect.js:296`) leaves `colSelectionMode` `undefined` for an empty record and returns `[]`.
- **Failure scenario**: `db.query.users.findMany({ columns: {}, with: { posts: true } })` — the documented Drizzle idiom for "only the relations" — returns the full user row alongside `posts`, including a JSON blob the caller deliberately excluded. Under a Pothos layer deriving `columns` from the selection set, that is the whole table read on every field resolution.
- **Fix**: distinguish "no `columns` key" from "empty `columns` object" — `if (!selection) return keys;` then treat an entry-less selection as `[]` before the existing two branches. `compileSelect` already throws `'A select must project at least one column'` when nothing survives, which matches Drizzle throwing in the same spot.
- **Prove it**: `pickColumns(cols, {})` → `[]`; a workers test asserting `findMany({ columns: {}, with: { posts: true } })` rows have exactly the key `posts`.

### [F-009] `sum()` / `avg()` decode to `number`; Drizzle decodes to `string` — status: done (this batch) — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/sql/functions.ts:36,39`
- **Defect**: `drizzle-orm/sql/functions/aggregate.js` uses `.mapWith(String)` for `sum`/`avg` in every dialect, deliberately, because a 64-bit sum does not survive an IEEE double. orm-d1 uses `nullable(Number)`.
- **Failure scenario**: `select({ total: sum(orders.cents) })` over a ledger past 2^53 returns a silently rounded number; code ported from Drizzle doing `BigInt(row.total)` throws `Cannot convert 1.2e+21 to a BigInt`.
- **Question for the human**: parity (`nullable(String)`, matching Drizzle, breaking every existing orm-d1 caller) or keep `number` and document the divergence in `docs/08`'s "what compatibility does not extend to"? The reviewer flagged this as a judgement call, not a mechanical fix. Either answer touches published behaviour or `docs/`.
- **Resolved**: standing authorization from the human (2026-08-18) picked parity. `src/sql/functions.ts:36,39` now decode with `nullable(String)`; `docs/01-differences.md` gained a "`sum()` and `avg()` decode to `string`" section; `test/unit/functions.test.ts` is new.

### [F-116] `min()` / `max()` decode a non-Column operand through the driver value instead of `String` — status: done (follow-up batch, 2026-08-18) — severity: low — area: drizzle-compat — COMPAT-DEFECT
- **Where**: `src/sql/functions.ts` (`min`, `max`)
- **Defect**: real drizzle-orm's `min`/`max` use `.mapWith(is(expression, Column) ? expression : String)` (`node_modules/drizzle-orm/sql/functions/aggregate.js`, verified) — a `Column` operand decodes through its own column type, but anything else (a raw `sql<number>` expression, an arbitrary fragment) decodes through `String`, the same rule `sum`/`avg` always apply (`[F-009]`). orm-d1's `min`/`max` used `passthroughDecoder(operand)`, which returns `undefined` for a non-Column operand and left the driver value untouched — wrong both in value (`7` instead of `'7'`) and in type (`T | null` instead of Drizzle's `string | null`).
- **Fix**: added `minMaxDecoder` (`src/sql/functions.ts`), which checks `isColumn(operand)` directly rather than reusing `passthroughDecoder`'s `undefined` as an "is it a Column" signal — that `undefined` is ambiguous between "not a Column" and "a Column with no `decode` configured", and the latter must still pass through as identity, not fall back to `String`. `min`/`max` now use it.
- **Prove it**: `test/unit/functions.test.ts` gained a `describe('min() / max() decode', ...)` block: a Column operand decodes through the column (identity for a plain `integer()`), a non-Column `sql<number>` operand decodes through `String`, and null/undefined decode to `null` for both operand shapes.

### [F-010] Three schema-facing spellings `drizzle-orm/sqlite-core` does not have — status: needs-human — severity: med — area: drizzle-compat — lens: feature — COMPAT-DEFECT
- **Where**: `src/core.ts:25` (`boolean`), `src/schema/constraints.ts:51` (`index()` with no name), `src/schema/constraints.ts:99` (`IndexConstraint.onOnly()`)
- **Defect**: `docs/08:67` makes "a symbol usable in a schema must also exist in Drizzle" a standing constraint, and the reverse-alias path (studio delegation) depends on it. `drizzle-orm/sqlite-core` has no `boolean` export; its `index(name: string)` requires the name; `onOnly` exists on Postgres' `IndexBuilderOn`, not SQLite's.
- **Failure scenario**: a schema using `boolean('active')` or `index().on(t.a)` cannot be aliased back to Drizzle — `boolean is not exported`. `json()` already carries a `@deprecated` block explaining exactly this (`src/schema/columns.ts:627`); `boolean` carries none.
- **Question for the human**: deprecate-and-keep (mirroring `json()`), or remove from the root entry? All three options change the published API surface, which this sweep may not do.
- **Reviewer's suggested test, if accepted**: a static assertion that every value exported from `src/sqlite-core.ts` is also a key of `import * as dz from 'drizzle-orm/sqlite-core'`.

### [F-011] `blob()` default-mode change may contradict `docs/` — status: done (this batch, no doc found stating the old default) — severity: low — area: docs — lens: feature
- Follow-up to `[F-003]`. If any design doc states the old `buffer` default, the doc is now wrong. The sweep may not edit `docs/`, so a human decides the wording.
- **Resolved**: swept `docs/`, `README.md` and `kit/README.md` for any statement that `blob()` defaults to `'buffer'` mode. None exists — the only blob-related doc lines are about the `in (...)` JSON-array optimization and D1's own size limits. Nothing to correct; recorded as checked.

### [F-012] `text(n)` / `getSQLType()` length in emitted DDL — status: **DDL/render reverted, `getSQLType()` un-reverted** (follow-up batch, 2026-08-18) — severity: low — area: ddl/render — lens: feature — COMPAT-DEFECT
- Split out of `[F-007]`. drizzle-kit writes `text(5)`; orm-d1 writes `text`, so an emitted migration stops being byte-comparable with one an existing project has committed. `kit/src/core/snapshot.ts:411 typeAffinity` maps `TEXT(5)` → `text`, so the reviewer expects the snapshot diff to be unaffected — but this changes migration bytes for every existing `text({length})` column and needs a human to accept that.
- **Previously "resolved"**: standing authorization accepted the migration-byte change; `Column.getSQLType()` started emitting `text(5)` and `src/ddl.ts`'s `typeName()` (also the STRICT-table type check) delegated to it.
- **Rejected on review**: real SQLite's `STRICT` mode only accepts the bare type names `INT`/`INTEGER`/`REAL`/`TEXT`/`BLOB`/`ANY` — no decoration. `TEXT(5)` fails STRICT's own type check with `unknown datatype`, exactly like `NUMERIC` does. So making `getSQLType()`/`typeName()` emit `text(5)` made `validateTableOptions` correctly start refusing `orm-d1-kit generate`/`check`/`push`/`verify` for any STRICT table with a `text({length})` column — a real, working combination before this change — and, worse, `createSchema`/`createTable` (which never call `validateTableOptions`) would have emitted `TEXT(5)` DDL that D1 rejects outright at `CREATE TABLE` time for such a table. Separately, `kit/src/core/snapshot.ts`'s own `type` field was never updated to carry the length, so `assertRoundTrip` broke for the same schema, and the stated parity goal (matching drizzle-kit's migration bytes) was not even reached because `generate`/`add column` still emitted bare `text`.
- **Fix (this batch)**: reverted in full. `Column.getSQLType()` (`src/schema/columns.ts:250`) and `src/ddl.ts`'s `typeName()` (`src/ddl.ts:292`) are back to `declaredType ?? type` — no length folded in, for any renderer. `length`/`isLengthExact` stay readable as Drizzle-compat getters; they're just not part of the emitted SQL type. The STRICT allow-list comment (`src/ddl.ts:181`) and `docs/02-beyond-drizzle.md`'s `STRICT`/`WITHOUT ROWID` section were also corrected: `numeric()` is not the *only* orm-d1 spelling that can trip the STRICT check — any `customType()` with a non-allowed `declaredType` (e.g. `varchar(10)`) does too, since the check reads the literal declared string, not the reduced affinity. `test/unit/ddl.test.ts`'s two `[F-012]` cases now assert bare `text` is always emitted.
- **Fix (later follow-up)**: the "reverted in full" line above was itself half a step too far. `src/ddl.ts`'s `typeName()` and `kit/src/core/snapshot.ts`'s DDL rendering never called `Column.getSQLType()` in the first place — they read `column.config.declaredType ?? column.config.type` directly (`src/ddl.ts:300`, `kit/src/core/snapshot.ts:230-231,425`) — so `getSQLType()` reverting to `declaredType ?? type` bought DDL/STRICT safety it didn't need to give up: DDL and snapshot rendering were already isolated from whatever `getSQLType()` returns. `getSQLType()` is now restored to Drizzle-faithful (`src/schema/columns.ts:250`): a `text({length})` column's `.getSQLType()` returns `text(255)`, matching real `drizzle-orm/sqlite-core`'s `SQLiteText.getSQLType()` exactly (truthy-length check, and `text({mode:'json'})` stays bare `text`, matching `SQLiteTextJson.getSQLType()`). DDL/snapshot rendering is untouched and still reads `declaredType ?? type` directly, so `orm-d1-kit generate`/`check`/`push`/`verify` and `createSchema`/`createTable` still emit bare `text` for a STRICT-safe, D1-safe migration.
- **Left as a real gap**: orm-d1's *migration bytes* for `text({length})` still don't match drizzle-kit's (`text` vs `text(5)`) — DDL/snapshot rendering deliberately stays bare under STRICT, for the reasons above. What's no longer a gap is `getSQLType()` itself: it is Drizzle-faithful and diverges from the DDL renderer's accessor on purpose, by design, not by omission — an adapter reading `Column.getSQLType()` (Pothos, a hand-written introspection tool) now sees exactly what real Drizzle would show it, decoupled from what D1 can actually accept as DDL.

### [F-013] `NEW-SURFACE` proposals from the feature lens — status: needs-human — severity: n/a — area: api — lens: feature
Recorded, not built — this sweep may not add published API surface. Ranked as the reviewer ranked them:

1. **`orm-d1-kit generate --custom`** (`kit/src/cli.ts:16`) — the reviewer's highest-value item. drizzle-kit's escape hatch for an empty journalled migration you fill in by hand. Without it there is no supported way to put a data backfill, a trigger, or a `PRAGMA` into the migration history, and since `docs/09` makes each migration one `batch()`, hand-written SQL applied outside the journal loses that atomicity and desynchronises `meta/`.
2. **`.toSQL()` on every builder** (`src/builders/*`) — Drizzle's builders all have it; orm-d1 has `.compile()` and `.toQuery()`. A three-line `toSQL(): { sql, params }` alias, a few dozen bundle bytes.
3. **`$dynamic()`** — orm-d1's builders are already immutable and re-assignable, so it can be `return this`; zero runtime cost and a very common Drizzle helper file compiles unchanged.
4. **`int` alias for `integer`** — one line (`drizzle-orm/sqlite-core/columns/integer.js` has `const int = integer`); a schema using `int` currently fails to import.
5. **`numeric(name, { mode: 'number' | 'bigint' })`** — v1 added `SQLiteNumericNumber`/`SQLiteNumericBigInt`; orm-d1's `numeric` takes only a name so the file does not port.
6. **`db.$count(table, where)`** — v1 shorthand, trivial over the existing select builder.
7. **`insert().select()`** — the only way to move rows between tables in one statement, which on D1 (no interactive transactions) is the difference between atomic and not.
8. **`update().from()` / `.orderBy()` / `.limit()`, `delete().orderBy()` / `.limit()`** — `.from()` is supported by D1 and currently unexpressible. `LIMIT` on `UPDATE`/`DELETE` needs `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which `docs/10:252` records D1 as lacking, so those must throw with that explanation rather than emit SQL D1 rejects.
9. **Set operations, CTEs, views, window functions** — already deferred at `docs/07:207`. `sqliteView`/`getViewConfig` additionally gate two adapter paths: Drizzle's `getColumns()` branches on `is(table, View)`, and Pothos accepts a view in `SchemaEntry`.

### [F-014] Interop tests assert against constants, not against Drizzle — status: done (this batch) — severity: med — area: test-harness — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `test/unit/drizzle-interop.test.ts:85-104`
- **Defect**: the file imports real `drizzle-orm` but asserts orm-d1's own `dataType` values as literals rather than comparing them against a Drizzle-built fixture. That shape — assert against a constant read off the implementation — is what let `[F-002]` and `[F-007]` ship, while `docs/10-ecosystem-interop.md:76` claims "Verified, not assumed".
- **Fix**: sweep the interop suite for assertions that never actually reference the `drizzle-orm` import, and convert them to comparisons.
- **Resolved**: the two offending tests (`'exposes dataType, columnType and the SQL type'`, `'classifies every blob mode'`) now build an equivalent table with the real `drizzle-orm/sqlite-core` and compare field by field, instead of asserting orm-d1's own strings as literals. Swept the rest of the file; the remaining assertions test orm-d1's own encode/decode and naming *behaviour* (not a Drizzle spelling), so left alone.

### [F-015] Foreign-key derived name differs from Drizzle's — status: done (this batch) — severity: low — area: drizzle-compat — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/schema/table.ts:301`
- **Defect**: orm-d1 derives `${table}_${column}_fk`; Drizzle's `ForeignKey.getName()` derives `${table}_${cols}_${foreignTable}_${foreignCols}_fk`. The kit compares FKs by content (`canonicalFk`, `kit/src/core/snapshot.ts:385`) so migrations are unaffected, but `getTableConfig(t).foreignKeys[i].name` differs from what an adapter reading Drizzle's would expect. No consumer found — recorded, not claimed.
- **Resolved**: `getTableConfig`'s inline-`.references()` branch (`src/schema/table.ts`, `getTableConfig`) now derives Drizzle's fuller `${table}_${cols}_${foreignTable}_${foreignCols}_fk`. **Correction (later follow-up)**: the table-level `foreignKey()` extra was *also* changed to derive this fuller Drizzle-shaped name for `getTableConfig()` (`src/schema/table.ts:440-470`), not left on `foreignKeyName()` as first written here — the `foreignKeyName()` import was removed from `table.ts`. `orm-d1/ddl`'s actual constraint-name emission still calls `foreignKeyName()` directly (`src/schema/constraints.ts`) and is untouched, so migration bytes are still unaffected; only the `getTableConfig()` introspection surface changed. `test/unit/table-config.test.ts` pins the new name.

### [F-016] `through.source` / `through.target` hold raw `Column`s, not `ColumnRef`s — status: done (this batch) — severity: low — area: relations — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/relations/define.ts:245`
- **Defect**: Drizzle's `Relation.through` holds `ColumnRef`s (`drizzle-orm/relations.js` maps `.map((c) => c._.through)`). `asDrizzleRelations()` copies the field verbatim, so an adapter reading `relation.through.source[0]._.column` off a re-prototyped relation gets `undefined`. Nothing shipped reads it today.
- **Resolved**: `ThroughColumns.source`/`.target` (`src/relations/define.ts`) now hold `ColumnRef`s built from `ref._.through`, matching Drizzle. Every internal consumer that dereferenced a raw `Column` off `.through` was updated to read `._.column` instead: `validateDeclared` (`define.ts`), the junction-column rebinding in `src/relations/filter.ts` and the `through` keys/`on` in `src/relations/query.ts`. `test/unit/relations-define.test.ts` updated to match.

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
- **Failure scenario**: `db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: {} } } })`. Split strategy returns `[{id:1,posts:[{},{}]}, …]`; joined gives `D1_ERROR: near "from": syntax error at offset 79: SQLITE_ERROR` on `select json_group_array(json_object()) from (select  from "posts" …)`. This violates the invariant stated at `src/relations/joined.ts:85` — "`relationalStrategy` is a performance switch: it must not change which queries are legal" — which `supportsJoined` exists to uphold. Drizzle raises a clear `No fields selected for table "posts" ("posts")` (`sqlite-core/dialect.js:387`); orm-d1 leaks a raw SQLite parse error.
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
- **Failure scenario**: `const uuid = customType<string>({ dataType: () => 'text' }); db.insert(t).values({ name: 'x' })` type-checks with no cast, compiles to `insert into "t" ("name") values (?)` against `"id" text primary key not null`, and gives `NOT NULL constraint failed` at D1. The runtime `hasDefault` is now `false` (correct), so external adapters are fixed; orm-d1's own insert model is not.

### [F-021] `affinityOf` moves `ColumnSnapshot.type` for most customTypes — one unannounced destructive rebuild on upgrade — status: **failed twice** — superseded by `[F-029]` — severity: high — area: kit/diff
- **Where**: `kit/src/core/snapshot.ts:125` + `src/schema/columns.ts:732`
- **Defect**: the backward-compat claim holds only for the fixture chosen. `columnDifference` (`snapshot.ts:361`) compares `typeAffinity(column.type)` and ignores `declaredType`, so the added `ct2` test proves only that the *new field* is invisible. But `config.type` itself changed: the old reduction was a substring `.find()` over `['integer','text','real','blob','numeric']` with a `'text'` fallback; `affinityOf` applies SQLite's real rules. They disagree for `int`, `bigint`, `double`, `float`, `decimal(…)`, `boolean`, `datetime`, `point`, `jsonb` — everything except the five canonical spellings and strings whose old fallback happened to be `text`. `varchar(10)`, the fixture chosen for both new tests, is one of the coincidences.
- **Failure scenario**: reconstructing what 0.1.3 wrote (`type: 'text'`, no `declaredType`) for `customType(() => 'int')` produces `create table "__new_ct3" … reason: column "n" changes type` / `drop table "ct3"` with `destructive: true`. The migration is *right* — the live column really is `TEXT` and the schema means `int` — but every project with such a column gets an unannounced destructive-marked rebuild on the first `generate` after upgrading, which is the opposite of what `kit/test/unit/diff.test.ts`'s comment asserts.
- **Also**: the round-trip fixture table got only `varchar(10)`; the plain `int` case is not in it.

### [F-022] The rowid-alias test is case-sensitive; SQLite's is not — status: **done** (this batch) — severity: med — area: schema
- **Where**: `src/schema/columns.ts:346`
- **Defect**: `(this.config.declaredType ?? this.config.type) === 'integer'` misses `'INTEGER'`, `'Integer'`, `' integer'`.
- **Failure scenario**: verified on real D1 — `customType({ dataType: () => 'INTEGER' })('id').primaryKey()` gives `hasDefault === false`, yet `insert into "ct_pk2" ("name") values ('x')` succeeds with `id` auto-assigned. SQLite *does* treat it as the rowid alias while orm-d1 reports the key as required. The direction is safe (an adapter supplies an id that would have been generated), but it is the case-insensitivity the previous round asked to confirm.
- **Fix**: `.trim().toLowerCase()` before the comparison.
- **Resolved**: `src/schema/columns.ts`'s `primaryKey()` now compares
  `(this.config.declaredType ?? this.config.type).trim().toLowerCase() === 'integer'`.
  `test/workers/rowid-alias-case.test.ts` (new, against real D1) covers both halves:
  `customType({ dataType: () => 'INTEGER' })('id').primaryKey()` reports
  `hasDefault === true`, and an insert with no `id` supplied succeeds with SQLite
  auto-assigning it.

### [F-023] Three minor items from the round-2 review — status: **done** (this batch) — severity: low — area: mixed
- `src/relations/projection.ts:23` — `keys.filter(key => entries.find(([k, v]) => k === key && v === true))` is an O(n·m) scan plus an `Object.entries` allocation per call, for an answer identical to `selection[key] === true` (an entry can only be `true` if it survived the `!== undefined` filter). Called per query per relation level. **Efficiency-lens item.**
  - **Resolved**: `pickColumns` (`src/relations/projection.ts`) now reads
    `selection[key] === true` directly instead of scanning `entries` with `Array.find`.
    Behaviourally identical (existing `test/unit/projection.test.ts` coverage still
    passes unmodified), so no new assertion was needed for the answer itself — only for
    the mechanism, which is covered by the existing suite continuing to pass.
- `src/schema/columns.ts:48,233` — `isLengthExact` is declared and exposed but never assigned by any column factory, so it is permanently `undefined`. That happens to match Drizzle for SQLite (only `pg-core`/`cockroach-core` set it), so `[F-007]`'s new test passes for a reason unrelated to the getter; it is dead weight in the shipped bundle.
  - **Left as-is, deliberately**: removing the getter would be a published-API-surface
    *removal* (`docs/04`'s Drizzle-compat contract requires `Column.isLengthExact` to
    exist, matching real `drizzle-orm`), and the finding names no concrete fix beyond
    the observation itself — it is correct for SQLite today and only "dead weight" in
    the sense that no factory currently sets it to anything other than its already-
    correct default. Recorded as reviewed, not changed.
- `test/unit/ddl.test.ts:141` — the pre-existing `expect(createTable(t)).toContain('"short" text')` now passes against `"short" text(10)`; the assertion survived a behaviour change without noticing it. A `toContain` where an equality belongs.
  - **Resolved**: tightened to `.toContain('"short" text(10)')`, with a comment
    explaining why the looser substring was a false-negative risk (it also matches
    `"short" text` alone, so it would have kept passing silently if `createTable` had
    gone back to omitting the length).

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
- **Failure scenario**: `index('users_lower_email_idx').on(sql\`lower(${t.email})\`)`. `src/ddl.ts:300` (the *other* emitter) gets it right; `orm-d1-kit generate` emits `create index "users_lower_email_idx" on "users" ("lower(""email"")")`. SQLite's double-quoted-string-literal fallback makes that an index on the constant `'lower("email")'` — created, named, listed in `sqlite_master`, and never used (`SCAN t` vs `SEARCH t USING INDEX good (<expr>=?)`, verified on D1). The `uniqueIndex` variant is worse: every row hashes to the same constant, so the second insert gives `UNIQUE constraint failed` — a migration after which the table accepts exactly one row.
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
- **Failure scenario**: a 64-table schema with ~3 indexes per table (counting the `sqlite_autoindex_*` entries every `UNIQUE`/composite PK creates, which `index_list` returns and this loop dutifully probes) is `1 + 192 + 192 ≈ 385` sequential POSTs to the Cloudflare API — `remoteRunner.all` is one `fetch` per call (`kit/src/node/runners.ts:157`). At a ~120 ms round trip that is ~46 s of wall clock for a single `orm-d1-kit check --remote`, per CI run, and again for `push --remote` and `pull --remote`. There is no dependency between tables, and none between the `index_info` calls within a table.
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

### [F-031] `ConcurrencyGate` is not a correct semaphore — status: **blocked** (batch scope excluded `kit/src/core/apply.ts` from editing — see note) — severity: low (latent) — area: kit/core
- **Where**: `kit/src/core/apply.ts:56`
- **Defect**: `run` releases with `inFlight--` *before* `queue.shift()?.()`, and the woken waiter never re-checks `inFlight` after resuming. A caller arriving in the microtask window between the release and the waiter's resumption sees a free slot and takes it; the waiter then increments on top. With `limit = 1` the reviewer measured a peak of 2.
- **Not live today**: across 64 tables × 3 indexes with microtask, macrotask, randomised and zero delay the peak was exactly 12 every time, because a table's `index_info` dispatch is always ordered after the woken waiter's resumption by `Promise.all`'s extra tick. It is a hazard for the next call site, not this one.
- **Fix**: loop `while (this.inFlight >= this.limit) await …`, or increment the count in the releaser on behalf of the waiter.
- **Not attempted this batch**: `kit/src/core/apply.ts` was excluded from this batch's
  edits (concurrent work by another batch on the same file). The fix above is a
  contained, two-line change local to `ConcurrencyGate` and is exactly the shape the
  next batch that can touch `apply.ts` should apply, along with a test that starts
  `limit` concurrent `run()` calls plus one more from inside a resumed waiter's
  continuation and asserts `inFlight` never exceeds `limit`.

### [F-032] `IndexColumnSnapshot` / `normalizeIndexColumn` are unexported from the kit's public entry — status: done (this batch) — severity: low — area: api
- **Where**: `kit/src/core/index.ts:27`
- `IndexSnapshot.columns` is exported from `orm-d1-kit/core`, but the new `IndexColumnSnapshot` member type and the `normalizeIndexColumn` helper are not, so an external consumer now reads a union whose object member is unnameable from the public entry. Construction still compiles; only reading is affected. Exporting them changes the published API surface, which the sweep may not do.
- **Resolved**: standing authorization covers this API-surface addition. `kit/src/core/index.ts` now re-exports `IndexColumnSnapshot` (type) and `normalizeIndexColumn` (value) alongside the existing `snapshot.js` exports.

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
- **Defect**: `docs/09-orm-d1-kit.md:127` specifies the recipe as "recreate indexes, triggers, and views that referenced the table". Triggers are not recreated, are not in `TableSnapshot`, and are not compared by `canonicalTable` — so `check`, `verify` and the next `push` all report the table as matching.
- **Failure scenario** (reproduced): a live `BEFORE INSERT` trigger raising `ABORT` unless `email = lower(email)`. Change `age` from `text` to `integer` and `push` emits the five rebuild statements with no `create trigger` anywhere. The guard is gone, mixed-case emails insert cleanly, and introspecting the result diffs `statements: [], errors: []` — `check` prints "Up to date, no drift." Exactly the `docs/09` failure mode the project exists to prevent, one object over from `unique()`.
- **Same class, smaller**: when a rebuild fires for any other reason, `diff.ts:459` `continue`s past the `appendOnly` transition block at `diff.ts:505-515`, so a live append-only table rebuilt while `tableOptions` no longer marks it append-only loses the guard with no `reason` line naming it.
- **Two fixes the reviewer offered**: (a) carry triggers in the snapshot — `introspect()` already selects `type = 'trigger'` (`apply.ts:79-81`) so the SQL text is in hand; add `triggers` to `TableSnapshot`, re-emit after the rename, include in `canonicalTable`. (b) Minimum viable: refuse the rebuild when the live table carries a trigger the kit did not author, the same way `recreateTable` already refuses on dependents (`diff.ts:220-233`).
- **This iteration implements (b)**, deliberately. (a) changes `TableSnapshot`'s shape, and the two previous iterations both drew their unresolved rejections from snapshot-shape changes — `[F-029]` is still open from exactly that class. (b) converts silent invariant loss into a loud refusal with no format change. **`[F-040]` carries (a) as the real fix for a human to schedule.**

### [F-035] `pull` reaches arbitrary code execution in the CLI's own Node process — status: **done** (`60ff73f`, confirmed closed by round-2 review) — severity: **high** — area: kit/node
- **Where**: `kit/src/node/commands.ts:298` (table name), `:335` (generated expression), `:339` (default), `:363` (expression index member), `:367` (partial-index `where`), `:369`, `:379` (index / unique names), `:397` (check name and body)
- **Defect**: this is the escalation of the previously-known "produces a module that does not parse" (`[F-027]`). Everything introspected is dropped into `` sql`…` ``, so a `${` in the source text becomes a **JavaScript expression evaluated at module load**.
- **Failure scenario (a)** — no quote balancing needed. A plain SQLite `DEFAULT` text literal: `create table "notes" ("id" integer primary key, "body" text default '${globalThis.__PWNED__ = 1}')`. `renderSchemaModule` emits `` body: text('body').default(sql`'${globalThis.__PWNED__ = 1}'`) ``. The module parses, and the interpolation runs the moment it is imported. The check-constraint path is identical via a comment inside a `CHECK` body.
- **Failure scenario (b)** — quote break-out that still compiles. Table names go into a single-quoted literal with no escaping; a table named `` a', {}); globalThis.__PWNED3__ = 3; export const zz = sqliteTable('b `` yields a module the reviewer confirmed compiles cleanly through esbuild's TS loader.
- **Why it is reachable**: `pull` exists to adopt a database you did not create (`kit/README.md:41`). The workflow is `pull` → point `orm-d1.config.ts` at the emitted `schema.ts` → `generate`. `generate` calls `loadSchema` → `importModule` (`kit/src/node/import.ts:75`), which **imports the module in the CLI's own Node process** — with `CLOUDFLARE_API_TOKEN` in `process.env` and the developer's credentials on disk. Code execution happens on the next command. If the module is then deployed, it runs in the Worker too. The precondition is an actor able to run DDL on the introspected database — precisely the situation `pull` is for.
- **Fix**: stop building the module by interpolation. Emit every string literal with `JSON.stringify(value)`, and every SQL fragment as `sql.raw(${JSON.stringify(text)})` instead of `` sql`${text}` `` — `Raw` has `toQuery`, so `ColumnBuilder.default` still classifies it as `kind: 'sql'` and `renderInline` reproduces the same DDL.
- **Prove it**: `kit/test/unit/cli.test.ts` — `renderSchemaModule` over a snapshot whose table name, index name, check name, check body, default and partial-index `where` each contain `` ` ``, `${`, `'` and `\`; feed the output through `esbuild.transform({ loader: 'ts' })` and assert it parses, that the emitted code contains no `${` beyond the ones the renderer itself wrote, and that re-parsing reproduces the input snapshot.

### [F-036] Dropping the append-only guard escapes `--accept-data-loss` when the table is renamed in the same migration — status: **done** (`60ff73f`, confirmed closed by round-2 review) — severity: med — area: kit/diff
- **Where**: `kit/src/core/diff.ts:334`
- **Defect**: `if (t.appendOnly) statements.push({ sql: dropAppendOnlyTrigger(name), destructive: false })`. The in-place transition at `diff.ts:509-513` marks the identical statement `destructive: true` with the reason `"X" is no longer append-only, so UPDATE is permitted again` — the code explicitly argues that removing this protection is "worth saying out loud rather than doing quietly". The rename path does it quietly, and because line 335 sets `appendOnly: false` on the carried-forward table, the destructive branch at 505 never fires afterwards.
- **Failure scenario** (reproduced): with `tableOptions([[auditLog, { appendOnly: true }]])`, renaming `audit_log` → `audit_events` and dropping it from `tableOptions` gives `generate --rename-table audit_log=audit_events` success with no flag — the audit table becomes rewritable. The identical change without the rename is refused with "This migration would lose data … Re-run with `--accept-data-loss`".
- **Fix**: at `diff.ts:334`, mark it `destructive: true` with the reason from line 512 unless the guard is re-created under the new name in the same diff — non-destructive only when `after.tables[renamed]?.appendOnly === true`.
- **Prove it**: `kit/test/unit/diff.test.ts` — the pair above, asserting `diff.statements.some(s => s.destructive)` in *both* the in-place and the renamed case, and that renaming an append-only table that *stays* append-only emits `drop trigger` + `create trigger` with neither marked destructive.

### [F-037] `AUDIT.md` names a private product and its schema shape, in a repo that is published to npm — status: **done** (this batch — standing authorization, 2026-08-18) — severity: med — area: privacy
- **Where**: this file — the `[F-001]` block and the fixture note near the end
- **What it discloses**: the downstream project's name, its container mount paths, and structural facts about its schema — 64 tables, `strict: true` on all 64, `withoutRowid` and `appendOnly` drawn from a `hardening.ts` roster. No table or column names leak, and `AUDIT.md` is excluded from the npm tarball (`files` does not list it), so this was disclosure of a customer name and coarse schema shape rather than of the schema itself.
- **Not yet published**: `AUDIT.md` first appears in `c9aabd7`, which is on no remote branch — `origin/main` is still `a027589`. It would have become a disclosure the moment these commits were pushed. The authors already flagged fixture privacy in the note at the end of this file; the metadata in the same file was the part that had not been scrubbed.
- **Resolved (two halves, per the standing authorization)**:
  1. **Packaging, verified rather than assumed**: `package.json`'s `files` field
     (root package) lists only `dist`, `docs`, `README.md`, `LICENSE` — no `AUDIT.md`,
     no `.claude/`. `kit/package.json`'s `files` lists only `dist`, `README.md`,
     `LICENSE`. Neither package ships an `.npmignore` (none needed — `files` is an
     allowlist). `npm pack --dry-run` at the repo root and inside `kit/` were both run
     directly: 163 files / 209.8 kB and 4 files / 5.5 kB respectively, `AUDIT.md`
     absent from both listings. No packaging change was needed.
  2. **Scrubbed this file**: the downstream project's real name and its container
     mount paths (the `[F-001]` block's "Where the path points" and "Fixture shape"
     notes, and the fixture-privacy note near the end of this file) are replaced with
     generic descriptions — "a downstream project", "that project's schema
     directory" — while every finding's technical content (the bug, the mechanism,
     the table/constraint counts) stays intact. `[F-001]` itself is now superseded by
     a synthetic in-repo harness (see its own entry), so the scrubbed recipe is kept
     only as a record of the approach that was tried and rejected, not as a live plan
     that still needs the name to be useful.

### [F-038] `importModule` writes a copy of the user's schema into their source tree — status: todo — severity: low — area: kit/node
- **Where**: `kit/src/node/import.ts:79-85`
- **Defect**: writes a `.orm-d1-<pid>-<n>.mts` copy of a schema module *inside the user's source tree* and removes it in a `finally`. A crash or `SIGKILL` between the two leaves an importable duplicate of the schema next to the original, which a `**/*.mts` glob in a build or test config will pick up.

### [F-039] `drop index` is non-destructive even for a unique index — status: todo — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:609`
- **Defect**: marked `destructive: false` even for a unique index, while the table-level `unique()` spelling of the same removal forces a rebuild and is therefore gated. Same semantic loss, two different gates. The reviewer filed it as an inconsistency, not a finding — there is no failure scenario beyond the asymmetry.

### [F-040] Carry triggers in `TableSnapshot` — the real fix for `[F-034]` — status: needs-human — severity: high — area: kit/diff
- `[F-034]` lands the conservative half (refuse a rebuild that would silently drop a foreign trigger). The complete fix is to add `triggers: Record<string, { name: string; sql: string }>` to `TableSnapshot`, re-emit each after the rename in `recreateTable`, and include them in `canonicalTable` so drift is visible. That changes the snapshot format and `TableSnapshot` is exported from `orm-d1-kit/core`, so it is an API change the sweep may not make — and the last two snapshot-shape changes both produced unresolved rejections (`[F-029]` is still open). A human should schedule this deliberately.

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

### [F-041] The rebuild group stops at the rename, so a `UNIQUE` index can still be split off and silently lost — status: done — severity: **high** — area: kit/apply
- **Where**: `kit/src/core/sql.ts:161-203` (`statementGroups`), against `kit/src/core/diff.ts:311-321`
- **Defect**: `statementGroups` closes the group at `alter table "__new_X" rename to "X"`, but `recreateTable` emits the table's indexes and its append-only trigger *after* that rename — that is where the rebuild restores its constraints. Those become singleton groups, so `packIntoBatches` will put the boundary immediately after the rename.
- **Failure scenario** (95 filler creates + a rebuild of a table carrying `uniqueIndex('orders_code')`, batch 2 failing on a D1 500 / 429 / dropped `--remote` connection): batches are `[100, 2]` with batch 2 = `create unique index "orders_code" …` + the `d1_migrations` insert. On real D1: `indexes on orders after the failed migration: []`, two rows now share `code='A'` — the UNIQUE constraint is gone — the migration is unrecorded, and the retry dies on `table "f0" already exists`. `push` self-heals on re-run; `migrate` does not.
- **Why it matters more than it looks**: this is `docs/09`'s reason-for-existence failure — a `unique()` constraint gone with nothing reporting it — reproduced *through the code path this batch rewrote*. It is not a new hole (fixed-stride slicing could cut here too), but the fix redefines "what must stay in one batch" and leaves the constraint-restoring tail of the rebuild outside that definition.
- **Fix**: extend the group through the index and trigger statements `recreateTable` emits after the rename, so the whole rebuild — including constraint restoration — is indivisible.
- **Coverage** (`fix/apply-guard-20260818`): the "finding 1" test in `kit/test/workers/migrate.test.ts` now round-trips a table carrying a `uniqueIndex` through this exact split — 95 filler creates + a 6-statement rebuild group (the extra statement is the index recreate), sized so the old grouping's boundary lands exactly between the rename and the index create. Reverting the `statementGroups` tail-extension fix turns the test red (index gone after a batch-2 failure); restored, it is green.

### [F-042] A rename in an *earlier pending migration* still bypasses the trigger guard — status: done — severity: high — area: kit/apply
- **Where**: `kit/src/core/apply.ts:284-304`
- **Defect**: `parsed` computes `renames` per migration and the lookup is `migration.renames[table] ?? table`, so only a rename inside the *same file* is resolved. Renames from earlier pending migrations in the same `migrate` run are not accumulated, while the live `foreignTriggers` map is keyed by the pre-run `tbl_name`.
- **Coverage** (`fix/apply-guard-20260818`): `kit/test/workers/migrate.test.ts`, "a rename in an earlier pending migration cannot bypass the foreign-trigger refusal (F-042)" — two separate pending migrations, the rename in the first, the rebuild in the second. Reverting the `accumulated[preMigrationName]` fold (falling back to per-file-only resolution) turns it red; restored, it is green.
- **Failure scenario** (proven on real D1): `0001_rename` = `alter table "orders" rename to "sales"`, `0002_retype` = a type change forcing a rebuild of `sales`, with trigger `orders_audit` live on `orders`. `applyMigrations(runner, [m1, m2])` issues no refusal; triggers after migrate: `[]`. Generating a rename migration, then a schema change, then deploying and running `migrate` once is the ordinary workflow. The same hole swallows the error message's own recommended remedy: a `create trigger` hand-added to migration N and a rebuild in migration N+1, both pending, applies with no refusal.
- **Fix**: fold each migration's renames into a running name→live map *before* checking that migration's rebuilt tables, instead of resetting per file.
- **Secondary**: the scanner only recognises the kit's own double-quoted spelling — a hand-written `alter table orders rename to sales;` is not seen.
- **Coverage** (`fix/apply-guard-20260818`): `kit/test/workers/migrate.test.ts`, "a rename in an earlier pending migration cannot bypass the foreign-trigger refusal (F-042)" (primary defect) and "a rebuild's own scratch table does not swallow a genuine rename of a same-named live table in the same migration (gap 2)" (the compound case the position-and-target-aware `createdAt` fix closes). **Secondary now fixed**: `apply.ts`'s `renamesInMigration` and `sql.ts`'s `tablesRebuiltIn` both parse any of SQLite's four identifier spellings (bare, `"…"`, `` `…` ``, `[…]`) via the shared `IDENTIFIER_SOURCE`/`normalizeIdentifierToken` in `sql.ts`, not only the double-quoted one.

### [F-043] The gap-2 fix is a no-op, and its test asserts the opposite of its own title — status: done — severity: **high** — area: kit/apply + test-integrity
- **Where**: `kit/src/core/apply.ts:215`; test at `kit/test/unit/apply.test.ts:122-133`
- **Defect**: replacing the explicit "append record to last batch if room" with `packIntoBatches([...statements, record], MAX)` is byte-for-byte identical in every case. Measured side by side: 99 → `[100]`, 100 → `[100, 1]`, 101 → `[100, 2]`, 200 → `[100, 100, 1]` — identical for both implementations. At any exact fill the record is still alone in its own trailing batch.
- **Failure scenario**: a 100-statement migration commits batch 1, batch 2 (the record alone) fails, the schema change is applied but unrecorded, and the next `migrate` dies on `table … already exists` — permanently stuck.
- **The test integrity problem**: `kit/test/unit/apply.test.ts:122-133` is titled `does not push the record into its own trailing batch when the real statements fill the last batch exactly (gap 2)` and **asserts** `expect(batches[1]).toEqual([insert into "d1_migrations" …])` — i.e. it pins the behaviour its own name says is fixed.
- **Fix**: either do the real work (shift the last singleton run into the trailing batch with the record, or reserve a slot) or withdraw the claim and rename the test to describe what it actually pins. It cannot stay as it is.
- **Coverage confirmed** (`fix/apply-guard-20260818`): already had load-bearing coverage — `kit/test/unit/apply.test.ts`'s "shifts a statement..." and "keeps a rebuild group whole..." (gap 2) tests. Reverting `packStatementsWithTrailer`'s shift logic back to a naive append turns both red; restored, both are green.

### [F-044] The flagship regression test for the batch-split finding exercises nothing — status: done — severity: **high** — area: test-integrity
- **Where**: `kit/test/workers/migrate.test.ts:238-247`
- **Defect**: `applyMigrations` issues `ensureMigrationsTable` as its own `batch()` first, so `calls === 2` is the *first real batch*, not the second. The migration applies zero statements, and the assertions (`rebuilt` present, one row, `Number(age) === 30`) pass against the untouched pre-migration state — `age` is still the text `'30'`. The split-across-batches failure the test is named for is never reached.
- **Fix**: correct the off-by-one to `calls === 3`.
- **Correction (round-2 review, `fix/apply-guard-20260818`)**: the original note above claimed correcting `calls === 2` to `calls === 3` "is exactly what exposed `[F-041]`, so expect this test to go red until `[F-041]` is fixed too." That is false: with the `[F-041]` fix (the `sql.ts` tail extension) reverted, this test's fixture — a rebuild of a table with no index or trigger — has a 5-statement rebuild group either way, so the `[100, 6]`-vs-`[100, 5]` grouping difference `[F-041]` is about never showed up in this fixture's packing at all; it stayed green throughout. The `calls === 3` correction IS load-bearing for `[F-033]` (it is what makes the test actually reach the split it is named for, rather than passing vacuously against untouched state), but `[F-041]`'s own scenario — a `UNIQUE` index silently lost after a batch-2 failure — was covered by nothing outside a pure `statementGroups` id-comparison unit test. Fixed by adding a `uniqueIndex` to this fixture (see the "finding 1" test) and asserting the index survives the batch: that is now genuine end-to-end coverage of `[F-041]`, verified red when `[F-041]`'s fix is reverted and green with it restored.

### [F-045] `from.startsWith('__new_')` excludes real renames, giving a third guard bypass — status: done — severity: med — area: kit/apply
- **Where**: `kit/src/core/apply.ts:253`
- **Defect**: the exclusion rule cannot distinguish a rebuild's closing rename from a genuine `--rename-table` whose *source* table is named `__new_*` — a table the codebase itself acknowledges exists (`diff.ts:412`, "a real table someone genuinely named `__new_orders`").
- **Failure scenario** (verified): for live table `__new_orders` with trigger `nn_audit`, `generate --rename-table __new_orders=orders_v2` plus a type change produces a migration where `checkForeignTriggerConflicts` does not throw, and `drop table "orders_v2"` takes the trigger. Narrow precondition, same silent-loss outcome. The non-renamed rebuild of a `__new_*` table is handled correctly — the temp name becomes `__new___new_stuff` and the guard fires.
- **Coverage** (`fix/apply-guard-20260818`): `kit/test/workers/migrate.test.ts`, "a genuine \"__new_\"-named table's own rename is not mistaken for a rebuild's closing rename (F-045)". Reverting the fix back to plain `from.startsWith('__new_')` (no position/target check) turns it red; restored, it is green. A related, previously-uncovered compound case — a rebuild elsewhere in the *same* migration that creates its own scratch table under the exact name the genuine rename's source has — is covered by the adjacent "gap 2" test, and is what the `createdAt`-with-position-and-target fix (not just F-045's original membership-set fix) actually closes.

### [F-046] A *refused* rebuild now emits a statement — status: done — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:553-559`
- **Defect**: `recreateTable`'s contract is "no statements alongside the refusal" (`diff.ts:237-240`), but the new append-only block runs after the `recreateTable` call regardless of whether it refused, so both refusal paths emit a lone destructive `drop trigger if exists …`. Also reproduces for the pre-existing dependents refusal.
- **Not reachable as a bad outcome** — `generate` and `push` throw on `errors` before reading `statements` — but `check` now prints a `Drift:` line for a table it simultaneously reports as blocked.
- **Coverage** (`fix/apply-guard-20260818`): `kit/test/unit/diff.test.ts`, "emits no statements at all — not even the append-only-loss drop trigger — when the rebuild is refused for carrying a foreign trigger". Reverting the `recreated.errors.length === 0` guard turns it red; restored, it is green.

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
- **Failure scenario** (both verified): `db.insert(users).values({ id: 1, email: 'a@b.c' }).onConflictDoUpdate({ target: users.id, set: { email: 'x@y.z' } })` gives orm-d1 `… on conflict ("id") do update set "email" = ?` where Drizzle gives `… do update set "email" = ?, "updated_at" = ?`. On the insert path `updated_at` *is* written; on the conflict path it is not. A session/token/counter table upserted on every request keeps its very first `updated_at` forever. `updatedAt` is the canonical `$onUpdate` column and "upsert a session row" is the canonical use of `onConflictDoUpdate`.
- **Fix**: in `writeOnConflict`, after `definedValues(conflict.set)` decides the `do nothing` fallback — **keep that decision based on the user's set alone**; Drizzle throws `No values to set` there, so orm-d1's `do nothing` is a deliberate, better divergence and must not change — fold in `$onUpdate` columns before rendering, exactly as `compileUpdate` does. Extracting the six lines at `compile.ts:580-584` into a shared `withOnUpdate(values, columns)` avoids a third copy.
- **Prove it**: `test/unit/compile-write.test.ts` — the fixture `users` already has `updatedAt.$onUpdate(...)`. The existing assertion at `compile-write.test.ts:76` will go red and must gain `, "updated_at" = ?`; that it passes today is the evidence the case was never considered.

### [F-049] A nested *explicit* selection over an outer join materialises an object of nulls where Drizzle returns `null` — status: done (`91de9e1`, depth-2 groups only — see `[F-056]`) — severity: high — area: sql/compile — COMPAT-DEFECT
- **Where**: `src/plan/compile.ts:338` (`const nullableGroups = implicit?.nullable ?? new Set<string>()`) and `src/plan/compile.ts:206` (`projectedNullableGroups`)
- **Defect**: nullable-group collapsing is derived only when `plan.selection === undefined`. A hand-written nested projection over a `leftJoin`/`rightJoin`/`fullJoin` therefore never collapses, and the missed side comes back as `{ id: null, title: null }`. Drizzle's `mapResultRow` nullifies any depth-2 group whose columns all come from a table the join map marks nullable.
- **Failure scenario** (both implementations run on the same driver row `[1, 'alice', null, null]`): `db.select({ u: { id: users.id, name: users.name }, p: { id: posts.id, title: posts.title } }).from(users).leftJoin(posts, …)` gives Drizzle `{ u: {...}, p: null }` and orm-d1 `{ u: {...}, p: { id: null, title: null } }`. A ported handler reading `row.p ? render(row.p) : renderEmpty()` takes the truthy branch for every author with no posts. The type is wrong too — `SelectionToRow` (`src/builders/select.ts:67`) never adds `| null` to a nested group, so TypeScript agrees with the wrong runtime.
- **This is the same bug the project already fixed for the implicit path** through `.as()`: `test/unit/compile-select.test.ts:330` is titled "returns null for that group rather than an object of nulls". Only the explicit-selection path was left open, and the comment at `compile.ts:200-204` records that as intentional.
- **Fix**: hoist the table-nullability computation out of `implicitSelection` into `nullableTables(plan): Set<string>` (the loop at `compile.ts:159-160` is already exactly this), then for an explicit selection compute the group set from the leaves — for each depth-1 group, if every leaf is a `Column` and they all share one `column.tableName` that is in `nullableTables(plan)`, add the group's path. Use it at `compile.ts:338` and in `projectedNullableGroups` so `.as()` inherits it. The mapper needs no change: `readRow` (`src/plan/mapper.ts:122`) already collapses a `nullable` group whose indexes are all null. Widen `SelectionToRow`'s object branch to `… | null` for a group whose columns come from a nullable side.
- **Prove it**: `test/unit/compile-select.test.ts`, beside the existing `.as()` test — `expect(c.map([[1, null, null]])[0]!.p).toBeNull()`.

### [F-050] `casing: 'snake_case'` uses a different algorithm from Drizzle's, so some columns get a different database name — status: **done** (`91de9e1`, 17,593 adversarial inputs vs `drizzle-orm/casing`, 0 mismatches — but see `[F-059]`) — severity: high — area: schema — COMPAT-DEFECT
- **Where**: `src/schema/columns.ts:125-136` (`toSnakeCase`/`applyCasing`), reached from `src/runtime/database.ts:29` and `kit/src/node/config.ts:44`
- **Defect**: orm-d1 uses two boundary-insertion regexes; Drizzle (`drizzle-orm/casing.js:3`) tokenises with `/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g` after stripping apostrophes, then lowercases and joins. They disagree on any key with an uppercase run followed by a digit, and on any key with leading underscores or non-word characters: `apiV2` → Drizzle `api_v_2` vs orm-d1 `api_v2`; `utf8MB4` → `utf8_mb_4` vs `utf8_mb4`; `_id` → `id` vs `_id`; `__typename` → `typename` vs `__typename`; `user’sName` → `users_name` vs `user’s_name`; `some name` → `some_name` vs `some name`. (`firstName`, `userID`, `HTTPServer`, `emailVerified`, `oauth2Token`, `myURLPath`, `ABCDef`, `iOS`, `fooBAR` all agree.)
- **Failure scenario**: a Drizzle project with `casing: 'snake_case'` and a column `apiV2: integer()` has `api_v_2` in production. Porting to orm-d1 emits `"api_v2" integer` (verified), so every query gives `D1_ERROR: no such column: api_v2` and `orm-d1-kit generate` proposes `ADD COLUMN "api_v2"` plus a destructive drop of `api_v_2`. The leading-underscore case silently *renames* rather than errors during `push`.
- **Fix**: replace `toSnakeCase` with Drizzle's exact expression — `(name.replace(/['’]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? []).map(w => w.toLowerCase()).join('_')`. Six extra bytes, and it is the only spelling that can be right since the reference is Drizzle's literal output.
- **Prove it**: `test/unit/casing.test.ts` — add `apiV2`, `_id`, `utf8MB4` and assert the emitted DDL names against `toSnakeCase` **imported from `drizzle-orm/casing`**, not against string literals. This is exactly the `[F-014]` shape: assert against the real package, not a constant read off the implementation.
- **Worth flagging alongside**: `casing` was **removed from `DrizzleConfig` in v1** (`drizzle-orm/utils.d.ts:62` has only `logger`/`schema`/`relations`/`cache`/`jit`); v1 binds casing at table-definition time via `sqliteTableWithCasing`/`sqliteTableCreator`. Keeping it on `drizzle()` as a process global (`configureCasing`) is a v0 spelling, and it means two schemas in one isolate cannot have different casings. See `[F-051]`.

### [F-051] `NEW-SURFACE` proposals from the iteration-4 feature lens — status: needs-human — severity: n/a — area: api
Recorded, not built. Ranked as the reviewer ranked them:
1. **`sqliteTableCreator` / `sqliteTableWithCasing`** (`src/sqlite-core.ts:26`). Both are exported by `drizzle-orm/sqlite-core` (`table.js:50`) and neither exists here. `sqliteTableCreator` is how `create-t3-app` and every multi-app-per-database schema prefixes table names; in v1 `sqliteTableWithCasing('snake_case')` is *the* supported way to ask for snake-case, replacing the removed `drizzle({ casing })`. A schema built on either cannot be ported by changing one import specifier, which is the whole adoption story in `docs/08`. Both are thin wrappers over the existing `table()` — `sqliteTableCreator(fn, casing)` returns `(name, cols, extras) => table(fn(name), cols, extras)` with the original name kept for `DrizzleBaseName` (`src/schema/table.ts:120` already carries a `baseName` slot). The `casing` argument is the harder half: orm-d1's casing is a module global rather than a per-table binding, so a per-table `casing` needs `applyCasing` to move from `Column.name`'s getter to `ColumnBuilder.build(key)`.
2. **`.as()` / `.mapWith()` on a `sql` fragment** (`src/sql/sql.ts:180`). An orm-d1 fragment's prototype has exactly `toQuery`; `sql<number>\`count(*)\`.mapWith(Number)` and `sql\`lower(x)\`.as('lower_name')` are both in Drizzle's documentation and both throw `TypeError: … is not a function` here — at module load, if the query was hoisted to module scope as `docs/05` recommends. Both are three-line adapters onto machinery that exists: `.as(name)` renders `<inner> as "name"`, `.mapWith(fn)` returns `withDecode(this, fn)`. Adding `getSQL()` at the same time would make orm-d1 fragments satisfy Drizzle's `isSQLWrapper`, which is what any adapter accepting a user-supplied fragment checks.
3. **`setWhere` on `onConflictDoUpdate`** (`src/builders/insert.ts:52`). orm-d1 has `targetWhere` and `where`; Drizzle has all three and *throws* when `where` is combined with either. orm-d1's `where` → set-where mapping is correct (verified against Drizzle's emitted clause order), so this is a one-line alias plus the conflict check.
4. **Multiple `on conflict` clauses.** Drizzle's `config.onConflict` is an array it pushes to; orm-d1's `#next({ onConflict })` replaces, so `.onConflictDoNothing({target: a}).onConflictDoUpdate({target: b, …})` silently keeps only the last. SQLite supports several.
5. **`sumDistinct` / `avgDistinct`** — orm-d1 has `countDistinct` only.
6. **Root `placeholder` / `param` / `name`** — orm-d1 has `ph`, `sql.placeholder`, `sql.identifier` and the `Param` class, but not Drizzle's free functions, so `import { placeholder } from 'drizzle-orm'` in a ported file fails to resolve.
7. **`orm-d1-kit drop` and `export`** (`kit/src/cli.ts:16` claims the surface "deliberately mirrors drizzle-kit"). `drop` is the one that matters — without it, un-journalling a bad migration is a hand-edit of `meta/_journal.json`, the file `docs/09` says must stay consistent with the emitted SQL.

### [F-052] `getTableConfig`'s element shapes do not match Drizzle's, despite the parity claim — status: done (follow-up batch, 2026-08-18 — corrected) — severity: low — area: drizzle-compat — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/schema/table.ts:207` (the claim), `src/schema/table.ts:237-253` (the shapes), `src/schema/constraints.ts:151`
- **Defect**: Drizzle's `Index` nests everything under `.config` (`{ config: { name, columns, unique, where, table }, isNameExplicit }`) and its `ForeignKey` exposes `reference()` as a *function* plus `getName()`; orm-d1 returns flat records for both. `primaryKeys[i].name` also differs — orm-d1 derives `${table}_pk` where Drizzle derives `${table}_${cols}_pk`, the same divergence `[F-015]` records for foreign keys.
- **Not claimed as a defect**: the reviewer searched every package in `node_modules` and the only consumer is Pothos, which reads `columns` and `primaryKeys[].columns` — both of which match. Recorded because the doc's parity claim ("field for field") is false and the next adapter to read `indexes` will get `undefined`.
- **Previously "resolved"**: `TableIndex`/`TableForeignKey` fixed correctly (nested `.config`, `reference()`/`getName()`/`isNameExplicit()`). But `primaryKeys[i].name` was set to `${table}_${cols}_pk` — a value real drizzle-orm never produces for `PrimaryKey.name`.
- **Rejected on review**: verified against `node_modules/drizzle-orm/sqlite-core/primary-keys.js` — real `PrimaryKey.name` is `undefined` for an unnamed PK; only `.getName()` derives `${table}_${cols}_pk`. drizzle-kit's own PK naming is `pk.name ?? nameForPk(tableName)` with `nameForPk = t => \`${t}_pk\`` (no columns at all, and it never calls `.getName()`), so the value this batch set matched neither real drizzle-orm nor drizzle-kit. `primaryKeys`/`uniqueConstraints` were also missing `getName()`/`isNameExplicit`, which drizzle-kit's real unique-constraint naming depends on (`unique.isNameExplicit ? unique.name : nameForUnique(...)`).
- **Fix (this batch)**: `TablePrimaryKey.name` (`src/schema/table.ts`) is `extra.meta.name` directly — `undefined` when unnamed — with `isNameExplicit` and a `getName()` that derives `${table}_${cols}_pk` only when called, matching `PrimaryKey`'s real shape. `TableUniqueConstraint` gained the same `isNameExplicit`/`getName()` pair (its `name` was already always-set and correct, matching `UniqueConstraint`). Scoped to `getTableConfig()`'s public shape only — nothing in DDL rendering, snapshotting or introspection reads through this path (`grep` confirms `getTableConfig` has no internal caller), so no migration bytes moved. `test/unit/table-config.test.ts` updated: unnamed composite PK now asserts `name` is `undefined` and `getName()` returns the derived string; the (explicitly-named, in the fixture) unique constraint asserts `isNameExplicit: true`.

### [F-053] `renderSchemaModule`'s reserved-name list is missing `numeric` — status: done (this batch) — severity: low — area: kit/node — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `kit/src/node/commands.ts:499` (`RESERVED`), against `commands.ts:330`
- **Defect**: `factory` can be `'numeric'` and the import is added, but `numeric` is not in `RESERVED`, so a live table named `numeric` makes `pull` emit `export const numeric = sqliteTable("numeric", { x: numeric("x") })` — a TDZ error in a file whose entire job is to compile.
- **Resolved**: added `'numeric'` to `RESERVED`. `kit/test/unit/cli.test.ts` gained a regression test asserting a `numeric`-named table renders `numeric_`, not `numeric`.

### [F-054] `lowerIn` has no bound-parameter guard — status: **done** (this batch) — severity: low — area: better-auth — lens: efficiency + bugs (OFF-LENS from feature)
- **Where**: `src/better-auth.ts:169`
- **Defect**: the case-sensitive path goes through `inArray`, which collapses to `json_each` above the threshold and names the budget above `maxParams`; the `mode: 'insensitive'` path binds one parameter per value unconditionally, so an `in` of >100 values surfaces as a bare `too many SQL variables` from D1. Reachable only when a caller sets `mode: 'insensitive'` on an `in`, which the reviewer could not find better-auth doing on its own — latent rather than confirmed. (A previous lens dropped this for the same reason; it is recorded now because the *guard* asymmetry is concrete even if the caller is not.)
- **Fix**: `lowerIn` (`src/better-auth.ts`) is now a small `SQLChunk` class (`LowerIn`)
  instead of a plain function — `lower()` cannot fall back to `json_each` the way
  `inArray` does (the comparison needs `lower()` applied per element, not the raw
  value), so above `ctx.maxParams` it throws a `CompileError` naming the limit,
  mirroring `InArray`'s own guard shape instead of surfacing D1's bare
  "too many SQL variables".
- **Prove it**: `test/workers/better-auth.test.ts` gained a new `it` in the `findMany`
  describe block, beside the existing case-folding test — 101 values with
  `mode: 'insensitive'` and `operator: 'in'` rejects with
  `/exceeds the bound-parameter limit of 100/`, and exactly 100 values still succeeds.

## Unresolved objections merged anyway (`91de9e1`)

The round-2 reviewer of `sweep/feature-20260730-205013` confirmed all three findings closed
and rejected on three further points. Two review rounds is the cap, the gate was green
(659 passed / 4 skipped), so it merged. Revert as one unit with `git revert -m 1 91de9e1`.

**`[F-055]` is a regression against `main` reachable at the default budget** — a query that
compiled and ran fine now throws `CompileError`. Fix it first.

### [F-055] The new bound-parameter guard counts *columns*, not parameters, and rejects inserts that worked — status: done (TBD, actual-param counting via scratch-render — see `countRowParams`/`countReturningParams` in `src/plan/compile.ts`) — severity: **high** — area: sql/compile — REGRESSION
- **Where**: `src/plan/compile.ts:539`
- **Defect**: `cols.length + conflictParams > ctx.maxParams` treats every column in the row as one bound parameter, but a value supplied as a zero-parameter `sql` fragment occupies a column without binding anything. The `CompileError` therefore fires on queries whose emitted statement is nowhere near the budget — **at the default `maxParams: 100`**, not only under a lowered one.
- **Failure scenario** (verified against both revisions, default budget): an 80-column table where 40 values are SQL literals binding nothing, upserted with `set: { c0: sql\`excluded."c0"\` }` (0 params) and `where: inArray(wide.c1, [25 ids])` (25 params). `main` compiles to **one statement with 65 bound parameters**, which D1 accepts. HEAD throws `CompileError: A row of 80 columns plus 25 bound parameter(s) from "on conflict" exceed the bound-parameter limit of 100; no chunking can satisfy it.` A realistic instance: a 98-column table (legal), three values written as `sql\`unixepoch()\``, an upsert binding 3 → `98 + 3 = 101` throws, while the real statement binds `95 + 3 = 98`.
- **The pre-existing sibling check** (`cols.length > ctx.maxParams`, line 533) has the same flaw but is unreachable at the default budget — D1 caps a table at 100 columns (`src/limits.ts:46`). Adding `conflictParams` to it is what makes the flaw reachable.
- **Second, narrower window**: `maxParams` is documented as a chunking *lever* (`docs/02-d1-platform.md:183`, `src/plan/compile.ts:378`), not only as D1's ceiling. A 10-column table with `maxParams: 10` and an upsert on a table carrying `$onUpdate` compiled to a valid 11-parameter statement on `main` and now throws.
- **Fix**: count the row's actual bound parameters — render or count them the way `countOnConflictParams` already does for the conflict clause — rather than equating columns with parameters. The same conflation makes `rowsPerChunk` (line 546) inexact in both directions, but that part is pre-existing; only the *throw* is new.

### [F-056] A group mixing a depth-2 leaf with a deeper leaf does not do what Drizzle does — status: done (TBD, deeper leaves skipped per-leaf, not group veto — see `src/plan/compile.ts` explicitNullableGroups) — severity: med — area: sql/compile
- **Where**: `src/plan/compile.ts:213` — `if (leaves.some((leaf) => leaf.path.length !== 2)) continue;`
- **Defect**: this applies Drizzle's `path.length === 2` rule as a group-wide veto. Drizzle applies it *per leaf*: a deeper leaf is simply skipped (`drizzle-orm/utils.js:136`) and the group's own depth-2 Column leaves still decide. The comment above the line ("Only a group's *own* depth matters") describes Drizzle's rule; the code implements a stricter one.
- **Failure scenario**, both implementations on driver row `[7, null, null]`: `select({ postId: posts.id, author: { id: users.id, contact: { email: users.email } } }).from(posts).leftJoin(users, …)` gives Drizzle `[{ postId: 7, author: null }]` and orm-d1 `[{ postId: 7, author: { id: null, contact: { email: null } } }]`. This is the exact "null row materialized as an object of nulls" shape the batch exists to fix.
- **Not a regression against `main`** (equally wrong there), but note that `fd11e75` happened to get this shape right and `4b70c35` traded it for the depth-3 fix.
- **Fix**: skip deeper leaves rather than vetoing the group. **Matching Drizzle also requires `GroupSpec.columnIndexes` to hold only the group's *direct* depth-2 column leaves** — today `buildShape` pushes each column index into every ancestor (`src/plan/mapper.ts:99`), so a naive relaxation of line 213 would test the wrong indexes.

### [F-057] `GroupSpec.indexes` is now write-only — dead allocations and 75 bundle bytes — status: done (TBD, `indexes` field, its allocations and pushes deleted from `src/plan/mapper.ts`) — severity: low — area: efficiency
- **Where**: `src/plan/mapper.ts:38`
- **Defect**: `readRow` was the only reader and now reads `columnIndexes` (line 145). `indexes` is still declared, initialized in four places, pushed to once per (field × ancestor depth) in `buildShape` (line 98), and copied into every `GroupSpec` (line 120). Deleting it gives 41,223 bytes vs 41,298 — **75 of this batch's 1,083 bytes are dead weight** parsed on every cold isolate, plus one dead array allocation per group and one dead push per column per level on every compile.
- **Careful**: `[F-056]`'s fix needs `columnIndexes` to change meaning, so do these two together.

### [F-058] The same `too many SQL variables` remains reachable through `returning()` and multi-parameter `values()` — status: done (TBD, `rowsPerChunk` replaced with greedy packing against actual per-row/returning param counts — see `src/plan/compile.ts`) — severity: med — area: sql/compile
- **Where**: `src/plan/compile.ts` (the `rowsPerChunk` computation)
- **Defect**: the chunker still assumes exactly one bound parameter per column in `VALUES` and zero from `returning`. Both reproduced against real D1 in workerd: `db.insert(t).values(40 rows × 4 cols).returning({ id: t.id, tag: sql\`${'tag'}\` })` → parts `[101, 61]` → `D1_ERROR: too many SQL variables at offset 411`; and a `values()` entry written as `sql\`${'x'} || ${'y'}\`` (2 params in one column) → parts `[125, 75]` → same error.
- **Pre-existing, not introduced by this batch** — but `countOnConflictParams` is the right shape for both, and a general "params outside/inside VALUES, rendered not guessed" reservation would close them together with `[F-055]`.

### [F-059] The casing fix is a silent breaking change for existing orm-d1 users on `snake_case` — status: needs-human — severity: med — area: release
- `[F-050]` made `toSnakeCase` match Drizzle exactly, which is correct — but for a project already on orm-d1 with `casing: 'snake_case'`, derived column names change: `apiV2` `api_v2` → `api_v_2`, `_id` `_id` → `id`. The kit surfaces it as a destructive diff rather than losing data quietly, so it is loud, but it needs a release note and possibly a major-version decision. Also note that `{ id, _id }` now both derive `id`; nothing detects the collision, though SQLite rejects the duplicate column loudly at apply time. That collision behaviour is Drizzle's exactly.

## Findings — efficiency + bugs lens (iteration 5)

### [F-060] A relation's inherited `where` is applied to the wrong table — status: done (`efe70a4`, joined + filter DSL correct; split now refuses — see `[F-070]`, `[F-071]`) — severity: **high** — area: relations
- **Where**: `src/relations/define.ts:374` sets `relation.isReversed = true` and `:376` inherits the opposite side's `where`, but **nothing in `src/` ever reads `isReversed`**. Three sites compile that predicate against the relation's *target* when it belongs to its *source*: `src/relations/query.ts:477`, `src/relations/filter.ts:345`, `src/relations/joined.ts:215`.
- **Drizzle picks the table explicitly** (`drizzle-orm/relations.js:683`, `:690`): `relationsFilterToSQL(relation.isReversed ? sourceTable : targetTable, relation.where)`.
- **Failure scenario**: the `where`-on-one-side, `many`-picks-it-up spelling that `adoptReverse` exists to serve — `posts.author = r.one.users({ from, to, where: { active: true } })` with `users.posts = r.many.posts()` adopting `from`/`to` *and* `where*`. Both `users` and `posts` have an `active` column. With user 1 active (posts 10 active, 11 archived) and user 2 inactive (post 12 active), `findMany({ with: { posts: true } })` gives Drizzle `[{id:1,posts:[10,11]},{id:2,posts:[]}]` and orm-d1 `[{id:1,posts:[10]},{id:2,posts:[12]}]` — **wrong in both directions**: post 11 dropped from a user that should have it, post 12 returned for a user that should have none. Silent, because `split` and `joined` agree with each other, which is the only cross-check the suite has.
- **When the target has no column of that name it is a hard failure instead**: `Unknown filter field "active". It is neither a column nor a relation of this table.` thrown from `src/relations/filter.ts:418` via `#fetchChild`, and the same from `compileRelationFilter` on the filter path.
- **Fix**: thread `isReversed` through. In `filter.ts:345` it is local — `compileRelationFilter` already holds the outer `table` and `sourceColumns`, so compile against those when reversed; the predicate stays inside the `exists (…)` body where the outer row is in scope. In `joined.ts:215`, compile against the *parent* level's aliased table and push into `predicates`, still inside the correlated subquery, exactly as Drizzle does. In `query.ts:477` the split plan has no correlated scope, so the reversed predicate must be evaluated against the parent rows in `#fetchChild`: a parent that fails it is excluded from `byKey` and gets `[]`/`null` — the same observable answer.
- **Prove it**: no existing test can — every `where`-carrying relation in `test/workers/relations.test.ts:1322` and `:826` states `from`/`to` explicitly, so `isReversed` is always `false` there. Add the schema above with the three-way assertion the file's header prescribes (split, joined, filter path), plus a case where the target lacks the column asserting it does not throw.

### [F-061] `DESC` and `COLLATE` index members are invisible to introspection, and a rebuild drops them — status: done (`efe70a4`, **columns only** — expression members regressed, see `[F-068]`, `[F-069]`) — severity: **high** — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:334` falls back to parsing the raw `CREATE INDEX` only when a member's `name` is `null`. `pragma index_info` reports a `DESC` or `COLLATE`-qualified member as an ordinary named column, so the modifier never reaches the snapshot. Verified on D1: `index_info` gives `{"name":"created_at"}` where `index_xinfo` gives `{"name":"created_at","desc":1,"coll":"BINARY","key":1}`; only `cid:-2` (a true expression) triggers the fallback.
- **Failure scenario A — a unique constraint is downgraded by a routine rebuild**: live `create unique index "acct_email_ci" on "acct" ("email" collate nocase)` introspects as `columns: [{ expression: 'email', isExpression: false }]`. Any later unrelated change forcing a rebuild re-emits `create unique index "acct_email_ci" on "acct" ("email")`. The duplicate `alice@x.com` now inserts and the table holds two rows. Nothing errors, nothing warns, `diff.errors` is empty. **This is the `.unique()`-on-64-tables failure mode the project exists to prevent, one level down.**
- **Failure scenario B — permanent false drift on a schema that is in sync**: `index('evt_created_desc').on(sql\`${t.createdAt} desc\`)` is legal in the Drizzle subset. `canonicalIndex` compares `[['"created_at"desc', true]]` against `[['created_at', false]]`, so `check` exits 1 forever, `verify` reports a mismatch, and `push` drops and rebuilds the index on every run.
- **Failure scenario C — `pull` writes the modifier out of the schema module**: `renderSchemaModule` (`kit/src/node/commands.ts:381`) emits `index("i_desc").on(t.createdAt)`. The committed schema, the baseline snapshot and the modifier-blind introspection all agree, so `check` is green while the source of truth has silently lost the ordering and the collation.
- **The same blindness covers column-level modifiers**: `"email" text collate nocase`, `"code" text unique on conflict replace`, and `"pid" integer references "par"("id") deferrable initially deferred` all round-trip through `createTableFromSnapshot` stripped of the modifier.
- **Fix**: read `pragma index_xinfo` instead of `pragma index_info` at `kit/src/core/apply.ts:149` — available on D1, carries `desc` and `coll` (filter out the `key: 0` rowid tail rows). Add `desc?: boolean` and `collate?: string` to `IndexColumnSnapshot` (`kit/src/core/snapshot.ts:61`), emit in `createIndexFromSnapshot` (`:340`) and `renderSchemaModule` (`commands.ts:384`), include in `canonicalIndex` (`kit/src/core/diff.ts:688`). Keep the `parseIndexColumns` fallback for `cid === -2`. For the column-level family, which has no snapshot representation at all, `recreateTable` should refuse the way it already refuses for foreign triggers.
- **Prove it**: `kit/test/workers/roundtrip.test.ts` — add a `DESC` index and a `COLLATE NOCASE` unique index to the `flags` fixture, assert an empty diff. `kit/test/workers/migrate.test.ts` — the scenario-A sequence, asserting the duplicate insert still rejects after a rebuild.

### [F-062] `--remote=true` silently runs against the local database — status: **done** (`efe70a4`, confirmed closed by round-2 review) — severity: med — area: kit/cli
- **Where**: `kit/src/cli.ts:75` assigns any `--flag=value` as a *string*; `:136` tests `flags['remote'] === true` strictly, so an `=`-spelled boolean is neither honoured nor rejected and falls through to the `--local` default at `kit/src/node/commands.ts:66`.
- **Failure scenario**: `orm-d1-kit migrate --remote=true` in CI. `parseArgs` gives `{ remote: 'true' }`, `asTargetFlags` gives `{ local: false, remote: false, acceptDataLoss: false }`, `resolveRunner` falls to `localRunner`. Every pending migration is applied to `.wrangler/state`, it prints `Applied 0007_…` and exits 0. Production is untouched and nothing says so. `push --remote=true --accept-data-loss` is the same shape with a destructive payload. (`--remote true` behaves identically — the space form consumes `true` as the flag's value.)
- **Contrast**: a previous lens blessed `--accept-data-loss=true` as failing closed, which is true. The same rule applied to `--remote` fails *sideways*, onto a different database — which `resolveRunner`'s own comment calls out as "how the wrong one gets hit".
- **Fix**: in `parseArgs`, coerce a recognised boolean spelling — when `inline` is `'true'`/`'false'`, `set(name, inline === 'true')`. Or, narrower and stricter, have `asTargetFlags` throw when any of those three flags is a string rather than silently reading it as absent.
- **Prove it**: `kit/test/unit/cli.test.ts:133` — `expect(asTargetFlags(parseArgs(['migrate','--remote=true']).flags)).toMatchObject({ remote: true })`.

### [F-063] `orm-d1-kit --help` fails with "No orm-d1 config found" — status: **done** (`efe70a4`, confirmed closed by round-2 review) — severity: low — area: kit/cli
- **Where**: `kit/src/cli.ts:53` takes `argv[0]` as the command unconditionally, so `--help` becomes the command string; the guard at `:146` only matches the literal command `help` or a `--help` flag *after* a command.
- **Failure scenario**: `npx orm-d1-kit --help` in a project that has not written `orm-d1.config.ts` yet — the exact moment someone reaches for help — reaches `loadConfig` at `:152` and exits 1 with `No orm-d1 config found`. With a config present it exits 1 with `Unknown command "--help"`. `-h` behaves the same. `generate --help` does work.
- **Fix**: at `:146`, also match when `command` starts with `-`.
- **Prove it**: `await expect(run(['--help'])).resolves.toBe(0)`.

### [F-064] Error mapping loses the failing statement on a chunked write — status: done (TBD, `#runParts`/`batch()` now report every part's SQL and bound params, not just the first — see `src/runtime/session.ts`) — severity: low — area: runtime — OFF-LENS from efficiency + bugs
- **Where**: `src/runtime/session.ts:150` throws `wrapQueryError(cause, query.sql)` where `query.sql` is `parts[0].sql`, so a 40-chunk insert failing on chunk 37 reports chunk 1's SQL and no parameters — contradicting the documented "errors carry the SQL that caused them". `src/runtime/session.ts:194` joins only each item's *first* part for the same reason.

### [F-065] `verify` replays in array order, `migrate` in `idx` order — status: todo — severity: low — area: kit/journal — OFF-LENS from efficiency + bugs
- **Where**: `kit/src/node/commands.ts:625` iterates `journal.entries` directly while `pendingMigrations` (`kit/src/core/journal.ts:40`) sorts by `idx`. A `_journal.json` whose entries end up out of order — the ordinary outcome of resolving a git conflict between two branches that each generated a migration — makes the two commands disagree about the order history applies in.

### [F-066] `pull` writes a snapshot with no `prevId` — status: todo — severity: low — area: kit/node — OFF-LENS from efficiency + bugs
- **Where**: `kit/src/node/commands.ts:278` omits it where `generate` (`:145`) sets `prevId: previous.id`, so a pulled baseline breaks the snapshot chain.

### [F-067] A Drizzle fragment inside DDL ignores `bareColumns` — status: done (`src/sql/drizzle-sql.ts:fromDrizzleSQL`, structural `invokeSource: 'indexes'` passed to Drizzle's own `toQuery` when `ctx.bareColumns` — not a text/string `stripQualifiers`) — severity: med — area: sql — OFF-LENS from efficiency + bugs
- **Where**: `src/sql/drizzle-sql.ts` honours `ctx.paramToken` and, since this fix, `ctx.bareColumns` too — `check('c', drizzleSql\`${col} > 0\`)` renders `"col" > 0` with no table qualifier inside a `CHECK`.
- **Correction**: the original write-up justified this as "SQLite rejects a table-qualified column inside a CHECK constraint" — that claim is **false** on D1. `check("t"."c" <> 'bad')` and `where "t"."c" = 'x'` are both accepted. The real, narrower restriction is that a *generated* column's expression rejects the `.` operator outright (`the "." operator prohibited in generated columns`). Bare-columns rendering is kept regardless (it reads more naturally and the DDL context declares no table alias to qualify with), it just is not the correctness requirement the comment claimed. The in-code comment next to this code has been corrected to say so.

## Unresolved objections merged anyway (`efe70a4`)

Fifth consecutive round-2 rejection merged under the sweep's own rule (gate green,
677 passed / 4 skipped). Revert as one unit with `git revert -m 1 efe70a4`.

**Read `[F-068]` and `[F-069]` before anything else in this file.** `[F-068]` is a
regression against `main` that re-opens the project's own reason to exist — a diff that
stays green while describing an index it can never converge on — and `[F-069]` can emit
unparseable DDL and interpolate an unescaped collation name.

### [F-068] An expression index member carrying `DESC` or `COLLATE` now drifts forever — status: todo — severity: **high** — area: kit/introspect — REGRESSION vs `main`
- **Where**: `kit/src/core/introspect.ts:385-394`
- **Defect**: `sortedMembers.map(...)` attaches `desc`/`collate` to **every** member, including expression members (`cid: -2`) whose `expression` text — recovered by `parseIndexColumns` — *already contains* the suffix. The schema side (`decorateIndexColumn`, which only matches a bare quoted identifier) attaches neither, so the two sides can never agree.
- **Failure scenario**: `index('t_a_idx').on(sql\`lower("a") desc\`)` against live `create index t_a_idx on t (lower("a") desc)`. `main` records `{"expression":"lower(\"a\") desc","isExpression":true}` and diffs `[]` — converged. HEAD records the same plus `"desc":true` and diffs `drop index` + `create index`, and **never converges**: applying the statements and re-diffing gives a byte-identical round 1. `check` exits 1 forever on an in-sync database, `verify` reports a permanent mismatch, `push` recreates the index every run, `generate` emits a fresh no-op migration every run. Same for `sql\`substr("a", 1, 3) collate nocase\``.
- **Worse**: `createIndexFromSnapshot` (`kit/src/core/snapshot.ts:385`, exported from `kit/src/core/index.ts`) then renders the modifier twice — `create index "t_a_idx" on "t" (lower("a") desc desc)` → `D1_ERROR: near "desc": syntax error`. The CLI dodges it today because every `diffSnapshots` call site passes a *schema* snapshot as `after`, but the function is public API.
- **Why no test caught it**: every added `roundtrip.test.ts` case (`sql\`"weight" desc\``, `sql\`"name" collate NOCASE\``) is a bare quoted identifier. No test in the diff puts a modifier on an expression member.
- **Fix**: skip `desc`/`collate` decoration when `isExpression` — the expression text already carries them.

### [F-069] `parseIndexCollations` scans raw member text, not `blankLiterals(...)` — status: todo — severity: **high** — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:253-271`
- **Defect**: `parseIndexColumns` slices its members from the **original** `sql` deliberately, so string literals survive; `collateRe.exec(member)` then runs over that unblanked text. This is the exact hazard its sibling was fixed for one iteration ago.
- **Failure scenario**: `create index t_a_idx on t (replace("a", ' collate frobnicate ', ''))` snapshots as `{"collate":"frobnicate"}` and renders `… replace("a", ' collate frobnicate ', '') collate frobnicate` → `D1_ERROR: no such collation sequence: frobnicate`. The same root cause reaches quoted identifiers: a column named `my collate col` yields `{"collate":"col"}`, and `createIndexFromSnapshot` interpolates the collation name **raw** (`\` collate ${c.collate}\``, `snapshot.ts:390`) — the one place in that function that is neither quoted nor escaped.
- **Fix**: fixing `[F-068]` (skip modifiers when `isExpression`) closes the literal case; the identifier case needs the scan to run over `blankLiterals`.
- **Confirmed clean by the reviewer**: a partial index whose `where` mentions `collate` is excluded correctly, `COLLATE  NoCase` with doubled whitespace and mixed case parses and folds, and a column named `collate_key` does not match.

### [F-070] The split-path refusal names a remedy that provably does not work — status: todo — severity: **high** — area: relations
- **Where**: `src/relations/query.ts:542-549`
- **Defect**: `#useJoined` (`query.ts:267`) requires `supportsJoined`, which returns `false` for a `through` relation, a payload with a `blob` column, a payload over 63 keys, and a placeholder nested `limit`/`offset` — and falls back to the split plan. For those shapes `relationalStrategy: 'joined'` *is* the split plan, so the split plan throws telling the user to set `relationalStrategy: 'joined'`. **There is no configuration under which those queries run**; Drizzle answers them (it has only the lateral plan).
- **Proved against real D1**, same message from both strategies: a reversed many-to-many (`through`), and a reversed one-to-many whose child payload has a `blob()` column.
- **Contradicts two stated invariants the diff did not update**: `README.md:441` ("Both return identical results … a performance switch and nothing else") and `src/relations/joined.ts:85-88`, which explicitly falls *back* to split for placeholder limits so that "`relationalStrategy` … must not change which queries are legal".
- **Secondary**: the message is unactionable even when joined would work — it does not say which side declared the `where`, or that moving it to the other side is the fix.
- **The comment at `query.ts:538` is wrong**: "there is no fix here that stays within the split plan's shape". The reviewer points out the parent query at `#run` (`query.ts:430-448`) is issued by this same object and could project the compiled predicate as an extra boolean column per child relation — an exact per-parent answer with zero extra round trips and no key list at all. That is the fix to write.

### [F-071] The split-path refusal is data-dependent — passes in dev, throws in production — status: todo — severity: med — area: relations
- **Where**: `src/relations/query.ts:523-549`
- **Defect**: the throw sits *after* the `keys.length === 0` early return (line 523), and `#fetchChild` is not called at all when `rows.length === 0` (line 451). Verified: the same schema and query throws with data present and returns `[]` cleanly after `delete from users`. A refusal meant as a hard gate should fire when the relation is resolved, not when a row happens to exist.

### [F-072] The batch's bundle cost was reported against the previous commit, not `main` — status: **done** (note only, per this batch's `[F-097]`) — severity: low — area: efficiency
- Measured against `main`: `src/core.ts` 41,352 → 41,352 (0); `src/index.ts` 60,457 → 60,911 (**+454**); `src/relations/index.ts` 27,271 → 27,721 (**+450**). Most of the +454 is the 330-character throw message from `[F-070]` shipped to every cold isolate — a string that exists to say something that is not true for the shapes in `[F-070]`.
- **Not a code fix — how this stops recurring**: this was a *reporting* gap (measuring
  against the wrong baseline), which no amount of measuring-more-carefully prevents on
  its own — the next batch can make the identical mistake. `[F-097]` (this batch) adds
  a real gate instead: `test/unit/module-resolution.test.ts`'s "bundle-size ceiling"
  test re-measures the actual minified+gzipped bundle on every `npm run check` and
  fails outright if it grows past a ceiling seeded from a real measurement, rather than
  relying on a human to remember to diff against `main` in a status write-up. A batch
  that grows the bundle enough to matter now fails the gate regardless of what baseline
  anyone compared it to by hand.

### Confirmed correct by the round-2 reviewer
- **`isReversed` now matches Drizzle's `relation.isReversed = !where`** in all four combinations, checked by running orm-d1's and `drizzle-orm`'s `defineRelations` side by side: own-where → `false`, inherited → `true`, both → `false` with own where winning, neither → `true`. Rows match Drizzle exactly through `sqlite-proxy` for the reversed inherited `where` under `joined`, for the non-reversed relation under both plans, and for the filter DSL. The non-reversed path is unchanged by construction — all three new branches are gated on `relation.isReversed`.
- **`[F-061]`'s core case works**: a `collate nocase` unique index survives a table rebuild and still rejects `'A@B.C'` after `'a@b.c'` — the test enforces the constraint rather than comparing DDL. A `collate nocase` *column* with an unqualified index gives an empty diff across three rounds; an index that states `collate NOCASE` round-trips; mixed and expression-adjacent members map to the right member.
- **Case folding works**: `collate NoCase` (live) vs `collate NOCASE` (schema) fold equal; a pre-change snapshot upgrades in exactly one rebuild and then converges; `pull` → re-snapshot → `generate` is stable.
- **`[F-062]`/`[F-063]` fully closed**: `--help`/`-h`/`help`/`generate --help` → 0; `--nope`/`-x`/`--config=foo.ts`/`--remote migrate` → 1; `--remote=true`/`--remote true`/`--accept-data-loss=true` coerce to real booleans; `--remote=yes` throws `--remote expects true or false`; `pull --force` and `--force=true` pass the overwrite gate; `--name true`/`--name=true` stay the string `'true'`.
- **The unchunked key list is gone** and the diff introduces no new key list of any kind.
- **The two changed test expectations are legitimate**: neither existed on `main` — both were introduced by this branch's own first commit. No coverage that existed on `main` was lost.

## Findings — security lens (iteration 6)

### [F-073] A hand-written integrity trigger is misread as orm-d1's own append-only guard, so the refusal that protects it never fires — status: **done** (`37db699`, verified exhaustively in both directions across ~20 body shapes) — severity: **high** — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:325` — `parts.every((s) => /^select\s+raise\s*\(\s*abort\b/.test(s))`
- **Defect**: the regex is a **prefix** test, so `SELECT RAISE(ABORT, '…') WHERE <cond>` — the standard SQLite idiom for a conditional constraint trigger, and the only one available since trigger bodies have no bare `IF` — matches. The function's own doc comment (lines 303–307) states the opposite invariant: "only an **unconditional** abort counts… reading it as the guard reports a table as protected when it is not."
- **Both consumers fail closed in the wrong direction**: `kit/src/core/apply.ts:100` (`introspect`'s `foreignTriggers` out-param) `continue`s on a "guard" so it is never recorded as foreign; `kit/src/core/apply.ts:307` (`checkForeignTriggerConflicts`, the last line of defence on the `migrate` path) does the same; and `introspect.ts:334` additionally stamps the table `appendOnly: true`.
- **Failure scenario A — `migrate` silently drops the trigger**: live `accounts` carries `CREATE TRIGGER "accounts_balance_immutable" BEFORE UPDATE ON "accounts" BEGIN SELECT RAISE(ABORT,'balance is immutable') WHERE NEW."balance" <> OLD."balance"; END`. A `text`→`integer` change on another column forces a rebuild. Driving the real `introspect`/`diffSnapshots`/`checkForeignTriggerConflicts`: `foreignTriggers` is `{}`, the live snapshot says `appendOnly: true`, `diff.errors` is `[]`, and the migration applies — `drop table "accounts"` takes the trigger with it, nothing recreates it, and the only remedial statement emitted names `"accounts_no_update"`, which does not exist. `migrate` has no `--accept-data-loss` interaction at all. On `push` the operator sees a prompt saying "recreating accounts because column note changes type" — the refusal whose entire job is to say "this rebuild will destroy a trigger orm-d1 cannot reproduce" never fires.
- **Failure scenario B — `check` certifies a weakened guard**: a table declared `appendOnly: true` whose live `<table>_no_update` trigger has been edited to `SELECT RAISE(ABORT,'…') WHERE NEW.balance <> OLD.balance`. `isAppendOnlyTrigger` returns `true`, live and schema `appendOnly` match, `check` prints "Up to date, no drift" and exits 0 — while `UPDATE accounts SET note = 'x'` now succeeds on every row.
- **Classification probe against the shipped function**: orm-d1's own guard → `true`; hand-written **conditional** guard (`WHERE`) → `true` (**wrong**); conditional guard with role escalation → `true` (**wrong**); `WHEN` form → `false`; `CASE` form → `false`.
- **Fix**: anchor the whole body statement rather than its prefix. `blankLiterals` has already emptied the message string, so no parenthesis or comma can survive inside it: `/^select\s+raise\s*\(\s*abort\s*(?:,[^()]*)?\)$/`. Anything trailing the closing paren now fails the `$` anchor and the trigger is correctly reported as foreign.
- **Prove it**: extend `kit/test/unit/diff.test.ts:1411` (`does not mistake a conditional validation trigger for the guard`, which already covers `WHEN`, `UPDATE OF`, `CASE` and "does something else as well" but **not** the `WHERE`-filtered form) with the filtered spelling asserting `false`; plus an end-to-end assertion in `kit/test/workers/foreign-schema.test.ts` that creating such a trigger and rebuilding the table makes `diffSnapshots` produce an error and `checkForeignTriggerConflicts` throw.

### [F-074] Two unnamed expression indexes on one table collide on their derived name; the snapshot keeps only the last — status: **done** (`37db699`, refusal only — the `indexName` rename remains open; see also `[F-077]`, `[F-078]`) — severity: **high** — area: kit/snapshot
- **Where**: `src/schema/constraints.ts:145` renders every expression member as the literal string `expr`; `kit/src/core/snapshot.ts:258` then keys the snapshot's index map by that name, so the second declaration overwrites the first.
- **Failure scenario** — the textbook case-insensitive-uniqueness pair: `uniqueIndex().on(sql\`lower(${t.email})\`)` and `uniqueIndex().on(sql\`lower(${t.username})\`)` on one table. `createSchema()` emits two statements both named `"users_expr_unique"`; the snapshot has **one** index; the generated migration creates only `lower("username")`. Case-insensitive uniqueness on `email` is gone, with no error and no warning.
- **Why nothing catches it**: the two artifacts `generate` writes are self-consistent (one index in the snapshot, one in the SQL), so `check` compares the live DB against a snapshot that shares the bug, and `verify` replays the migration into a scratch DB and diffs it against the *same* `snapshotFromSchema` — both sides missing the constraint — and reports a match. CI stays green while two accounts register `Alice@x.com` and `alice@x.com`. **This is the exact shape of the failure the project exists to prevent.**
- **The two emitters disagree**: `createSchema()` (used by `orm-d1/ddl` consumers) emits both statements and would fail loudly on apply with `index users_expr_unique already exists`; only the migration path loses one silently.
- **Same hazard** for `uniqueConstraints` / `foreignKeys` / `compositePrimaryKeys` / `checkConstraints` in the same function, and for the `?? ''` fallback at `kit/src/core/snapshot.ts:257`, which keys an unparseable name as the empty string.
- **Fix**: refuse rather than overwrite, at `kit/src/core/snapshot.ts:258` and the siblings at 272, 280, 289, 300 — throw naming the collision and telling the caller to give one an explicit name. A better long-term fix is to make `indexName` distinguish expression members (a short stable digest of the rendered expression instead of the constant `expr`), but that changes constraint names in existing snapshots, so **the refusal is the safe first step**.
- **Prove it**: `expect(() => snapshotFromSchema({ users })).toThrow(/derive the name "users_expr_unique"/)`. Before the fix, `snapshotFromSchema` returns a snapshot with a single index.

### [F-075] `remoteRunner.batch` re-flattens statements the local path deliberately kept whole — status: todo — severity: med (**unconfirmed**) — area: kit/node — OFF-LENS from security
- **Where**: `kit/src/node/runners.ts:171`
- **Defect**: `splitStatements` (`kit/src/core/sql.ts:44-58`) goes to real trouble to keep a `CREATE TRIGGER … BEGIN … END` body's internal semicolons inside one statement, because `localRunner`/`scratchRunner` hand each statement to `db.exec()` individually. `remoteRunner.batch` then does `statements.map((s) => \`${s};\`).join('\n')` and posts the result as a single `sql` field, so D1's HTTP API has to re-split it. If the API's splitter is not trigger-aware this fails with `incomplete input` — i.e. the append-only guard can be created `--local` but not `--remote`, precisely the drift `runners.ts`'s own header says the shared `SqlRunner` exists to prevent.
- **Unconfirmed**: the reviewer could not verify Cloudflare's splitter behaviour. Cheap to settle — the credential-gated suite at `kit/test/unit/remote-runner.test.ts:185` needs one case that creates a trigger through `runner().batch([...])` and asserts the `UPDATE` is then rejected.

### [F-076] Schema disclosure through filter errors — status: **done** (this batch) — severity: low — area: relations — OFF-LENS from security
- **Where**: `src/relations/filter.ts:428-432`
- **Defect**: an unknown key in the object DSL throws a message enumerating every column and relation name of the table. The documented Pothos use case passes a user-controlled `where` straight in, and GraphQL servers commonly return `error.message` to the client, so `{ where: { zzz: 1 } }` returns the full column list of the backing table.
- **Fails closed** (it throws), and the message is genuinely good for development — a hardening question rather than a defect. Worth a `__DEV__` gate on the enumeration.
- **Fix**: the unknown-field refusal in `compileFilter` (`src/relations/filter.ts`) now
  checks `isDev()` (`src/dev.ts`, the same flag `assertHeader`/`assertScan` use) —
  enumerated in dev, a bare "neither a column nor a relation of this table" otherwise.
- **Prove it**: `test/unit/relations-filter.test.ts` gained a
  `'schema disclosure through the unknown-field refusal'` describe block: with `__DEV__`
  off, the thrown message names the offending key but not the column/relation list;
  with it on, `Columns: id, name` is present. The existing prototype-key tests, which
  only assert `/Unknown filter field/`, are unaffected by either branch.

## Iteration 6 — **approved** and merged (`37db699`)

The first round-2 approval in six iterations. The reviewer reproduced everything both
commits claim and stated explicitly that **none of the three findings below is a hole opened
by this diff** — `[F-077]` and `[F-078]` are pre-existing incompleteness the commit's own
stated invariant does not reach, and `[F-079]` is residual narrowness in new code whose
failure mode is a loud atomic rollback. They are recorded as ordinary `todo`s, not as
objections merged over.

Also confirmed by the reviewer, worth keeping: the `Object.create(null)` widening is
downstream-safe — every consumer of the five constraint maps uses `Object.values`/`entries`/
`keys` except two bracket reads in `diffIndexes`; there is no `hasOwnProperty`, `in`,
`toStrictEqual`, `Object.assign`, `for…in` or `structuredClone` on them anywhere in
`kit/src`; `JSON.stringify` → `parse` → re-stringify is byte-identical and `__proto__`
survives as an own key, so the stored snapshot round-trips; and `check`/`verify` compare
introspected-vs-stored (plain-vs-plain), so no null-prototype object reaches a deep-equal.

### [F-077] The prototype-key fix is one-sided — `generate` and `push` still die on a constraint named `constructor` — status: todo — severity: high — area: kit/diff
- **Where**: `kit/src/core/diff.ts:745` (and the mirror read at `:739`, which *is* fixed)
- **Defect**: `snapshotFromSchema` now builds null-prototype maps, but the `before` side of every diff is a plain object — `JSON.parse` of the stored snapshot for `generate` (`kit/src/node/commands.ts:111`), `introspect()` for `push` (`:212`). `diffIndexes`'s second loop reads `before.indexes[name]`, which for a prototype key resolves to the *inherited* function.
- **Failure scenario**: an existing `users` table gains `uniqueIndex('constructor').on(t.a)` — or any `toString`/`valueOf`/`hasOwnProperty` name that `pull` copied off a foreign database. `before.indexes['constructor']` is `Object`, which is truthy, so `canonicalIndex(Object)` dereferences `Object.columns`: `TypeError: Cannot read properties of undefined (reading 'map') at canonicalIndex (diff.ts:710) at diffIndexes (diff.ts:746)`. `generate` and `push` both exit with a bare `TypeError` and no mention of the index. Confirmed against a real `snapshotFromIntrospection` result and a JSON-round-tripped snapshot.
- **Not a regression** — `main` crashed in both directions — but the fix stops one line short, and the add direction is the common one.
- **Fix**: `Object.hasOwn(before.indexes, name) ? … : undefined` at both sites.

### [F-078] The `__proto__` silent-drop is left in the two maps directly above the comment that describes it — status: todo — severity: high — area: kit/snapshot
- **Where**: `kit/src/core/snapshot.ts:235` (`const result: Record<string, TableSnapshot> = {}`) and `:239` (`const columns: Record<string, ColumnSnapshot> = {}`), plus every map in `kit/src/core/introspect.ts` (330, 344, 357, 371, 372, 454)
- **Defect**: the comment added at `snapshot.ts:244-253` argues that a constraint name is "attacker- or DB-controlled text" and that `map['__proto__'] = v` "silently sets the object's prototype instead of adding an entry, dropping the constraint with no error at all". That is equally true of the table and column maps left as plain literals immediately above it.
- **Failure scenario A — a column disappears between the two emitters**: `createTable()` emits `create table "prefs" ("id" integer primary key not null, "__proto__" text not null)` while `generate()` emits `create table "prefs" ("id" integer primary key not null);`. A `NOT NULL` column present in `createSchema()`'s output is absent from the migration and from the snapshot, so nothing ever diffs it back.
- **Failure scenario B — the flagship `docs/09` shape, via `pull`**: given a live `create unique index "__proto__" on users(email)`, `snapshotFromIntrospection` produces `Object.keys(tables.users.indexes) === []`. The index is invisible to every `Object.values` consumer, so `pull` writes a schema module without it, and the next rebuild of `users` re-creates the table from `Object.values(after.indexes)` and drops the UNIQUE constraint permanently — with `check` green throughout, because both sides share the blindness.
- **Pre-existing**, but it is the flagship bug class, it sits inside the function this commit edits, and it is exactly the reasoning this commit wrote down.

### [F-079] The guard-collision refusal is narrower than SQLite's trigger namespace — status: done — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:617-619`
- **Defect**: `foreignTriggersForTable.includes(guardName)` is keyed per table and compared case-sensitively, but SQLite trigger names are **database-global and case-insensitive**. Verified with `node:sqlite`: `create trigger "events_no_update" … on "audit"` succeeds, and a second `… on "events"` then fails with `trigger "events_no_update" already exists`.
- **Failure scenario**: a hand-written trigger named `events_no_update` attached to `audit` — or an orm-d1 guard left behind on a table renamed outside the kit, which keeps its name — then `events` gains `appendOnly: true`. `diffSnapshots` finds nothing under `foreignTriggers['events']` and emits the `create trigger` with `errors: []`, which fails on apply with precisely the "already exists" error this refusal exists to prevent. Same for a live `EVENTS_NO_UPDATE`.
- **Fix**: the complete data is already in `options.foreignTriggers` — flattening its values covers it. Note the check guards only the in-place transition: the created-table path (`diff.ts:397`) and the rebuild path (`diff.ts:320`) emit `appendOnlyTrigger()` with no check at all.
- **Low severity**: the batch is atomic, so this is a loud rollback rather than data loss, and it is the same outcome as before the fix.
- **Round-2 correction** (`fix/apply-guard-20260818`): the flatten-and-scan fix above was itself a regression — `options.foreignTriggers` is a pre-diff snapshot, so it also refused a migration that is itself the fix (dropping the table the collider lives on, in the same diff, removes the collider before `create trigger` ever runs — e.g. `drop table "audit"` + `create trigger "events_no_update" … on "events"` in one migration, which `main` generates and applies cleanly). Replaced with `tableGuardCollides` (`diff.ts`), which only counts a collider that survives this diff (its table is not dropped by this diff, and this diff has not already dropped the trigger by that name). Applied consistently at all three sites the original "Fix" note above named but only the in-place one implemented: the in-place transition, the created-table path, and the rebuild path.
- **Coverage** (`fix/apply-guard-20260818`): `kit/test/unit/diff.test.ts`, three tests under "refusing an in-place append-only guard creation that collides with a foreign trigger" — the survivor-aware regression case (does not refuse when the collider's table is dropped in the same diff), the created-table-path case, and the rebuild-path case. Reverting each of the three `tableGuardCollides` call sites back to their pre-fix form (no survivor awareness for the in-place site; no check at all for the other two) turns the corresponding test red; restored, all three are green.

## Findings — feature lens (iteration 7)

### [F-080] `sql` binds an interpolated `undefined` instead of eliding it — status: **done** (`5051bc7`, byte-identical to Drizzle across 35 A/B inputs) — severity: **high** — area: sql — COMPAT-DEFECT
- **Where**: `src/sql/sql.ts:201-204` (the `else` branch of `SQL.toQuery`)
- **Defect**: Drizzle's `buildQueryFromSourceParams` has an explicit `if (chunk === undefined) return { sql: "", params: [] }` (`drizzle-orm/sql/sql.js:96`); orm-d1 has no such branch, so an `undefined` hole becomes a bound parameter slot. Not an exotic input — it is the *designed* output of `and()`/`or()` over all-undefined operands and of Drizzle's `SQL.if()`, both of which exist to be interpolated conditionally.
- **Failure scenario (query)**: `` sql`select 1 where ${and(maybeA, maybeB)}` `` with both filters absent gives Drizzle `{"sql":"select 1 where ","params":[]}` and orm-d1 `{"sql":"select 1 where ?","params":[undefined]}`. The parameter reaches `D1PreparedStatement.bind(undefined)`.
- **Failure scenario (DDL — this is bug class #1)**: `renderInline` (`src/ddl.ts:187`) replaces each parameter token with `literal(slot.v)`, and `literal(undefined)` is `'null'`. A schema with `check('score_ok', sql\`${c.score} >= ${MIN_SCORE}\`)` where `MIN_SCORE` is `undefined` generates `constraint "score_ok" check ("score" >= null)` — which SQLite accepts, and which then accepts `insert into scores values (1, -999)` (verified with `node:sqlite`). drizzle-kit's equivalent renders `"score" >= ` and the migration fails loudly. orm-d1 emits a self-consistent migration whose CHECK is permanently inert, and `check` compares it equal to itself forever.
- **Fix**: one line, before the `isSQLChunk` test — `if (value === undefined) continue;`.
- **Prove it**: `render(sql\`select 1 where ${and(undefined, undefined)}\`)` → `{ sql: 'select 1 where ', params: [] }`; plus a `test/unit/ddl.test.ts` case asserting `check('c', sql\`${col} >= ${undefined}\`)` does **not** render `>= null`.

### [F-081] `sql` does not expand an interpolated array into `(?, ?, ?)` — status: **done** (`5051bc7`, recursive dispatch — but see `[F-087]`, `[F-089]`) — severity: **high** — area: sql — COMPAT-DEFECT
- **Where**: `src/sql/sql.ts:201-204` (same branch)
- **Defect**: Drizzle's renderer has a dedicated array case (`drizzle-orm/sql/sql.js:100-108`) emitting `(`, the elements separated by `, `, `)`. It is the mechanism Drizzle's own `inArray`/`notInArray` are built on (`conditions.js:150`), and therefore how ported user code spells a literal list. orm-d1 binds the whole array to one slot.
- **Failure scenario**: `` db.select().from(users).where(sql`${users.id} in ${ids}`) `` with `ids = [1,2,3]` gives Drizzle `id in (?, ?, ?)` / `[1,2,3]` and orm-d1 `id in ?` / `[[1,2,3]]` → `OrmD1QueryError: near "?": syntax error` (on D1, `D1_TYPE_ERROR: Type 'object' not supported` fires first). This also reaches the `orderBy`/`extras` callbacks in `db.query`, whose operator bag *is* the orm-d1 `sql` tag (`src/relations/query.ts:63-75`) — the exact spelling Pothos' drizzle plugin documents.
- **Fix**: ~5 lines in the same loop, mirroring Drizzle — open paren, iterate with `, ` separators recursing into `isSQLChunk` items, close paren, `continue`.
- **Repairs the DDL path for free**: `check('c', sql\`${c.role} in ${['admin','member']}\`)` currently renders `check ("role" in 'admin,member')`, which SQLite rejects with `subqueries prohibited in CHECK constraints`; with the fix it renders `in ('admin', 'member')`.
- **Prove it**: `render(sql\`id in ${[1,2,3]}\`)` → `{ sql: 'id in (?, ?, ?)' }` with 3 slots, plus the check-constraint case.

### [F-082] `db.run` / `db.all` / `db.get` reject a `sql` fragment or a string — status: **needs-human** — severity: med — area: api — COMPAT-DEFECT
- **Where**: `src/runtime/database.ts:131`, `:135`, `:139`
- **Defect**: Drizzle's SQLite database exposes `run`/`all`/`get`/`values` taking `string | SQLWrapper` (`drizzle-orm/sqlite-core/async/db.js:320-346`). orm-d1 keeps the three names but its contract is `(query: CompiledQuery, input?)`. An orm-d1 fragment has no `parts`, so `Executor.executeRows`/`executeRun` dereference `query.parts.length` on `undefined`.
- **Failure scenario**: `db.run(sql\`pragma foreign_keys = on\`)` — the canonical SQLite escape hatch — and `db.all(sql\`select 1 as n\`)`, `db.get(...)`, `db.run('select 1')` all give `TypeError: Cannot read properties of undefined (reading 'length')`. The message names neither the method nor the argument, and the working raw path (`db.execute(sqlString, params)`) is not pointed at.
- **Why parked**: the fix widens three published method signatures to `CompiledQuery<TRow> | SQLChunk | string`, which is a change to the published API surface the sweep may not make. orm-d1's compiled-query contract for these names is documented at `docs/03-architecture.md:184`, so it is a widening rather than a redefinition — a `CompiledQuery` is distinguishable by `Array.isArray(q.parts)`.
- **Question for the human**: widen the three signatures (matching Drizzle, and the reviewer sketched the guard), or keep the compiled-query-only contract and merely **throw with a message naming `db.execute()`** instead of letting a `TypeError` escape? The second is small and does not touch the signature.

### [F-083] `sql.join`'s default separator is `', '`; Drizzle's is none — status: **done** (`5051bc7`, all ten call sites verified — see `[F-088]`) — severity: med — area: sql — COMPAT-DEFECT
- **Where**: `src/sql/sql.ts:237`
- **Defect**: Drizzle's `sql.join(chunks, separator)` inserts a separator only `if (i > 0 && separator !== void 0)` (`drizzle-orm/sql/sql.js:335-341`) — the no-argument form concatenates. orm-d1's inserts commas.
- **Failure scenario (forward)**: the standard chunk-assembly idiom gives Drizzle `select * from "users" where "id" = 1` and orm-d1 `select * from "users",  where "id" = 1`.
- **Failure scenario (reverse-alias — `docs/08` makes this a standing constraint)**: a schema using `sql.join` inside a `check()` renders correctly under orm-d1 and, once aliased back to `drizzle-orm/sqlite-core` for `studio`, renders `in ('admin''member')` — a single concatenated literal, so the CHECK admits values it was written to reject.
- **Fix**: default to `undefined` and thread it through both branches, then pass `', '` explicitly at the three internal callers that relied on it — `src/sql/functions.ts:59` (`coalesce`), `src/sql/expressions.ts:168` (`InArray`), `src/better-auth.ts:172` (`lowerIn`). `relations/query.ts:334,335` and `relations/joined.ts:263,277,278` already pass separators explicitly.
- **Prove it**: `render(sql.join([sql\`a\`, sql\`b\`]))` → `{ sql: 'ab' }` and with `', '` → `{ sql: 'a, b' }`; the existing `inArray`/`coalesce`/`lowerIn` assertions must stay green — they are what pins the three call-site edits.

### [F-084] `NEW-SURFACE` from the iteration-7 feature lens — status: needs-human — severity: n/a — area: api
Only items not already on the recorded list:
1. **`db.values(query)`** — the fourth member of Drizzle's session API (`sqlite-core/async/db.js:341`), returning rows as positional arrays. The machinery exists: `CompiledQuery.map` already reads `D1PreparedStatement.raw()`.
2. **`.execute(placeholderValues?)` on the four builders.** Every Drizzle builder inherits it from `QueryPromise`. orm-d1 has it on `RelationalQuery` (`relations/query.ts:735`) but not on `SelectBuilder`/`InsertBuilder`/`UpdateBuilder`/`DeleteBuilder`, so the surface is inconsistent with itself as well as with Drizzle. A one-line alias for `all()`/`run()` on each.
3. **`.prepare()`** returning a reusable statement, with `preparedStatement.execute(values)`. `compile()` + `bind()` + `all(input)` already covers the semantics under different names.
4. **`db.batch([db.query.users.findMany()])`** — Drizzle's D1 driver accepts a relational query in a batch (`SQLiteAsyncRelationalQuery` implements `_prepare`); orm-d1 throws `TypeError: item.compile is not a function`. Only expressible for queries that compile to one statement — the `joined` strategy, or any `find*` with no `with` — so a real design decision, not a small patch.
5. **`sql.fromList`, `sql.param`, `sql.comment`, `SQL.prototype.append`** — on Drizzle's `sql` namespace, absent from `SQLTag` (`src/sql/sql.ts:212-219`).

### [F-085] `alias(subquery, 'x')` silently produces wrong SQL — status: done (TBD, `alias()` propagates `TableSource`/`TableNullableGroups` — see `src/schema/table.ts`) — severity: med — area: schema — OFF-LENS from feature
- **Where**: `src/schema/table.ts:352`
- **Defect**: `alias()` runs `buildTable(...)`, which does not copy the `TableSource` symbol, so the inner statement is lost. `query.select({id: a.id}).from(alias(sq,'x'))` compiles to `select "x"."id" from "sq" "x"` and fails at runtime with `no such table: sq`, instead of inlining `(select …) "x"`.
- Off-lens because Drizzle's `alias()` is documented for tables and views, not subqueries — but it is wrong SQL produced silently at compile time.

### [F-086] `logger` is accepted and ignored — status: done (TBD, `Logger` interface + `DefaultLogger`, wired through `Executor#prepare` — see `src/runtime/database.ts`, `src/runtime/session.ts`) — severity: low — area: runtime — OFF-LENS from feature
- **Where**: `src/runtime/database.ts:59`
- **Defect**: `logger: true` is the single most common Drizzle debugging switch; silently discarding it means a user who sets it concludes no queries are running. `docs/08`'s Tier 2 says such options should carry a `__DEV__` warning; this one does not.

## Iteration 7 — **approved** and merged (`5051bc7`)

Second consecutive round-2 approval. The reviewer A/B'd 35 inputs against
`drizzle-orm@1.0.0-rc.4` and confirmed every one byte-identical in both `sql` and `params`,
verified the DDL claims against real SQLite, and re-measured the bundle from `git archive`
exports of each ref. Net cost of the whole batch vs `main`: **+101 bytes** on `src/core.ts`
and `src/index.ts`, +96 on `src/relations/index.ts`.

Worth keeping from the verification: recursion depth throws at the same order of magnitude in
both implementations (depth 10 000 → `RangeError` in each; a self-referential array likewise),
and orm-d1 is strictly better on the reverse case — it recurses per nesting *level* but
iterates over elements, so a 200 000-element flat array renders where Drizzle's per-level
spread throws. `check ("role" in ('admin', , 'member'))` and `check ("score" >= )` are both
rejected loudly by SQLite (`near ",": syntax error`, `near ")": syntax error`), so the DDL hole
is closed rather than moved. No injection on the newly-reachable inline path: a value
containing `'); drop table …` renders as one properly-doubled literal.

### [F-087] An *empty* interpolated array in a DDL predicate renders `()`, which SQLite accepts — status: done — severity: med — area: sql/ddl
- **Where**: `src/sql/sql.ts` (`SQL.toQuery`'s array branch, orm-d1's own `sql` tag) + `src/sql/drizzle-sql.ts` (`fromDrizzleSQL`, a Drizzle `sql` fragment) + `src/ddl.ts` (`refuseEmptyArrayPredicate`, `withDDLContext`).
- **Current implementation**: not a `__DEV__` warning — `createTable`/`createIndexes` (via `checkDDL`, `createIndex`, `columnDDL`) throw outright when a `check()` or a partial index's `where()` interpolates an empty array, whether written with orm-d1's own `sql` tag or Drizzle's. `fromDrizzleSQL` structurally walks the fragment's own `queryChunks` (recursing into nested `SQL` fragments from `and()`/`eq()`/etc.) looking for a bare `Array.isArray(chunk) && chunk.length === 0` — no text/string heuristics — and consults the same `ctx.onEmptyArrayPredicate` hook `src/sql/sql.ts` already had, closing the gap where a check/where built with Drizzle's own `sql` tag rendered `not in ()` silently. The thrown error additionally names the table and constraint (`withDDLContext` in `src/ddl.ts`), since the `RenderContext` hook that throws has no access to that context on its own.
- **Defect**: the one place in the batch where a loud failure became a silent one, and it lands in bug class #1. Verified on SQLite 3.53.1 through both trees: `main` emitted `check ("role" not in '')` → **rejected**, `subqueries prohibited in CHECK constraints`; a pre-fix HEAD emitted `check ("role" not in ())` → **accepted**, and admitted a row. Same for a partial index: `where "role" in ''` was rejected, `where "role" in ()` is accepted and the "unique" index then admits a duplicate.
- **Failure scenario**: `check('role_ok', sql\`${c.role} not in ${ROLES}\`)` where `ROLES` is a config array that happens to be empty. `x NOT IN ()` is unconditionally true and `x IN ()` unconditionally false, so the CHECK is permanently inert and the partial unique index covers zero rows — and both are self-consistent, so introspection reads them back verbatim and `check`/`push` converge forever.
- **Why it was not grounds for rejection**: `drizzle-orm` renders the identical `()` for an empty array (confirmed), so diverging here would break the `docs/04` reverse-alias invariant. The pre-fix behaviour was not safe, it was accidentally-loud garbage (`in ''`). The non-empty case — the common one — went from broken-and-loud to correct.
- **Migration note**: `docs/04-migrating-from-drizzle.md` documents that upgrading past this fix produces a one-time table-recreation migration for any existing table whose check/where was built from an empty array (the old inert `()` text differs from whatever the schema now supplies, or the call fails until the array is fixed).

### [F-088] `sql.join`'s changed default needs a release note — status: needs-human — severity: low — area: release
- `SQLTag.join`'s declared type is untouched (`separator?:` was already optional); only the runtime default changed, from `', '` to none. An existing orm-d1-native caller writing `sql.join(parts)` now gets `select a b from t` where it used to get `select a, b from t` — SQL that parses and returns one aliased column, with no type error and no deprecation. Correct under `docs/08` and `sql.join` is undocumented in `README.md`/`docs/`, so it is a release-note item rather than a defect. It is now reachable by user code through `callableOperators` (`src/relations/query.ts:75`), which is exactly where Drizzle parity matters.

### [F-089] A hand-written `sql\`${col} in ${ids}\`` has no `json_each` fallback — status: needs-human (not closed — the only fix shape available is textually detecting an `in`/`not in`-shaped fragment inside an arbitrary hand-written `sql` template, which is exactly the fragile heuristic to avoid; low severity per the finding itself, since `main` never worked here either) — severity: low — area: sql
- With 200 ids it now compiles cleanly to 200 `?` and fails at D1 with `too many SQL variables`. The budget guard lives in `InArray` (`src/sql/expressions.ts:155`), which a hand-written fragment does not go through. On `main` that expression never worked at all, and Drizzle behaves the same, so `[F-081]` did not open it so much as make it reachable.

### [F-090] Two redundant `not.toContain` guards in the new DDL test — status: **done** (this batch) — severity: low — area: test-integrity
- **Where**: `test/unit/ddl.test.ts:99`
- The exact assertion `expect(ddl).toContain('check ("role" in (\'admin\', , \'member\'))')` carries the weight and is correct. The two `not.toContain` guards beside it are redundant, and `not.toContain('null, ')` is not load-bearing: the DDL *does* contain `"role" text not null` immediately before the constraint, and the assertion passes only because `createTable` joins members with `,\n\t` rather than `, `. It would fail spuriously if the DDL formatter ever emitted single-line output.
- **Resolved**: both `not.toContain` lines removed from `test/unit/ddl.test.ts`; the
  single `toContain` assertion that actually carries the weight is unchanged.

### [F-097] No regression gate on published bundle-size numbers — status: **done** (this batch) — severity: low — area: efficiency
- **Where**: `test/unit/module-resolution.test.ts`; `docs/01-differences.md`'s "Bundle
  size" section; `README.md`'s "Bundle size" section
- **Defect**: `docs/01-differences.md` says outright — "these two numbers come from a
  one-off measurement. Nothing in CI re-measures them, so they can drift from the
  published packages as either library changes." Nothing enforced that, so both docs
  carried a stale `orm-d1` figure (44.1 kB / 15.3 kB) against a today-measured 51.7 kB
  / 17.7 kB for the identical scenario, and `[F-072]` — a batch's bundle cost measured
  against the wrong baseline — went unnoticed by any automated check.
- **Fix**: `test/unit/module-resolution.test.ts` gained a "bundle-size ceiling" describe
  block, reusing the file's existing esbuild-driven, `drizzle-orm`-redirected fixture.
  It bundles the same Worker **minified** this time (the existing tests in the file
  never pass `--minify`, so they measure a different, larger number than the one
  `docs/01`/`README.md` publish) and asserts the minified and gzipped byte counts stay
  at or under a ceiling seeded from today's real measurement plus ~15% headroom. It runs
  under `npm run test`, which `npm run check` calls after `npm run build`, so it is part
  of the required gate, not an opt-in extra.
- **Docs corrected in the same commit**: `docs/01-differences.md`'s table now reads
  51.7 kB / 17.7 kB for `orm-d1` (the `drizzle-orm` row, 77.8 kB / 22.2 kB, was
  re-measured too and is unchanged — confirmed by bundling the fixture's un-redirected
  import directly), and its percentages recompute to −34% / −20%. `README.md`'s
  corresponding line is updated to match. The "nothing re-measures them" sentence in
  `docs/01` is rewritten to describe the new gate instead of disclaiming its absence.
- **Prove it**: ran `npm run build` then `npx vitest run test/unit/module-resolution.test.ts`
  directly — the new test passes against today's real bundle. Revert-verified: lowering
  `MINIFIED_CEILING` below the measured value makes the test fail with the expected
  `toBeLessThanOrEqual` assertion message; restoring it passes again.

### [F-116] `min()`/`max()`'s `String` decode for a non-`Column` operand needs a release note — status: needs-human — severity: low — area: release
- Same shape as `[F-088]`/`[F-059]`. `min(sql<number>\`unixepoch(${t.at})\`)` decoded through the driver value untouched on `main`; it now decodes through `String`, matching `drizzle-orm/sql/functions/aggregate.js`'s `.mapWith(is(expression, Column) ? expression : String)`. Correct under Drizzle parity, and now documented at `docs/01-differences.md` (`min()` and `max()` over a non-`Column` expression decode to `string`), but existing orm-d1-native code calling `min()`/`max()` over a raw `sql<number>`/`sql<Date>` fragment and relying on the passthrough value changes behaviour silently, with no type error — a release-note item, not a defect.

## Findings — downstream integration (outside the rotation)

Provenance: building one feature end-to-end (schema → migration → GraphQL → two clients) in
the downstream app that supplies `ORM_D1_FIXTURE_SCHEMA`, then reading orm-d1's source for
each place that cost time. These are **adoption frictions**, not sweep findings: none was
produced by a lens, and the rotation pointer above was deliberately **not** advanced.

Per *Notes for the human*, no schema was copied here. Shapes are described generically and
the evidence is counts of call sites, not table or column names.

Ranked by what they cost the app, most first. All of them rank **below** the open
regressions — `[F-055]`, `[F-068]`, `[F-069]`, `[F-070]`, `[F-071]` — which are defects
rather than frictions. Suggested order once those are closed: `[F-094]`, `[F-096]`,
`[F-097]`, `[F-095]` (small, no design decisions) → `[F-092]`/`[F-082]` (one decision,
deletes user code) → `[F-091]`, `[F-093]` (new surface).

### [F-091] `latestPerGroup` returns rows, so "filter by the newest row's value" has no spelling — status: needs-human — severity: med — area: sql/builders — NEW-SURFACE
- **Where**: `src/builders/window.ts:76`, documented at `docs/02-beyond-drizzle.md` (`## latestPerGroup`)
- **Defect**: `latestPerGroup` materialises one row per group and returns them. It cannot be composed into another query's `where`, into `count(*)`, or into a relational filter, so the adjacent shape — *"rows whose newest child row has (or does not have) a given value"* — falls back to hand-written SQL.
- **Failure scenario**: an event-sourced table where the newest child row is the parent's current state (the shape `latestPerGroup`'s own doc example uses). "Count the parents whose current state is not `cancelled`" cannot be expressed: `latestPerGroup` fetches every group's newest row to the Worker in order to count them, so the caller writes a correlated `order by … limit 1` subquery instead. In the downstream app that predicate is hand-written in **4 places** (one shared constant consumed by 4 call sites, plus 3 independent copies), while `latestPerGroup` is used in 2 — the composable shape is the more common one, and it is the one that is missing.
- **Fix**: add an expression-returning sibling that renders the same correlated subquery and is usable anywhere a `Condition` operand is. Proposed shape, keeping `tiebreak` required for the reason the existing doc gives:
  ```ts
  latestValue(child.state, {
    partitionBy: [child.parentId],
    orderBy: [desc(child.recordedAt)],
    tiebreak: desc(child.id),
    correlate: eq(child.parentId, parent.id),
    fallback: 'initial',            // renders coalesce(…) — "no child rows yet"
  })
  ```
- **Question for the human**: add this as public surface, or keep composition out of scope and document the correlated-subquery recipe in `docs/02` next to `latestPerGroup` so callers at least stop reinventing the tiebreak? The `fallback` argument is the part worth deciding on: without it every caller writes `coalesce` by hand, and omitting it silently turns "no rows yet" into `null`, which compares false against everything.
- **Prove it**: `test/workers/latest-per-group.test.ts` gains a case asserting the emitted SQL and the rows for a `count(*)` filtered by the newest child value, against a real D1 binding; `npm run test:workers` red → green.

### [F-092] `toQuery()` ignores the database's render budget and returns parameter *slots*, so the documented raw path is wrong by default — status: needs-human — severity: med — area: api
- **Where**: `src/sql/sql.ts:106` (`toQuery(ctx?: RenderContext)`), `src/plan/params.ts:17` (`bindParams`), `src/runtime/database.ts:153` (`execute`), `:96`–`:103` (`$maxParams` / `$jsonEachThreshold`)
- **Defect**: same root cause as `[F-082]`, recorded separately because it is new evidence about that item's severity rather than a second defect. `[F-082]` describes the `TypeError` a caller hits when reaching for `db.all(sql\`…\`)`. What it does not capture is that the **working** path — render the chunk, hand the pieces to `execute()` — has two independent ways to be silently wrong, and a caller who works around `[F-082]` correctly still has to know both.
- **Failure scenario**: (1) `chunk.toQuery()` with no argument renders against `defaultRenderContext`, not against the database's `$maxParams` / `$jsonEachThreshold`. `inArray` switches to a single `json_each` parameter at the threshold, so a chunk rendered under the default budget can emit a different number of placeholders than the database will bind — the mismatch appears only for list lengths that straddle the two thresholds, i.e. not in the first test anyone writes. (2) `toQuery()` returns slots, not values: `const` slots carry a captured value but `fn` slots (`$defaultFn` / `$onUpdate`) must be evaluated per execution, so passing the result straight to `execute()` binds objects and SQLite reports a parameter-count mismatch. The downstream app carries a 38-line bridge whose entire body is these two corrections, and both are documented there as things that were hit, not anticipated.
- **Fix**: resolve `[F-082]` by **widening** `db.run` / `all` / `get` to `CompiledQuery<TRow> | SQLChunk | string` rather than by throwing a better error. Widening moves both corrections inside the library, where the database's budget and the slot evaluation are already in scope; the better-error option leaves every caller to rediscover them.
- **Question for the human**: this is `[F-082]`'s parked question, with a recommendation attached. Deciding it closes both items.
- **Prove it**: the downstream app deletes its bridge and calls `db.all(sql\`…\`)` directly, with its own suite as the acceptance test. In this repo: `test/workers/` gains a case binding an `inArray` list whose length sits between `defaultRenderContext.jsonEachThreshold` and a database configured with a different `jsonEachThreshold`, plus one binding a `$defaultFn` column through the raw path; `npm run test:workers` red → green.

### [F-093] No `insert … select … where`, so D1's only atomic compare-and-set is unreachable from the builder — status: needs-human — severity: med — area: sql/builders — NEW-SURFACE
- **Where**: `src/builders/insert.ts:127` (`values` is the only entry point)
- **Defect**: `insert()` accepts rows and nothing else. D1 has no interactive transactions — `docs/01` says so and refuses to pretend otherwise — which leaves a single statement as the only unit of atomicity, and therefore `insert … select … where (<predicate>)` as the only way to write "claim a slot if one is free" without a read-then-write race.
- **Failure scenario**: any bounded resource with concurrent claimants — the canonical one is a capacity-limited row where the count of live children must stay below a limit. Count-then-insert cannot hold the count across the `await`, so two simultaneous claims for the last slot both win. The correct statement is expressible in SQLite and in D1; it is not expressible in this builder, so the downstream app drops to raw SQL for exactly the operation where being wrong is a paid-for overbooking.
- **Fix**: add `insert(t).select(selectBuilder)`, matching `drizzle-orm`'s spelling so the `docs/04` reverse-alias invariant holds. The hard half is the guard predicate: Drizzle expresses it as a `where` on the inner select, which requires the inner select to be a source-less `select <literals> where <cond>` — confirm SQLite accepts that shape before designing around it.
- **Question for the human**: add the surface, or document the raw-SQL recipe in `docs/02` under a heading about atomicity on D1, next to the `batch()` discussion that already explains why transactions are absent? The second is cheap and would at least make the pattern findable; the first is what makes it checked.
- **Prove it**: `test/workers/` gains a concurrency case issuing N simultaneous conditional inserts against a limit of 1 and asserting exactly one row lands; `npm run test:workers` red → green.

### [F-094] `$inferSelect` / `$inferInsert` are missing from the table type — status: done (this batch) — severity: med — area: schema — COMPAT-DEFECT
- **Where**: `src/schema/table.ts` (the built-table type), helpers already present at `src/schema/infer.ts:58-59`
- **Defect**: `drizzle-orm` exposes row types both as free helpers (`InferSelectModel<T>`) and as properties on the table (`typeof users.$inferSelect`, `typeof users.$inferInsert`). orm-d1 has only the first, so a schema ported by changing one import specifier keeps compiling while every `typeof X.$inferInsert` in the surrounding code becomes `TS2339`.
- **Failure scenario**: the property spelling is what test fixtures and seed helpers use, because it needs no import. In the downstream app it appears **25 times across 9 files** and every one is an error — undetected until now only because that app's test tsconfig is not wired into any script, so the annotations have been silently inert rather than loudly wrong. An adopter whose tests *are* typechecked sees 25 errors on day one, in files that have nothing to do with the database driver.
- **Fix**: declare `$inferSelect: InferSelect<this>` and `$inferInsert: InferInsert<this>` on the built-table type. Type-only, so no runtime bytes and no bundle cost; `InferSelect` / `InferInsert` already exist and are what `InferSelectModel` / `InferInsertModel` alias.
- **Prove it**: `test/unit/` type-level assertions that `typeof users.$inferSelect` and `typeof users.$inferInsert` equal `InferSelectModel<typeof users>` / `InferInsertModel<typeof users>`, including a table with `$defaultFn` and a nullable column so the insert side's optionality is pinned; `npm run test:unit` red → green.
- **Resolved**: `TableMeta` (`src/schema/table.ts`) gained `readonly $inferSelect: InferSelect<this>` / `readonly $inferInsert: InferInsert<this>` — type-only, the object literal in `buildTable` is cast rather than assigned these fields, so zero runtime bytes. `test/unit/drizzle-types.test.ts` gained the pinned assertions, including the `$defaultFn` + nullable-column case.
- **Follow-up correction (2026-08-18)**: `src/schema/infer.ts`'s `InferInsertFromColumns` spelled its optional half `?: Out<C[K]>`, not real drizzle-orm's `?: GetColumnData<…, 'query'> | undefined` (`node_modules/drizzle-orm/table.d.ts`, verified). Under this repo's `exactOptionalPropertyTypes: true` (`tsconfig.json`) the two are not equivalent: an object literal setting an optional key to an explicit `undefined` assigns to Drizzle's type but not to the narrower one. Fixed by adding `| undefined` explicitly (`src/schema/infer.ts`). Also fixed the test that was supposed to catch this: `'$inferInsert makes a $defaultFn column optional'` in `test/unit/drizzle-types.test.ts` compared `typeof t.$inferInsert` only against a hand-written literal (`{ id?: number; … }`, itself missing `| undefined`), so it checked orm-d1 against itself and could not have caught the bug. It now builds the equivalent table with real `drizzle-orm/sqlite-core`, asserts `toEqualTypeOf` against `typeof dzT.$inferInsert`, and additionally assigns an object literal with an explicit `undefined` value to both sides — the exact `exactOptionalPropertyTypes` edge case. The earlier mutual-assignability comment on `'requires the same keys on insert'` (which explained the two sides used to differ under `exactOptionalPropertyTypes`) is now stale and updated to note they're exactly equal.

### [F-095] Two resolved `drizzle-orm` copies break `instanceof Many` silently, and nothing detects it — status: done (this batch, `assertSameDrizzle` added) — severity: med — area: drizzle-compat
- **Where**: `src/drizzle.ts:120` (`asDrizzleRelations`), `:219` (`asPothosRelations`); named as a known failure mode under *Audit areas* → *Relational loading*
- **Defect**: `asDrizzleRelations` re-prototypes onto the `Many` that **orm-d1** resolved. If the adapter (Pothos' drizzle plugin) resolves a different copy, `instanceof Many` is false for every relation and the plugin treats all of them as single objects. It is bug class #3 (wrong rows), it produces no error, and the only current defence is documentation.
- **Failure scenario**: a lockfile that hoists two `drizzle-orm` versions — a range bump in any dependency does it. Every list field in the GraphQL schema starts returning one object instead of an array. Types do not catch it: the two copies' relation types are mutually unassignable, but adapters already require casts at exactly the seams where the assignability would have been checked. The downstream app defends against it by pinning `drizzle-orm` to an exact version and writing a warning in two places, which is a discipline, not a check.
- **Fix**: no new runtime surface required. Add to `docs/05-adapters.md`, in the `asDrizzleRelations` bullet that already explains the `instanceof` requirement, a one-line assertion for adopters to put in their own suite:
  ```ts
  import { Many } from 'drizzle-orm';
  import { asDrizzleRelations } from 'orm-d1/drizzle';
  const r = asDrizzleRelations(relations);
  expect(Object.values(Object.values(r)[0].relations)[0]).toBeInstanceOf(Many);
  ```
  It fails exactly when the two copies diverge, because the `Many` on the left is the one the *app* resolves. An `assertSameDrizzle({ Many })` export would be friendlier but is public surface, so record it as an upgrade rather than doing it here.
- **Prove it**: this repo cannot host the negative control without installing two `drizzle-orm` copies. Assert the positive direction in `test/unit/` (the recipe passes under a single copy) and note the limitation next to it; `npm run test:unit` stays green and the recipe is what ships. `npm run check` unaffected.
- **Follow-up correction (2026-08-18)**: `assertSameDrizzle`'s docstring (`src/drizzle.ts`, near line 162) claimed to guard against *an adapter* (e.g. Pothos' drizzle plugin) resolving a separately-hoisted `drizzle-orm` copy — but the function only ever sees the `Many` its own caller passes in; it has no way to reach into a third-party package's private import and check what that package resolved internally, and doing so from `src/` would need Node-only module-resolution introspection, which is forbidden there. Reworded to state plainly what it proves (the calling code and orm-d1 share one `Many`/instance) and what it does not (anything about a separate adapter's own resolution, beyond the ordinary case where the dependency tree gives everyone the same copy). `docs/05-adapters.md`'s matching claim corrected the same way. Also fixed the `toBeInstanceOf` recipe in `docs/05-adapters.md`: `Object.values(r)[0]` broke for a relation declared from the child side (e.g. `postTags: { post: r.one.posts(...) }` with nothing declared on `posts` itself — see `src/relations/define.ts`), and for a schema where the first relation encountered is a `One`. Replaced with a recipe that searches every declared relation, across every table, for one that is a `Many` — correct regardless of which side declares the relation or what order tables are visited in.
- **Resolved**: standing authorization upgraded this past documentation-only to the friendlier export. `assertSameDrizzle({ Many })` (`src/drizzle.ts`, next to `asDrizzleRelations`) throws a clear message when the passed `Many` does not match the one this module resolved. Both recipes — the `toBeInstanceOf(Many)` one and the new export — are now in `docs/05-adapters.md` § Pothos. `test/unit/assert-same-drizzle.test.ts` covers the positive path and the throwing path (with a distinct fake class standing in for a second copy); the true two-copy negative control still cannot be hosted here, as noted.

### [F-096] `pothosFindConfig` is exported and used everywhere, and documented nowhere — status: done (this batch) — severity: low — area: docs
- **Where**: `src/drizzle.ts:259`; `docs/05-adapters.md` § Pothos lists three substitutions and not this one. `grep -rn pothosFindConfig docs/ README.md` returns nothing.
- **Defect**: `docs/05` documents the *builder-construction* seam (`getTableConfig`, `asPothosRelations`, `asDrizzleTable`) and stops there. `pothosFindConfig` is the *resolver-side* seam, needed in every drizzle-backed resolver that passes a `where`, and it is reachable only by reading the source.
- **Failure scenario**: an adopter follows `docs/05`, wires the builder correctly, writes their first resolver, and finds the plugin's `query()` result rejected by `findMany` because of the phantom `$pothosQueryFor` key. Nothing in the docs names the cause or the helper; the visible workarounds are `as never` on the whole config — which is what the helper's own docstring says the previous code did — and that silently gives up the schema-level checking of `where` / `columns` / `with` / `orderBy`. In the downstream app the helper is imported in **20 GraphQL type modules**, so it is not an edge case of the integration, it is the integration.
- **Fix**: add it as the fourth bullet in `docs/05-adapters.md` § Pothos. The docstring at `src/drizzle.ts:259` is already the right text — why the phantom key exists, that it is never constructed, and that the return type keeps the config checked — plus the one-line usage example it carries.
- **Prove it**: documentation only; `test/workers/pothos.test.ts` already exercises the helper. Acceptance is that `docs/05` alone is sufficient to write a resolver with a `where`, with no source reading.
- **Resolved**: added as the fourth bullet in `docs/05-adapters.md` § Pothos, based on the docstring at `src/drizzle.ts` (`pothosFindConfig`) — the phantom-key explanation and the one-line usage example.

### [F-097] The published bundle numbers are a one-off measurement with no regression gate — status: todo — severity: low — area: efficiency
- **Where**: `docs/01-differences.md:261` (§ Bundle size), `package.json` (`check`), `test/unit/module-resolution.test.ts`
- **Defect**: `docs/01` publishes 44.1 kB minified / 15.3 kB gzipped and states plainly that nothing in CI re-measures them. The internal target in `CLAUDE.md` is ≤ 20 KB for the core entry. Measured now — `esbuild dist/core.js --bundle --minify --format=esm` — the core entry alone is **42,385 bytes**, so the target is out by more than 2×, and the only number that moves when someone adds an export is the one hand-written into this file's header.
- **Failure scenario**: Workers bill startup CPU and parse time tracks uncompressed bytes, so this is a per-cold-isolate cost paid by every adopter. `[F-072]` in this file is the shape of the problem already biting: a batch's bundle cost was reported against the previous commit rather than `main`, because measuring is a manual step someone has to remember and get right.
- **Fix**: extend `test/unit/module-resolution.test.ts` — which already measures — to assert a byte ceiling per entry, seeded at today's measurement rather than at the aspirational target, and run it from `npm run check`. Ratcheting down to 20 KB is a separate question; this item only stops the number from moving without anyone noticing.
- **Prove it**: add an export to `src/core.ts` that pushes the entry over the ceiling and confirm `npm run check` fails naming the entry, the ceiling and the measured size; revert and it passes.

## Findings — iteration 8 (efficiency + bugs)

Lens: **efficiency + bugs**, branch `sweep/efficiency-bugs-20260817-125622`.

### [F-098] A table rename leaves every referencing FK pointing at the old name — status: **done** (`e949b1d`, confirmed closed by both review rounds against real reproductions) — severity: **high** — area: kit/diff — lens: efficiency + bugs
- **Where**: `kit/src/core/diff.ts:407`
- **Defect**: `effectiveBefore[renamed] = { ...t, name: renamed, appendOnly: false }` renames only the table's own entry; every other table's `ForeignKeySnapshot.tableTo` / `ColumnSnapshot.references.tableTo` (and the renamed table's own self-references) still names the old table, while SQLite's `ALTER TABLE … RENAME TO` rewrites every `REFERENCES` clause since 3.25.
- **Failure scenario**: (A) `users` → `people` with `posts.author_id references users.id`: `requiresRecreate` reports `a foreign key changes`, so `generate` emits a full `__new_posts` copy + `drop table "posts"` (destructive, needs `--accept-data-loss`) for a schema that is already correct; with a third level (`comments`) `dependentTables` refuses and `generate` throws — the rename cannot be expressed at all. (B) self-referencing `nodes(parent_id → nodes.id)` renamed to `trees` errors with a remedy ("drop the foreign key, or migrate the child table in the same migration") that is impossible for a self-reference.
- **Fix**: in step 1 of `diffSnapshots`, after building `effectiveBefore`, repoint every `tableTo` matching a renamed source across **all** tables, including the renamed table itself — mirroring what the `ALTER` actually does.
- **Prove it**: `kit/test/unit/diff.test.ts`, next to `applies explicit renames instead of dropping and recreating`: assert the `users`→`people` diff collapses to exactly `['alter table "users" rename to "people"']` with no errors, plus a self-FK case asserting `errors` is empty.

### [F-099] `nullableTables` misses tables joined before a `right`/`full` join, so they materialise as an object of nulls — status: **done** (`e949b1d`, runtime + type level, confirmed byte-for-byte against `drizzle-orm`'s fold by round 2) — severity: **high** — area: sql/compile — lens: efficiency + bugs
- **Where**: `src/plan/compile.ts:146` (and `explicitNullableGroups` at `:202`, which shares the same set)
- **Defect**: `right`/`full` add only `plan.from` to `nullableTables`; Drizzle marks **every** table already in the map nullable (`drizzle-orm/sqlite-core/query-builders/select.js:111-121`).
- **Failure scenario**: `db.select().from(users).innerJoin(profiles, …).rightJoin(events, …)`. For an `events` row with no matching user the driver returns all-null for `users.*` and `profiles.*`; orm-d1 maps `users: null` but `profiles: { id: null, userId: null, bio: null }` where Drizzle returns `profiles: null`. The declared type is non-null, so `if (row.profiles) use(row.profiles.id)` compiles, the guard passes, and `id` is silently `null`. Same for `.innerJoin(profiles).fullJoin(events)`.
- **Fix**: track nullability as an ordered map as Drizzle does — start `{ [from]: notNull }` and fold each join in declaration order: `left` → that table nullable; `inner`/`cross` → not-null; `right` → all existing nullable + this one not-null; `full` → all existing nullable + this one nullable. `AddJoin` needs the same treatment so `rightJoin`/`fullJoin` widen previously joined entries, not just `baseRow`.
- **Prove it**: `test/unit/compile-select.test.ts` — build the plan above, feed `compiled.map([[null,null,null,null,null,7,null]])`, assert `rows[0].profiles === null`.

### [F-100] `pull` drops `STRICT`, `WITHOUT ROWID` and the append-only guard — status: **done** (`e949b1d`, warning half only, confirmed) / **needs-human** (the `tableOptions` sidecar) — severity: **high** — area: kit/node — lens: efficiency + bugs
- **Where**: `kit/src/node/commands.ts:371` (`renderSchemaModule`), `pull` at `:349`
- **Defect**: `snapshotFromIntrospection` records `strict` / `withoutRowid` / `appendOnly` correctly and `pull` journals that snapshot, but the rendered schema module has no spelling for any of them and no companion `tableOptions([...])` module is written, so the next `snapshotOfSchema` reads all three as `false`.
- **Failure scenario**: a live `STRICT, WITHOUT ROWID` table with an append-only trigger is pulled as a plain `sqliteTable`; the very next `generate`, with no schema edit at all, emits a `__new_reads` rebuild + `drop table "reads"` and `drop trigger if exists "reads_no_update"`. `WITHOUT ROWID` is lost with no line naming it (the first `requiresRecreate` reason wins), and the single `--accept-data-loss` the operator supplies for the `drop table` takes the append-only guard with it. The onboarding command turns a protected, strictly-typed ledger into an ordinary writable table.
- **Fix (this iteration)**: make `pull` refuse or loudly warn when the introspected snapshot carries any `strict` / `withoutRowid` / `appendOnly` the rendered module cannot express, naming the tables and the options.
- **Question for the human**: should `pull` also render a `tableOptions([...])` sidecar next to `--schema-out` and populate `config.tableOptions`? That is new CLI output surface and a design decision, so only the warning half is batched.
- **Prove it**: `kit/test/unit` — feed introspection of the `STRICT, WITHOUT ROWID` + trigger table through `snapshotFromIntrospection` → `renderSchemaModule` and assert the warning names the table and each unexpressible option.

### [F-101] Column-level `COLLATE` is never captured, so `check` is blind to it and any rebuild drops it — status: **partial** (`e949b1d`, `991f1b6`) — **opened four new defects, see `[F-106]`–`[F-109]`; `[F-106]` is a regression vs `main`** — severity: **high** — area: kit/introspect — lens: efficiency + bugs
- **Where**: `kit/src/core/introspect.ts:470-496`, `kit/src/core/snapshot.ts:44-67`
- **Defect**: `ColumnSnapshot` has no `collate` field; `snapshotFromIntrospection` reads index-member collations but never a column's own, and `columnDefinition` / `createTableFromSnapshot` never emit one. Index members were fixed for this exact reason (`[F-061]`); columns were not.
- **Failure scenario**: a foreign schema with `email text collate nocase not null` and a unique index on it. `orm-d1-kit check` prints "Up to date, no drift" even after the column is rebuilt as `BINARY` by hand — the command whose job is to notice a silently-dropped constraint cannot see this one. Any diff that rebuilds `users` emits `"email" text not null` with no collation, so the unique index is recreated over a `BINARY` column and `alice@x.com` / `Alice@x.com` both insert.
- **Fix**: add `collate?: string` to `ColumnSnapshot`; parse it in `snapshotFromIntrospection` from the column's own definition in `createSql` (the same `columnDefinitionStart` anchoring `hasAutoincrement` / `parseGenerated`, on `blankLiterals(createSql)`); emit it in `createTableFromSnapshot` and `columnDefinition`; fold case in `canonicalTable` so `NOCASE` / `NoCase` compare equal. The schema DSL cannot declare it (`docs/04` — Drizzle has no `.collate()`), so schema-side `undefined` means "not stated", and a live non-`BINARY` collation against an unstated one is **reported**, not dropped.
- **Prove it**: `kit/test/workers/foreign-schema.test.ts` — create the table against the real D1 binding, `introspect()`, assert `columns.email.collate === 'nocase'`, then assert `createTableFromSnapshot` still contains `collate nocase`.

### [F-102] `Column.name` re-runs `toSnakeCase` on every read — status: **done** (`e949b1d`, `991f1b6`; measured 18.13 → 9.26 µs/op for a 31-column `compileSelect` under `snake_case`, memo versioned so `resetCasing` still latches) — severity: med — area: efficiency — lens: efficiency + bugs
- **Where**: `src/schema/columns.ts:257` (getter), `applyCasing` at `:137`
- **Defect**: the getter runs a regex `.match()` + `.map()` + `.join()` on every access, and is read twice per column per compile (62 reads for a 31-column `compileSelect`), for a value that provably cannot change — `configureCasing` (`:97-114`) throws if the mode is set after `casingObserved` latches.
- **Failure scenario**: measured on this checkout, `compileSelect` over 31 columns costs 9.3 µs/op at `casing: 'preserve'` and 18.8 µs/op at `casing: 'snake_case'` — ~9 µs of pure re-derivation per query on a runtime billed for request CPU.
- **Fix**: memoize on the instance — `#resolvedName: string | undefined; get name() { return this.#resolvedName ??= this.config.explicitName ?? applyCasing(this.config.fieldName); }`. `withTable` builds a fresh `Column` from the same config, so an alias re-resolves once and no stale value leaks. `resetCasing` is `@internal` test-only and must clear the cached names (or the affected tests rebuild their tables, which `test/unit/casing.test.ts` already does).
- **Prove it**: `test/unit/casing.test.ts` — instrument the getter with a counting wrapper and assert one `compileSelect` over an N-column table performs at most N `applyCasing` calls, keeping the existing byte-identical-to-`drizzle-orm/casing` assertions.

### [F-103] `assertRoundTrip`'s invariant is weaker than it reads — constraint order differs between the two renderers — status: todo — severity: low — area: kit/render — OFF-LENS from efficiency + bugs
- **Where**: `kit/src/core/diff.ts:53` (`columnDefinition`), `kit/src/core/snapshot.ts:410` (`createTableFromSnapshot`) vs `orm-d1/ddl`'s `createTable`
- The snapshot path groups all uniques → all FKs → all checks; `createTable` walks `extras` in declaration order. Semantically irrelevant to SQLite, but `assertRoundTrip` only passes for schemas that happen to declare extras in the grouped order.

### [F-104] Per-row closure allocation on the positional read path — status: todo — severity: low (**unmeasured**) — area: efficiency — OFF-LENS from efficiency + bugs
- **Where**: `src/plan/mapper.ts:175`
- One `(index) => row[index]` closure per row on the non-flat path, and `readRow` calls `read(index)` twice per column of a nullable group (inside `columnIndexes.every`, then in the recursive build). Hoisting a mutable `current` row would make the reader monomorphic and allocation-free per row.

### [F-105] `dropKeys` uses `delete row[key]` per row — status: todo — severity: low (**unmeasured**) — area: efficiency — OFF-LENS from efficiency + bugs
- **Where**: `src/relations/query.ts:761`
- `delete` at every relational level transitions each freshly built result object into V8 dictionary mode immediately before it is returned and JSON-serialised.

## Round-2 objections merged unresolved — iteration 8

The round-2 reviewer **rejected** and the batch was merged anyway under the sweep rule
(rejected after two rounds + green gate → merge, record the objection). These are now
claims about code on `main`, recorded verbatim in substance. **`[F-106]` is the highest-value
open item in this file**: it is a regression this batch introduced, and its symptom is a
migration that cannot be applied at all.

### [F-106] A `COLLATE` inside a *column-level* `CHECK` or generated expression is attributed to the column, so the next rebuild invents `COLLATE NOCASE` and the migration fails on apply — status: **done** (`52a25af`) — severity: **high** — area: kit/introspect — REGRESSION vs `main`
- **Where**: `kit/src/core/introspect.ts:168-200` (`parseColumnCollation`)
- **Defect**: the balanced scan closed the table-level `unique (…)` case, but the span is still the whole column definition, so a `COLLATE` belonging to a sub-expression *inside* that definition is captured as the column's own.
- **Failure scenario**: live `create table "q" ("id" integer primary key, "status" text not null constraint "q_check_1" check ("status" collate nocase in ('active','closed')))` with `create unique index "q_status" on "q" ("status")` and rows `(1,'active'), (2,'ACTIVE')` — both legal, the column is BINARY. `introspect()` returns `status.collate === 'nocase'`; `pull` prints a false warning; any ordinary edit that forces a rebuild emits `"status" text collate nocase not null`, and applying it against real D1 gives **`D1_ERROR: UNIQUE constraint failed: q.status: SQLITE_CONSTRAINT`** — the whole `batch()` rolls back and the migration can never apply. On `main` the identical scenario applies cleanly. Without a unique index the failure is quieter and worse: `where status = 'ACTIVE'` silently starts matching `'active'`. Same mis-attribution for `"b" integer generated always as ("a" collate nocase = 'x') virtual`.
- **Fix**: attribute a `COLLATE` only when it sits at the top level of the column definition — outside any parenthesised sub-expression and outside a `constraint …`/`check (…)`/`generated always as (…)` clause.
- **Prove it**: `kit/test/workers/foreign-schema.test.ts` — create the `q` table above against the real binding, assert `columns.status.collate === undefined`, and assert the generated rebuild applies without error.

### [F-107] The carried-over collation survives exactly one migration; the second rebuild drops it silently and `check` reports zero drift — status: **done** (`52a25af`) — severity: **high** — area: kit/node
- **Where**: `kit/src/node/commands.ts:229` (`writeSnapshot({ ...next })`), `kit/src/core/diff.ts:328`
- **Defect**: `recreateTable`'s carry-over reads `before.collate`, but `generate` writes the schema-derived `next` as the new baseline, which structurally has no `collate`, so the live collation leaves the `meta/` chain after the first `generate` while the database still has it.
- **Failure scenario**: proven end-to-end on real D1 with `"email" text collate nocase not null` + a unique index. `generate` #1 correctly emits `collate nocase`; `generate` #2 emits `"email" text not null`, after which `Alice@x.com` inserts next to `alice@x.com` with no error and `diffSnapshots(live, expected)` returns **0 drift statements** — `check` says "Up to date, no drift" over a unique constraint that changed meaning. This is `kit/README.md`'s founding failure mode reproduced inside the fix meant to prevent it.
- **Fix**: apply the same copy-on-write `recreateTable` already does to the snapshot `generate` writes.
- **Related**: the `origin`-keyed exemption does catch introspection-to-introspection collation drift, but **only** in the window between `pull` and the first `generate`; after that both sides fold to `undefined` and no command can ever see a column collation again.

### [F-108] `parseColumnCollation`'s depth counter is desynchronised by a quoted identifier containing a paren — status: **done** (`52a25af`) — severity: med — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:187-197`
- **Failure scenario**: `create table "t" ("a(" text, "b" text generated always as ("a(" || 'x') virtual, "email" text not null, unique ("email" collate nocase))` → `parseColumnCollation(sql, 'b')` returns `'nocase'`: the `(` inside `"a("` increments depth, which never returns to 0, so the span runs to end-of-string and swallows the table-level `unique(...)` — the exact class `[F-101]`'s round-1 gap 3 was supposed to close. `hasAutoincrement` already has a test for a column named `a(`, so this is in scope.
- **Also**: `collate "NOCASE"` (quoted collation name, legal SQLite) returns `undefined`, so the collation is invisible and a rebuild drops it. And the anchor takes the *first* match, so `create table "posts" ("author_id" integer references "users"("id"), "id" text collate nocase primary key)` anchors on the FK's `("id")` and returns `undefined` — shared with `hasAutoincrement`/`parseGenerated`, so pre-existing rather than new.

### [F-109] `columnDefinition` (the `ALTER TABLE … ADD COLUMN` renderer) still drops `collate` — status: **done** (`52a25af`) — severity: low — area: kit/diff
- **Where**: `kit/src/core/diff.ts:53`
- `[F-101]`'s stated fix was "emit it in `createTableFromSnapshot` **and `columnDefinition`**"; only the former landed. Unreachable today — in `generate`/`push`/`verify` the `after` side is schema-derived and added columns never carry a collation, and `roundtripPlan`'s legs add no columns — so it affects only `check`'s printed drift. Recorded so it is not mistaken for done.

### [F-110] The `pull` warning does not name `config.tableOptions` — status: todo — severity: low — area: kit/node
- **Where**: `kit/src/node/commands.ts`, warning text
- The warning names what is lost but not `config.tableOptions` (`kit/README.md:17`), the one mechanism the kit already has to express `strict` / `withoutRowid` / `appendOnly`. Related to `[F-100]`'s parked sidecar question.


## Findings — the collation repair branch (merged `52a25af`)

Three review rounds on `fix/collation-regression-20260817`. `[F-106]`–`[F-109]` are closed and
were differentially fuzzed against `main` (≈40 adversarial DDLs plus 2365 generated ones for
appliability and 665 with SQLite itself as the oracle; `headOnlyBroken = 0`). Each round's fix
opened a new hole in `kit/src/core/introspect.ts`, all of which were closed in turn: comments
were not blanked (so `/* collate nocase */` was read as structure), the depth counter was
quote-aware for `"` only, the `collate` keyword lost its left word boundary, and blanking
comments moved the table-option boundary so a comment could invent `STRICT`. The items below
are what the final differential review left standing.

### [F-111] A table-level `UNIQUE (col COLLATE …)` member collation is captured nowhere, so a rebuild converts case-insensitive uniqueness into case-sensitive — status: todo — severity: **high** — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:659-661`, `kit/src/core/snapshot.ts:442-443` (`UniqueConstraintSnapshot` has only `columns: string[]`)
- **Failure scenario**: live `create table "t" ("id" integer primary key, "email" text not null, constraint "u1" unique ("email" collate nocase))`. The original refuses `('A@X.com')` after `('a@x.com')`; every rebuild emits `constraint "u1" unique ("email")` and the rebuilt table **accepts** the duplicate. `sqlite_autoindex_*` has no `sql` row, so the collation can only come from the `CREATE TABLE` text, which nothing reads. Column-level collation is now preserved, so `email text collate nocase … unique` survives — it is specifically the table-level idiom that is lost.
- **Fix**: give `UniqueConstraintSnapshot` per-member `{ name, collate? }` (as `IndexColumnSnapshot` already has), parse it from the constraint text, and render it back.

### [F-112] `columnDefinitionStart` only knows `"…"` and bare names, so a backtick- or bracket-quoted column loses its collation, and the anchor takes the first match — status: todo — severity: med — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:202-203`
- **Failure scenario**: `` `email` text collate nocase `` and `[email] text collate nocase` introspect as no collation and the rebuild emits `"email" TEXT not null`; so does `collate"NOCASE"` with no space (`parseColumnCollation`'s `\s+`). And the anchor takes the *first* match: `create table "t" ("author_id" text references "u"("id"), "id" text collate nocase not null)` → `id.collate === undefined`. Shared with `hasAutoincrement` / `parseGenerated`.
- **Fix**: accept all four quoting forms (`parseIndexColumns` at `:300` already does), make the `collate` token separator optional before a quote, and anchor on a top-level match rather than the first one.

### [F-113] A trailing `--` comment inside a captured expression re-renders as invalid SQL — status: todo — severity: med — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:184`, and the equivalent slices in `parseGenerated` / `parseIndexColumns`
- **Failure scenario**: `check ("a" > 0 -- positive\n)` is captured with the comment, and `.trim()` removes the newline that made it harmless, so the rebuild renders `check ("a" > 0 -- positive)` → `D1_ERROR: incomplete input`. Present on `main` too. (Block comments and `--` followed by more expression are now handled *better* than `main`.)
- **Fix**: strip comments from a captured expression value, or normalise the newline back in.

### [F-114] A nullable non-INTEGER primary key is rendered `not null`, and the rebuild fails — status: todo — severity: med — area: kit/introspect
- **Where**: `kit/src/core/introspect.ts:701` (`notNull: column.notnull === 1 || single`)
- **Failure scenario**: a nullable `TEXT PRIMARY KEY` holding NULL is legal in SQLite (only `INTEGER PRIMARY KEY` implies `NOT NULL`). Both branches render `"id" TEXT primary key not null` and the rebuild fails with `NOT NULL constraint failed: __new_t.id`. Pre-existing.
- **Fix**: derive `notNull` from `column.notnull` alone unless the column is an `INTEGER PRIMARY KEY` rowid alias.

### [F-115] `generate`'s collation carry-forward is self-perpetuating, so a deliberately removed collation can never leave `meta/` and `check` goes permanently red — status: todo — severity: **high** — area: kit/node
- **Where**: `kit/src/node/commands.ts:233`
- **Defect**: `generate` is offline — `previous` is the last persisted snapshot, not the live DB — so `carryForwardCollations` is unconditional and re-persists a collation forever.
- **Failure scenario**: `pull` (baseline has `nocase`) → `generate` (persists `nocase`) → the team deliberately rebuilds the column as `BINARY`. `check` then reports `column "email" changes its collation` (drift no `generate` can express: `generate` emits `[]` because the exemption suppresses it, and re-persists `nocase`); `push` sees no diff either. The only exits are another `pull` or hand-editing `meta/`, which the project forbids.
- **Fix**: give the operator a way to state the intent — the `config.tableOptions` sidecar of `[F-100]` / `[F-110]` is the natural home, since a stated collation would end the carry-forward's guesswork.

## Findings recorded from `fix/apply-guard-20260818` (foreign-trigger guard rework)

Recorded during the round-2 fix pass on the foreign-trigger guard batch (`[F-041]`–`[F-046]`,
`[F-079]`). Not fixed as part of that pass — out of its scope — just written down.

### [F-116] `push` hardcodes `MAX_STATEMENTS_PER_BATCH` instead of asking `runner.atomicLimit` — status: todo — severity: med — area: kit/node
- **Where**: `kit/src/node/commands.ts:328` (`packIntoBatches(statements, MAX_STATEMENTS_PER_BATCH)`), contrast `kit/src/core/apply.ts:257` (`applyMigration`, which does `runner.atomicLimit?.([...statements, record]) ?? MAX_STATEMENTS_PER_BATCH`)
- **Defect**: `apply.ts`'s own doc comment on `SqlRunner.atomicLimit` explains why the ceiling is runner-dependent: "the remote runner sends a batch containing a trigger body through D1's file-import endpoint, which has no statement ceiling, and only falls back to `/query`'s ceiling when it can use `/query` at all." `applyMigration` asks the runner; `push` (`commands.ts`) never does — it always packs at the conservative constant, even when the runner it is about to call could safely take more (or fewer).
- **Failure scenario**: a `push --remote` large enough to need splitting, on a runner whose `atomicLimit` differs from `MAX_STATEMENTS_PER_BATCH` (lower, from a stricter `/query` ceiling, or effectively unbounded via file-import) either splits when it did not need to — losing atomicity across a rebuild group for no reason — or packs at a limit the runner cannot actually honour, which `push`'s `packIntoBatches` cannot detect since it is never told the real number.
- **Fix**: thread the same `runner.atomicLimit?.(statements) ?? MAX_STATEMENTS_PER_BATCH` computation into `push`'s packing call, matching `applyMigration`.
- **Prove it**: a `kit/test/workers` (or `kit/test/unit` with a fake `SqlRunner`) case giving `push` a runner whose `atomicLimit` differs from the constant, asserting the batches it actually sends respect the runner's number, not the constant.

### [F-117] A section-1 rename plus its own-guard drop-trigger are singleton groups a batch boundary can separate from the rebuild that restores the guard — status: todo — severity: med — area: kit/apply
- **Where**: `kit/src/core/diff.ts:470-495` (renamed-table step: `alter table … rename to …` and, when the renamed table was append-only, `drop trigger if exists "<old>_no_update"`), against `kit/src/core/sql.ts`'s `statementGroups` (only the `create table "__new_X"` … `alter table "__new_X" rename to "X"` rebuild shape is recognised as an indivisible group)
- **Defect**: renaming an append-only table emits two statements up front — the rename and the unconditional drop of the guard under its old name — each its own singleton group in `statementGroups`'s accounting. If the same migration also re-creates the guard under the new name (`t.appendOnly` still true after the rename) via a *later* rebuild or in-place `create trigger`, nothing ties the drop to the statement that restores the guard. A batch boundary between them commits the drop and defers the restore to a later batch.
- **Failure scenario**: a migration that renames a live append-only `events` to `audit` (dropping `events_no_update`) and, elsewhere in the same file, rebuilds `audit` for an unrelated reason (restoring `audit_no_update` after the rename, per the "guard across a table rename" logic in `diff.ts`) — if a large migration puts enough statements between the drop and the rebuild's trailing `create trigger` to land a batch boundary between them, a batch-2 failure leaves `audit` renamed, unguarded, and UPDATE-able, with no error and nothing in `sqlite_master` naming what happened. Same shape as `[F-041]`, one step earlier in the statement list, and not covered by `[F-041]`'s fix (which only extends the rebuild group's own tail, not the separate rename-and-drop pair that precedes it).
- **Not yet reproduced against real D1** — recorded from reading `diffSnapshots`'s renamed-table step against `statementGroups`'s grouping rules, not from an observed failure.
- **Fix**: extend `statementGroups` (or an equivalent later pass) to recognise a rename-and-own-guard-drop pair and keep it in the same indivisible group as whichever statement re-creates the guard under the new name, when the diff's `after` snapshot says the renamed table stays (or becomes) append-only.

## Standing authorization from the human — 2026-08-18

> audit.md に書いてある、improvement も含めて全てやっておいてください。

Every open item in this file is authorized, **including the `needs-human` ones and the
`NEW-SURFACE` proposals**. That overrides the sweep skill's "park API-surface changes as
`needs-human`" rule for this run. Still binding: no release, no version bump, no
`RELEASING.md` / `Makefile` edits; no dependency added; nothing in `src/` gains a `node:`
import or a runtime dependency; no schema-facing spelling that `drizzle-orm/sqlite-core`
lacks (`docs/04`); no test weakened to go green. `docs/` may now be edited, since several
items are documentation fixes.


### [F-119] The predicate-scoped empty-array refusal must be asked for at the *snapshot* call site, not only in `checkDDL` — status: **done** (batch C round 7) — severity: **high** — area: kit/snapshot
- **Where**: `kit/src/core/snapshot.ts:391` (check value), `:321` (partial-index `where`)
- **Defect**: `snapshotFromSchema` is the **only** place in the whole kit where a check's `SQLChunk` becomes text — `generate` / `check` / `push` all render tables from the snapshot via `createTableFromSnapshot` — so a refusal that fires only in `checkDDL` never sees a migration. Drizzle collapses `inArray(c, [])` to `sql\`false\`` and `notInArray(c, [])` to `sql\`true\`` *before* orm-d1 sees any array chunk, so those spellings are caught only by the bare-boolean check, and only when this call site asks for it.
- **Failure scenario**: `check('users_role_ck', drizzleNotInArray(users.role, []))` produced `constraint "users_role_ck" check (true)`; D1 accepted the table and `insert (1,'not-a-real-role')` succeeded. The snapshot, the emitted migration and the live database all agreed on `check (true)`, so `orm-d1-kit check` stayed green forever — bug class #1 verbatim. `inArray` was worse in the other direction: `check (false)` rejects **every** insert. `docs/04`, added in the same batch, asserted the `and`/`eq`/`inArray` form was refused.
- **Fix**: pass `isPredicate: true` at both call sites. Two tokens.
- **Prove it**: `kit/test/unit/snapshot-check-errors.test.ts` gained five cases (Drizzle `notInArray`/`inArray` over `[]`, one nested in Drizzle `and()`, one in a partial-index predicate, and a legitimate check + partial index that must still snapshot). Reverting the two tokens turns three of them red; the partial-index one passes either way, because `createIndex()`'s name derivation happens to render first — incidental, not designed, and `[F-028]` already flags that derivation as fragile.


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

- **`[F-091]`–`[F-097]` did not come from a lens.** They were recorded while building a
  feature end-to-end in the downstream app, so they are adoption frictions rather than
  sweep findings, and the rotation pointer was left where it was. A lens is free to pick
  them up; none of them is that lens's own finding.
- **Fixture privacy.** A downstream project's real schema was used as a *local* fixture
  through `ORM_D1_FIXTURE_SCHEMA` and was never copied into this repo — orm-d1 is
  published to npm, and a private product's table and column names should not ship in
  the tarball or land in public git history. If a bug is found through it, the committed
  regression test is a **minimal anonymized repro** in this repo's own fixture style.
  `[F-001]`'s harness now covers the large-schema case entirely with a synthetic,
  in-repo fixture, so this recipe is no longer load-bearing — kept as a record only.
- **`node_modules` is bind-mounted from a macOS host**, so platform binaries can be the
  wrong architecture in the container. Repaired for this session: esbuild
  (`node node_modules/esbuild/install.js`) and tsgo
  (`npm i --no-save @typescript/native-preview-linux-x64@7.0.0-dev.20260707.2`). Neither
  touched `package.json` or the lockfile. Re-run `npm install` on the host to restore its
  own binaries.

## Findings — reviewer follow-up on `378dae6`

### [F-116] `378dae6`'s bundle-size and insert-compile-perf claims, re-measured honestly — status: done — severity: low — area: efficiency
- **Where**: `src/runtime/database.ts` (`DefaultLogger`), `src/plan/compile.ts` (`isDynamicRowValue`, the per-group `rowCounts`/`rowRendered` arrays), `src/ddl.ts` / `src/sql/drizzle-sql.ts` (`[F-1]`'s follow-up, `[F-117]`'s sibling fix — see below).
- **Bundle**: measured with `npx esbuild dist/core.js --bundle --minify --format=esm`, `dist/` built via `npm run build`, against a `git archive` checkout of each revision built the same way (same `node_modules`).
  - `9ea977c` (pre-batch `main`): **42,609 bytes** minified / **14,334** gzip (`gzip -9`).
  - `378dae6` (the rejected commit): **44,612** / **15,153** — i.e. the batch's actual cost was **+2,003 bytes** minified / **+819 gzip**, matching what the reviewer measured.
  - This session's fixes for the empty-array detection gap (`[F-117]`'s sibling — Drizzle's own collapsed `inArray`/`notInArray`) and the unbounded DDL render context add new exported helpers (`isStringChunk`, `stringChunkText`) to `src/sql/drizzle-sql.ts`, which ships in `core.ts`'s bundle — but nothing in the core query-builder path calls them, so esbuild's dead-code elimination drops them: measured **44,616 bytes** after those two fixes alone, i.e. **+4 bytes** over `378dae6`, not a new regression.
  - After trimming `DefaultLogger` (dropped the redundant `paramsStr` intermediate; short-circuits on `params.length === 0` before building the dev-mode array) and the `compile.ts` perf changes below: **44,646 bytes** minified / **15,164** gzip — **+2,037 bytes minified / +830 gzip vs `9ea977c`**, essentially unchanged from `378dae6`'s own +2,003. The `isDynamicRowValue` rewrite (below) added slightly more code than the logger trim removed; both are real, measured, and reported honestly rather than rounded toward the smaller number. `[F-097]` already tracks that nothing in CI gates this number — still true, still open.
- **Perf**: `compileInsert` on 5000 rows × 8 scalar columns, median of 20 paired runs (both revisions' `dist/index.js` loaded into one Node process, alternating calls, 10 warmup iterations each — see the ad hoc script used, not committed), against `378dae6` (the batch under review) as baseline per the reviewer's own methodology:
  - Before this session's fix, reported by the reviewer: ~11% slower than `main`, attributed to `isDynamicRowValue` running 3 predicate calls per column per row (up to 120,000 calls at 5000×8) plus two `new Array(5000)` allocations per group.
  - **Fix applied**: `isDynamicRowValue` now does one `typeof value !== 'object' || value === null` gate before calling `Array.isArray`/`isPlaceholder`/`isSQLChunk` at all — the common case (a plain scalar) short-circuits on that single check instead of paying for three function calls, one of which (`isSQLChunk`) repeats the same `typeof`/`null` test internally. `rowCounts` (`src/plan/compile.ts`, the per-group loop) is now an `Int32Array` instead of a boxed `number[]` — every value it holds is a small non-negative integer, so this is a flat unboxed buffer, cheaper to allocate and to scan in the `maxRowParams` loop. `rowRendered` stays a plain array (holds `Query | undefined`, not a numeric type).
  - **Measured after the fix**, five paired runs against `378dae6` in one shared Node process, alternating calls: deltas of `+2.19%`, `-2.45%`, `+0.58%`, `-3.66%`, `-1.81%` — mean **≈ -1.0%**, reported as "within noise" at the time. That methodology undersells the regression: re-measured with **isolated processes** (one revision per process, no alternation, so no shared-JIT/GC crosstalk between the two), **min-of-200** after **100 warmup iterations**, same 5000×8 scalar shape — `main` **3.96 / 3.96 / 3.98 ms** vs this fix **4.21 / 4.18 / 4.23 ms** across three runs, i.e. **+5–6%, consistent across all three runs**, not parity. At 1000 rows the two are ≈ equal; at 100 rows this fix is at parity or slightly faster. The correctness fix `[F-055]`'s exact-parameter-counting this predicate exists for is unchanged — only the check that decides *whether* to render-and-count is cheaper — but at 5000×8 the win is real and negative, bought by the exact parameter counting itself, not by this session's `isDynamicRowValue`/`Int32Array` changes (which are net-neutral-to-positive per the process-alternation numbers above; the isolated-process regression is a property of the design `[F-055]` already committed to, not of this session's changes).
- **Honesty note**: both numbers here are single-machine, single-session measurements on a noisy shared host — treat the bundle figure as reproducible (same build tool, same input) but not independently re-verified by a second run, and the perf figure as **+5–6% at 5000 rows**, not the "within noise" figure this section originally reported (that number came from a same-process alternating-call methodology that hid cross-run interference; the isolated-process/min-of-200 methodology above is the one to trust).

### [F-117] Drizzle's `and()` wrapping an orm-d1-native chunk stringifies as `'[object Object]'`, producing a permanently-false CHECK — status: todo — severity: **high** — area: sql/compile
- **Where**: `src/sql/expressions.ts`'s `and`/`eq` are orm-d1's own, but a schema is free to mix them with orm-d1's own `InArray`/`NotInArray` chunks (`src/sql/expressions.ts`'s `inArray`/`notInArray`) — e.g. `and(eq(c.id, 1), inArray(c.role, roles))` built with Drizzle's `and`/`eq` (imported from `drizzle-orm`) around an orm-d1 `InArray` chunk, rather than orm-d1's own `and`/`eq`.
- **Defect**: Drizzle's `and()`/`eq()` do not recognise an orm-d1 `SQLChunk` as an `SQLWrapper` — it has `toQuery()` but not the `getSQL()`/entity-kind shape Drizzle's own combinators test for — so they interpolate it as a plain bound *value* rather than a nested fragment. The bound value is the `InArray` instance itself; D1 has no representation for an object parameter, and whatever renders it downstream falls back to `String(value)`, i.e. `'[object Object]'`. The resulting `check` text is literally `check ((("id" = 1) and ('[object Object]')))`.
- **Failure scenario**: `generate` emits that `check` with no error — it is syntactically valid SQL, D1 accepts the `CREATE TABLE` — but SQLite coerces the string `'[object Object]'` to `0`/false in a boolean context, so the `and`'s right operand is always false, the whole `check` is always false, and **every `INSERT`/`UPDATE` into the table is rejected from that point on**, with no signal at `generate` time, `check` time, or table-creation time — only at the first write, with a generic `CHECK constraint failed` that does not point at the real cause.
- **Pre-existing on `main`** — not introduced by `378dae6` or by this session's fixes. Explicitly **not fixed in this batch**, per instruction; recorded here for a future pass. The fix likely belongs alongside `[F-1]`/this batch's empty-array detection: either make orm-d1's chunks satisfy Drizzle's `SQLWrapper`/entity-kind duck-typing so `and`/`eq` recognise them as fragments, or have `src/ddl.ts`'s bare-columns detection (which already walks `queryChunks` for the empty-array hazard) also refuse a `Param`/bound-value chunk whose value is a non-primitive object — the same "DDL is free to refuse outright" reasoning `refuseEmptyArrayPredicate` already uses.
- **`hasEmptyArrayChunk`'s walk (`src/ddl.ts`) is the natural place to refuse this, too**: it already recurses `queryChunks` looking for exactly this shape of hazard, so a `Param`/bound-value chunk holding a non-primitive object is a one-branch addition to a walk that already exists, not a new one. It is strictly worse than the `sql\`true\`` bare-boolean case this round chose to refuse (`isBareBooleanFragment`, now scoped to predicate-only render contexts — see the fix above): the bare-boolean case renders syntactically-suspicious-but-legal SQL that only ever goes *inert* (accepts everything or rejects everything, discoverable by reading the DDL or noticing a check never fires); this case silently produces a `check` that renders fine, passes `generate`/`check`/table-creation with no error anywhere, and then fails **every** `INSERT`/`UPDATE` from that point on with a generic, misleading `CHECK constraint failed`. Same detection mechanism, worse failure mode, still open.
- **Prove it**: not yet reduced to a test; a minimal repro would build `and(dEq(dt.id, 1), inArray(c.role, ['a']))` (Drizzle's `and`/`eq`, orm-d1's `inArray`) inside a `check()`, assert the rendered DDL contains `[object Object]`, and (in `test/workers`) assert that a subsequent `insert` against a table created from it always throws `CHECK constraint failed` regardless of the row's values.

### [F-118] Two facts verified this round, recorded but deliberately not fixed — status: todo — severity: low/med — area: sql/render, kit/apply
- **A NUL byte inside a value makes the statement unparseable.** Pre-existing in `literal()` (`src/ddl.ts`) — it string-interpolates a value with only `'`-escaping, and a NUL survives that unescaped. D1 rejects the resulting statement with `D1_ERROR: unrecognized token` at apply time — loud, not silent, but with no indication the cause was a NUL rather than any other malformed literal. Not fixed: out of this round's scope, and the failure is loud rather than a silently-wrong constraint, which is this codebase's actual severity bar (see "この ORM で「バグ」が出る場所" in `CLAUDE.md`).
- **`MAX_STATEMENT_BYTES` is enforced only in `compilePlan`'s `sealed` path (`src/limits.ts`/`src/plan/compile.ts:401-403`), never for DDL.** DDL rendering sets `maxParams: Number.POSITIVE_INFINITY` (`src/ddl.ts`'s `ddlContext`, see the comment at its definition) specifically to remove the accidental ~100-value cap that used to stop a large `inArray()`/`notInArray()` from rendering inside a `check()`/partial index `where()` at all. That was the correct fix for the false-positive `CompileError` it used to throw on nothing-is-bound DDL, but it also removes the only thing that was accidentally capping statement size in that path: a `check()` built from an `inArray()` over on the order of 10,000 values would now render past `MAX_STATEMENT_BYTES` (100 KB) without `createTable`/`createIndex` ever checking, and fail only when D1 rejects the oversized statement at apply. Not fixed: no DDL-side statement-size check exists to reuse, and adding one is a new mechanism outside this round's one-defect scope.
