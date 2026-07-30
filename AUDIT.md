# AUDIT.md — correctness / efficiency sweep

Working state for the `/audit-sweep` loop. Machine-written, human-editable — reorder,
delete, or re-rank anything here and the next iteration will follow it.

Gate: `npm run check` (typecheck → build → test → typecheck:kit → build:kit).
Baseline at sweep start: **green, 565 passed / 4 skipped**.

## Rotation

One lens per iteration, rotating `feature` → `efficiency + bugs` → `security` → repeat.
Advanced in every terminal case, including blocked and nothing-found, so a lens that keeps
failing cannot starve the other two.

- Next lens: **feature**
- Last ran: _(nothing yet — first iteration under the rotating scheme)_

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
