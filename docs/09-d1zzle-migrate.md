# 09 — d1zzle-migrate (CLI)

A separate package, `d1zzle-migrate`, installed as a **devDependency**. It runs in Node, may
use dependencies freely, and contributes **zero bytes** to the Worker bundle. That
separation is what lets it be generous where the runtime must be austere.

## Why it exists

`drizzle-kit`'s D1 support is the weakest link in the Drizzle-on-Workers story. The
recurring problems, and what this design does about each:

| Problem | Response |
| --- | --- |
| SQLite cannot `ALTER TABLE` most changes; generated migrations are often incomplete or destructive | Implement the full 12-step table-recreation procedure correctly, and mark every destructive step explicitly |
| Migrations are not atomic on D1 (no interactive transactions) | Apply each migration as a single `batch()`, which **is** atomic |
| `push` against remote D1 behaves inconsistently vs. local | One code path over the D1 HTTP API; `--local` targets the Miniflare sqlite file |
| Drift between local `.wrangler` state and remote | A first-class `check` command that diffs live introspection against the snapshot |
| Wrangler's own migration table and layout are separate and can desync | Emit migrations in `wrangler d1 migrations` layout so both appliers agree |

## Structure

The package splits in two, and the split is load-bearing:

```
kit/src/
  core/        pure: snapshot, diff, introspect, journal, sql splitting, apply
  node/        config, filesystem, the local and remote runners, the commands
  cli.ts       argument parsing and exit codes
```

`core/` has no Node builtins and no filesystem — it talks to a database through a
four-line `SqlRunner` interface. That is what lets the migration engine be tested **inside
workerd against a real D1 database** (`kit/test/workers/`) rather than against a
Node-shaped SQLite that behaves differently. It is also what keeps the local and remote
appliers from drifting: they are two implementations of the same interface, and every
command is written against it.

## Command surface

Deliberately mirrors `drizzle-kit`, so existing muscle memory and CI scripts transfer.

```
d1zzle-migrate generate      # diff schema against last snapshot → new SQL migration
d1zzle-migrate migrate       # apply pending migrations (--local | --remote) (--env <name>)
d1zzle-migrate push          # diff and apply directly, no migration file (dev only)
d1zzle-migrate pull          # introspect a live database → schema.ts + snapshot
d1zzle-migrate check         # detect drift and unapplied migrations; exit non-zero in CI
d1zzle-migrate verify        # replay every migration into an empty DB and compare with the
                             #   schema; needs no database, so it belongs in CI
d1zzle-migrate up            # upgrade snapshot format after a kit version bump
```

`studio` is **not implemented natively** — see [Studio](#studio) below for how users get a
data browser without us building one.

## Configuration

```ts
// d1zzle.config.ts
import { defineConfig } from 'd1zzle-migrate';

export default defineConfig({
  schema: './src/schema.ts',
  tableOptions: './src/table-options.ts',   // optional; see below
  out: './migrations',              // wrangler-compatible layout
  d1: {
    env: 'stg',                     // optional; a wrangler [env.<name>] block
    databaseName: 'my-db',          // resolved from wrangler.jsonc when omitted
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    localFile: './.dev.db',         // optional; skips .wrangler discovery for --local
  },
});
```

`tableOptions` points at a module whose default export is `tableOptions([...])` from
`d1zzle/ddl` — per-table `STRICT`, `WITHOUT ROWID` and `appendOnly`. It is a separate
module rather than part of the schema on purpose: none of the three has a spelling in
`drizzle-orm/sqlite-core`, and doc 08 keeps the schema DSL a strict subset of it so a
schema file stays reverse-aliasable. Tables are named by *object*, not by string, so a
rename is a type error.

`d1.localFile` names an explicit SQLite file for `--local` instead of discovering one under
`.wrangler/state` — for projects whose dev server and tests run in Node against a plain
file through a D1-shaped adapter.

Reading `wrangler.jsonc` for the binding and database id by default matters more than it
sounds: duplicated database configuration is a common source of "applied to the wrong
database" incidents.

### Environments

Most real projects keep their databases in wrangler's named-environment blocks —
`[[env.stg.d1_databases]]` in TOML, `env: { stg: { d1_databases } }` in JSON — with the
top-level block holding a local placeholder. Reading only the top-level block therefore had
the tool confidently applying `--remote` migrations to whatever the *local* entry named,
while `wrangler --env stg` deployed against something else entirely. That is the incident
class this whole file exists to prevent, so both spellings are parsed and the environment is
selected the way wrangler selects it: `--env <name>`, then `CLOUDFLARE_ENV`, then `d1.env` in
the config, then the top-level block.

Two decisions follow from wrangler's actual inheritance rules, which were read out of
wrangler 4's own `normalizeAndValidateEnvironment` rather than assumed:

- **`d1_databases` is non-inheritable.** An environment that declares none gets *no* binding
  from wrangler — only a warning. The faithful translation for a tool that writes to
  databases is an **error**: a missing `env.<name>` block, or one without `d1_databases`,
  stops the run. Silently resolving the top-level block instead would be the exact
  wrong-database bug, and a warning is not enough when the consequence is an irreversible
  write and the reader is CI.
- **`account_id` is inheritable**, so it falls back to the top level. **`migrations_dir` is a
  property of each `d1_databases` entry**, not a top-level key, so it is read from the
  binding (the old top-level read is kept only so existing projects do not move).

`CLOUDFLARE_ENV` disagreeing with `d1.env` is an error too. Wrangler has no `d1.env`, so
there is no wrangler behaviour to mirror, and there is no defensible silent winner between a
committed default and the deploy job's own variable.

### Values, and where they come from

One rule everywhere: **`d1zzle.config.ts` > environment variable > wrangler config.** The
config file is first because a value written there is a deliberate per-repo decision, and it
restricts nobody — it can read `process.env` itself. `CLOUDFLARE_D1_DATABASE_ID` joins
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, which is what lets a project that treats
the id as a secret keep a placeholder in `wrangler.toml` and never rewrite the file just to
migrate.

**`${VAR}` interpolation of wrangler values was deliberately not implemented.** Wrangler does
not interpolate its own config — verified: `parseTOML` is a bare parse, and `dotenv-expand`
is applied only to `.env`/`.dev.vars`. A d1zzle that interpolated would read a *different*
value than wrangler from the same line, which is a fresh instance of exactly the drift this
change removes. A `database_id` still holding a `__PLACEHOLDER__`, or the local sentinel
`"local"`, is rejected up front on `--remote` instead of becoming an unexplained API 404.

Every command that touches a database prints the environment, binding, database name and —
for `--remote` — the id and account, each with the source it was read from, before it acts.
The id is masked to its last four characters: enough to tell staging from production in a CI
log months later, without the tool printing into that log an id the project deliberately
kept out of git.

## How `generate` works

1. **Load the schema.** Import the TS file directly — Node runs TypeScript, so no worker
   thread and no bundler is involved — and read the metadata our `table()` already records.
   No parsing, no AST work: the schema is a value.

   One wrinkle worth recording, because it costs an afternoon to rediscover: a `.ts` file
   in a project **without** `"type": "module"` is loaded by Node as CommonJS, and its
   `import` statements fail. The loader retries via a sibling `.mts` copy, which forces the
   ESM loader while keeping bare and relative specifiers resolving from the project. The
   copy has to be a sibling for that reason.
2. **Build a snapshot.** A normalized JSON description: tables, columns, types,
   nullability, defaults, PKs, FKs, indexes, checks. Written to
   `migrations/meta/NNNN_snapshot.json` with a `_journal.json` index — the same shape
   `drizzle-kit` uses, because it is a reasonable design and it eases porting.
3. **Diff** against the previous snapshot.
4. **Resolve ambiguity.** A dropped column and an added column are indistinguishable from
   a rename in a structural diff. The diff engine accepts explicit `renamedTables` /
   `renamedColumns` and emits `ALTER TABLE … RENAME` instead of drop-and-add.
   **The interactive prompt is not built yet:** today renames are supplied programmatically,
   and anything destructive requires `--accept-data-loss`.
5. **Emit SQL** to `migrations/NNNN_name.sql`, with a comment above every destructive
   statement saying why it is there. Created tables are ordered so a foreign key's target
   exists first.

## The table-recreation procedure

SQLite supports only `ADD COLUMN`, `RENAME COLUMN`, `RENAME TO`, and `DROP COLUMN` (with
restrictions). Everything else — changing a type, adding `NOT NULL`, changing a default,
adding or removing a constraint — requires rebuilding the table. Getting this wrong is the
main way migration tools destroy data.

```sql
CREATE TABLE "__new_users" ( ...new definition... );
INSERT INTO "__new_users" ("id","email") SELECT "id","email" FROM "users";
DROP TABLE "users";
ALTER TABLE "__new_users" RENAME TO "users";
-- recreate indexes, triggers, and views that referenced the table
```

**No `PRAGMA foreign_keys = OFF` — it is not available on D1.** SQLite's own recipe opens
with it, and every portable migration tool emits it, but D1 runs each statement inside an
implicit transaction and `foreign_keys` cannot be changed inside one. `defer_foreign_keys`
*is* accepted, and is what the kit emits, but it is not a substitute: it postpones
constraint checking to the end of the transaction, and it does not suppress
`ON DELETE CASCADE`. The `DROP TABLE "users"` above would therefore delete rows out of
every table that references `users`, silently, before the rename put the table back.

**So a table that any other table references cannot be rebuilt at all.** The kit refuses
the migration at `generate` time and says which tables hold the references, rather than
emitting SQL that destroys data on apply. The way through is to drop the referencing
foreign keys in one migration and rebuild in the next; a migration that does both is
ordered so every dependent loses its reference before the table it points at is rebuilt.

Requirements this places on the implementation:

- **The column list in the `INSERT ... SELECT` must be explicit and computed from the
  intersection of old and new columns.** `SELECT *` is the classic corruption bug.
- **A new `NOT NULL` column with no default cannot be backfilled.** Fail at `generate`
  time with a clear message rather than emitting SQL that fails at apply time.
- **Indexes must be recreated**, since they are dropped with the table.
- **PRAGMA support on D1 is limited.** Verified: `table_info`, `index_list`, `index_info`
  and `foreign_key_list` all work and are what introspection uses. `PRAGMA foreign_keys`
  is emitted around a recreation for parity with plain sqlite3 clients, but it is
  **filtered out before applying**, because D1 rejects it outright (see above); a migration
  is already atomic as one `batch()`. `CHECK` constraints and partial-index predicates have no
  pragma at all and are recovered by parsing `sqlite_master`.

## Applying migrations

Each migration file is split on statement boundaries and submitted as **one `batch()`**,
which D1 executes atomically. This is a real correctness improvement over emitting
`BEGIN`/`COMMIT` that D1 will not honour.

Two constraints follow:

- A migration too large for one batch must be split, and **atomicity is then lost across
  the split**. The CLI warns loudly and names the split point rather than hiding it.
- Applied migrations are tracked in a `d1_migrations` table. Using **wrangler's existing
  table and layout** means `d1zzle-migrate migrate` and `wrangler d1 migrations apply` stay
  interchangeable — teams can adopt the kit without giving up the wrangler workflow, and
  can fall back to it if the kit has a bug. That interoperability is worth more than a
  cleaner bespoke format.

### Statements `/query` cannot carry

`--remote` normally posts the batch to D1's `/query` endpoint. **D1 re-splits that string
on semicolons**, with a splitter that does not know about compound statements — so a
trigger body is cut in half:

```sql
create trigger "t_no_update" before update on "t" begin
  select raise(abort, 't is append-only');   -- /query cuts here
end;
```

and D1 answers `incomplete input: SQLITE_ERROR`. Measured against a real database, this
happens for a whole batch, for a lone `create trigger`, on one line, and with the trailing
semicolon removed — there is no way to phrase it that `/query` accepts, because the
semicolon before `end` is required by SQLite's grammar. `wrangler d1 migrations apply`
fails identically; it is the endpoint, not the client.

This mattered because the kit **generates** those triggers: every `appendOnly` table gets
one. Without a second route, `--remote` could not apply a schema the kit itself produced.

So a batch containing such a statement goes through the **file-import endpoint** instead —
the same four steps wrangler's `d1 execute --file` uses: `init` (announce an md5, get a
presigned URL) → `PUT` the bytes → `ingest` → `poll` until `complete`. Cloudflare rolls the
database back if ingestion fails part-way, so the script stays atomic — including scripts
too large for one `/query` batch.

The routing test is deliberately blunt: `splitStatements` has already stripped statement
terminators, so any surviving `;` is inside a trigger body or a string literal. Both are
safe to send through import; the cost of a false positive is one slower round trip, never
a wrong result.

## `pull` — introspection

Read `sqlite_master` plus the available pragmas, reconstruct the schema, and emit both a
`schema.ts` and a baseline snapshot. This is what makes adoption possible for a database
that already exists.

**Importing `drizzle-kit`'s own history is not implemented.** Adoption starts from a
baseline snapshot of the current database, which is the fallback the open questions below
anticipated. The snapshot format still mirrors drizzle-kit's shape, so the door is open.

What introspection can and cannot recover is worth being precise about, because `check`
compares against it:

| Recovered | How |
| --- | --- |
| Columns, types, nullability, defaults, primary keys | `pragma table_info` |
| Composite primary keys | same, by `pk` ordinal |
| Foreign keys and their actions | `pragma foreign_key_list` |
| Indexes, uniqueness, partial predicates | `pragma index_list` / `index_info` + `sqlite_master` |
| `CHECK` constraints, `AUTOINCREMENT`, generated columns | parsed from the `CREATE TABLE` text |

Column-level `UNIQUE` is reported by SQLite as an index, so it round-trips as a unique
constraint rather than as a column flag. That is a representation difference, not a loss.

## `check` — drift detection

Introspect the live database, build a snapshot from it, and diff against the snapshot the
migrations imply. Reports: unapplied migrations, applied-but-unrecorded changes, and manual
edits made via `wrangler d1 execute`. Exits non-zero, so it belongs in CI.

Drift is the failure mode that actually bites teams — someone runs a manual `ALTER` against
production and the next generated migration is computed from a false baseline.

## Studio

We do not build a data browser. Building one is a large UI surface with little
D1-specific value, and it competes for effort with migrations — the part that is actually
broken. Users get one of two existing options instead.

### Default: the Drizzle Studio browser extension

Drizzle ships a browser extension that adds a Studio tab to the Cloudflare D1 dashboard.
It introspects the **live database** and never loads a schema file, so it is
ORM-agnostic — it works with d1zzle exactly as it works with Drizzle or with raw SQL.

Cost to us: a README section. This is the recommended answer for most users.

Limitation: being schema-agnostic, it shows what is physically in the database. Relation
names, `$type<T>()` brands, and enum narrowing do not surface.

### Opt-in: delegate to `drizzle-kit studio`

Because the schema DSL is source-compatible with Drizzle
([08](./08-drizzle-compatibility.md)), a user's `schema.ts` *is* a valid Drizzle schema
file — the import specifier is the only difference. So `d1zzle-migrate studio` can be a shim:

1. Resolve `d1zzle` → `drizzle-orm/sqlite-core` via a loader alias.
2. Emit a throwaway `drizzle.config.ts` from our own config.
3. Delegate to `drizzle-kit studio`.

The user gets full schema-aware Studio; we maintain almost no code. `drizzle-kit` and
`drizzle-orm` are **optional devDependencies**, resolved only when this command runs, and
contribute nothing to the Worker bundle.

Two things this commits us to:

- **The schema DSL must stay a strict subset of Drizzle's.** Reverse-aliasing works only
  while every symbol a schema file can use also exists in `drizzle-orm/sqlite-core` with
  the same meaning. Any d1zzle-only schema helper breaks it. This is now a standing
  constraint on doc 08, not just a studio concern.
- **Licensing must be verified before shipping this.** Drizzle Studio is Drizzle's
  product with its own terms. Confirm what they permit — particularly around use
  alongside a competing ORM, and around automating a handoff to it from another tool —
  before implementing the delegation. If the terms do not permit it, Path A stands alone
  and nothing is lost.

### Also available

Cloudflare's own D1 console in the dashboard, and `wrangler d1 execute`, cover ad-hoc
querying with no extra tooling.

## Testing

All four classes exist:

- **Unit** (`kit/test/unit/diff.test.ts`): snapshot-diff → expected SQL, as pure data. The
  bulk of the suite, and the place SQL regressions are caught.
- **Integration** (`kit/test/workers/migrate.test.ts`): apply generated migrations against a
  real D1 database inside workerd, introspect the result, and assert it matches. Includes
  the drift case — a manual `ALTER` that no migration accounts for.
- **Property/fuzz** (`kit/test/workers/fuzz.test.ts`): a seeded PRNG generates random schema
  pairs; migrate A → B and assert the introspected result equals B. Seeded so a failure is
  reproducible from the number printed in the assertion.
- **Data preservation:** every recreation test seeds rows first and asserts they survive
  with their values intact, and the fuzz suite does the same for every generated pair.

A remote database in CI is **not** part of this yet — the remote runner is exercised only
through its interface. That is the largest untested surface in the kit.

## Resolved, and still open

1. **Migration state table** — resolved: wrangler's `d1_migrations` is reused, so
   `d1zzle-migrate migrate` and `wrangler d1 migrations apply` stay interchangeable.
2. **Remote apply transport** — resolved: the D1 HTTP API directly. Cleaner and testable;
   no dependency on wrangler being installed.
3. **Local state access** — resolved: `node:sqlite` reads the Miniflare SQLite file, so
   there is no native dependency to install.
4. **`drizzle-kit` history import** — still open, and currently not implemented. Adoption
   starts from a baseline.
5. **Interactive rename resolution** — still open. The diff engine takes rename maps; the
   prompt that would fill them from a terminal does not exist.
6. **Remote CI coverage** — still open. See Testing above.
