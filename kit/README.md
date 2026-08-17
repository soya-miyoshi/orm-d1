# orm-d1-kit

Migrations, introspection and drift detection for [orm-d1](../README.md) on Cloudflare D1.

A **devDependency**. It runs in Node, and contributes zero bytes to the Worker bundle.

```bash
npm install -D orm-d1-kit
```

```ts
// orm-d1.config.ts
import { defineConfig } from 'orm-d1-kit';

export default defineConfig({
  schema: './src/schema.ts',
  tableOptions: './src/table-options.ts',  // optional: STRICT / WITHOUT ROWID / appendOnly
  out: './migrations',          // wrangler's layout, by default
  d1: {
    env: 'stg',                 // optional: a wrangler [env.<name>] block
    localFile: './.dev.db',     // optional: an explicit file for --local
  },
});
```

`tableOptions` points at a module whose default export is `tableOptions([...])` from
`orm-d1/ddl` — `STRICT`, `WITHOUT ROWID`, the append-only trigger, and (see below) a
column's `COLLATE`, none of which have a spelling in `drizzle-orm/sqlite-core` and
therefore live outside the schema file. What each does, and what `generate` checks about
it, is [02-beyond-drizzle](../docs/02-beyond-drizzle.md).

```ts
// src/table-options.ts
import { tableOptions } from 'orm-d1/ddl';
import { users, reads } from './schema';

export default tableOptions([
  [users, { collate: { email: 'nocase' } }],
  [reads, { strict: true, withoutRowid: true, appendOnly: true }],
]);
```

### `collate`: stating a column's collation intent

A schema-derived snapshot can never state a column's `COLLATE` — Drizzle has no
`.collate()` — so by default the kit *carries a live collation forward* silently: once
`generate` records one for a column, it keeps re-emitting it into `meta/` on every future
run, because the alternative (dropping it) would make `check` re-report the exact loss
this project exists to prevent.

That carry-forward has one failure mode: if the team *deliberately* rebuilds a column back
to `BINARY`, there is no way to tell the kit "I meant that" — `generate` keeps carrying the
old collation forward forever, and `check` goes red for good. `tableOptions`'s `collate`
map is the fix — it lets the schema state a collation explicitly, ending the guesswork:

```ts
export default tableOptions([
  // A string is authoritative — `generate`/`check` treat it as the column's real
  // collation and stop guessing from the live database.
  [users, { collate: { email: 'nocase' } }],
  // `null` states the opposite: "no collation, and stop carrying one forward" — the
  // only way to retire a collation the kit once carried.
  [accounts, { collate: { legacyId: null } }],
]);
```

A column not named in `collate` keeps the old behaviour (carried forward from whatever the
live database last had) unchanged.

The database is read from `wrangler.jsonc` / `wrangler.toml` unless overridden here, so
the binding is stated in one place rather than two.

### Environments

Wrangler's `[[env.<name>.d1_databases]]` (TOML) and `env: { <name>: { d1_databases } }`
(JSON/JSONC) blocks are read, and selected the same way wrangler selects them:

| | Which environment |
| --- | --- |
| 1 | `--env <name>` on the command line |
| 2 | `CLOUDFLARE_ENV` |
| 3 | `d1.env` in `orm-d1.config.ts` |
| — | none of them: the **top-level** block, which is what `wrangler` uses without `--env` |

`CLOUDFLARE_ENV` and `d1.env` disagreeing is an error rather than a preference. Wrangler
has no `d1.env`, so there is no precedent to copy, and picking either one silently is how a
migration lands on production while the deploy goes to staging. `--env` settles it, exactly
as it does for wrangler.

**An environment that is missing, or that declares no `d1_databases`, is an error — it never
falls back to the top-level block.** Wrangler classifies `d1_databases` as *non-inheritable*:
an environment without its own gets no D1 binding at all. Falling back would therefore point
orm-d1 at a database wrangler would never have bound, and applying a migration is not
undoable. `account_id` *is* inheritable in wrangler, so it does fall back. `migrations_dir`
is a property of the individual binding, which is where it is read from.

### Where each value comes from

One rule for every value: **`orm-d1.config.ts` > environment variable > wrangler config.**
The config file is first because a value written there is a deliberate per-repo decision —
and it can always opt back into the environment itself (`accountId: process.env.…`).

| Value | Environment variable |
| --- | --- |
| `d1.databaseId` | `CLOUDFLARE_D1_DATABASE_ID` |
| `d1.accountId` | `CLOUDFLARE_ACCOUNT_ID` |
| `d1.token` | `CLOUDFLARE_API_TOKEN` |

`CLOUDFLARE_D1_DATABASE_ID` is the answer for projects that treat the id as a secret and
commit a placeholder: point the variable at the real id and the migration step needs no
rewritten `wrangler.toml`.

**`${VAR}` inside the wrangler file is *not* expanded.** Wrangler does not expand its own
config, so an orm-d1 that did would read a different value than wrangler from the same line —
a new instance of the drift this all exists to prevent. A `database_id` that is still a
`__PLACEHOLDER__`, or the literal `local`, is rejected on `--remote` rather than sent to the
API as a mystery 404.

Every database-touching command prints what it resolved, and from where, before it acts —
on `--local` as well as `--remote`, with the id masked to its last four characters:

```
Target: remote D1 (HTTP API)
  environment    prd  ← --env
  binding        DB  ← wrangler.toml [env.prd]
  database_name  your-db-prd  ← wrangler.toml [env.prd]
  database_id    …1234  ← CLOUDFLARE_D1_DATABASE_ID
  account_id     …f00d  ← CLOUDFLARE_ACCOUNT_ID
```

## Commands

```
orm-d1-kit generate      # diff schema against the last snapshot → a new SQL migration
orm-d1-kit migrate       # apply pending migrations (--local | --remote)
orm-d1-kit push          # diff and apply directly, no migration file (dev only)
orm-d1-kit pull          # introspect a live database → schema.ts (+ table-options.ts,
                             #   see below) + baseline snapshot
orm-d1-kit check         # detect drift and unapplied migrations; non-zero exit for CI
orm-d1-kit verify        # replay the migrations into an empty DB and compare with the
                             #   schema; needs no database at all, so it runs in CI
orm-d1-kit up            # upgrade snapshot format after a kit version bump
orm-d1-kit backfill      # run one-off statements against append-only tables, with
                             #   their guards suspended and put back verbatim, in one batch
orm-d1-kit impact        # how many tables a rebuild of one table drags with it;
                             #   --local/--remote adds row counts
```

Flags: `--local` (default) targets the `.wrangler` SQLite state; `--remote` goes through
the D1 HTTP API. `--env <name>` picks a wrangler environment (see above).
`--accept-data-loss` is required for anything destructive. `generate --emit-roundtrip`
writes a draft sequence for a rebuild that was refused because the table has children.

`backfill` takes `--table <name>` (repeatable) and `--file <path.sql>`. `impact` takes an
optional `--table <name>`; without one it ranks every table in the schema by rebuild cost.
What each is for, and why they exist rather than being assembled by hand, is
[02-beyond-drizzle](../docs/02-beyond-drizzle.md).

### `pull` and `config.tableOptions`

`--schema-out <file>` (default `./schema.ts`) is where `pull` writes the schema module.
`STRICT`, `WITHOUT ROWID`, an append-only guard, and a non-`BINARY` column `COLLATE` all
have no spelling that module can express — the schema DSL is a strict subset of
`drizzle-orm/sqlite-core` (`docs/04`) — so, alongside it, `pull` also renders a
`tableOptions([...])` sidecar naming every one it found, written to
`--table-options-out <file>` (default: `table-options.ts` next to `--schema-out`). It
imports the exact bindings the schema module exports, so the two files are usable together
immediately:

```ts
// table-options.ts, written by `pull`
import { tableOptions } from 'orm-d1/ddl';
import { reads, users } from './schema.js';

export default tableOptions([
  [users, { collate: { email: 'nocase' } }],
  [reads, { strict: true, withoutRowid: true, appendOnly: true }],
]);
```

The import says `./schema.js` for a file that is `schema.ts` on disk. That is deliberate:
it is the only spelling TypeScript accepts under `moduleResolution: 'node16'`/`'nodenext'`
(a relative import of a `.ts` file is `TS2835`), and the kit's own loader maps it back to
the `.ts` source, so the sidecar both typechecks and loads.

No sidecar is written when nothing in the introspected snapshot needs one — and in that
case an existing `table-options.ts` is neither read nor touched. `pull` also prints, for
every option it found, what the rendered schema module cannot express, and reminds you to
point `orm-d1.config.ts`'s `tableOptions` at the file it wrote: writing it is only half the
job. From then on, `generate`/`push`/`check` read it as the schema's stated intent instead
of guessing from what was last introspected.

**Overwriting a hand-maintained sidecar is lossy.** `--force` (the same flag that lets
`pull` overwrite an existing schema file) also governs overwriting an existing
table-options file, and the renderer cannot round-trip everything a person writes there:
comments, formatting, and any option for a table the live database no longer has are gone.
What it does preserve, when `config.tableOptions` points at the file being overwritten, is
every option it can still attribute to a table that exists live — including the ones
introspection can never produce, `collate: { column: null }` above all. The live database
wins per key (it is the authority on what is actually there), the config's declaration
survives everywhere else, and a declared table the live database no longer has is named in
the output rather than dropped in silence. Keep a copy anyway if the file is hand-written.

## What it does differently

**A migration is applied as one `batch()`.** D1 executes a batch atomically. The portable
alternative — sending `BEGIN`, the statements, then `COMMIT` as separate `prepare()` calls
— does not group them: D1 does not guarantee that consecutive statements reach the same
connection, so the `BEGIN` may apply to a connection the writes never touch, and each write
commits on its own. A migration that fails at statement 7 of 12 then leaves the first six
applied and nothing to roll them back. When a migration exceeds what one batch can carry,
the split point is printed, because atomicity is lost across it; a remote migration over
100 statements is instead routed through the file-import endpoint, which Cloudflare rolls
back as a unit.

**A single table rebuild that will not fit in one batch is refused outright, not split.**
A rebuild — `create table "__new_X"` … copy the data … `drop table "X"` … `alter table
"__new_X" rename to "X"`, plus every index and trigger `X` carries, recreated right after
the rename — has to land in one `batch()` or not run at all: splitting it risks leaving the
database mid-rebuild (the old table dropped, the new one never renamed into place) if a
later batch fails. If that whole group is longer than the per-batch limit (100 statements by
default) — which only happens for a table with enough indexes and triggers that the rebuild
plus their re-creation exceeds it — `push`/`migrate` refuse to emit the migration rather than
split the group unsafely. The error names the table.

**Compound statements do not go through D1's `/query` endpoint.** `/query` re-splits the
posted string on semicolons, and the splitter does not model compound statements:

```sql
create trigger "t_no_update" before update on "t" begin
  select raise(abort, 't is append-only');   -- /query splits here
end;
```

D1 answers `incomplete input: SQLITE_ERROR`. Measured against a real database, this
reproduces for a whole batch, for a lone `create trigger`, on one line, and with the
trailing semicolon removed; the semicolon before `end` is required by SQLite's grammar, so
no phrasing of it succeeds. `wrangler d1 migrations apply` returns the same error — it is
the endpoint, not the client. Such a batch is routed through the file-import endpoint
(`init` → `PUT` → `ingest` → poll), the four steps `wrangler d1 execute --file` uses.

**Rebuilds compute the copied column list.** SQLite can only `ADD COLUMN`, `DROP COLUMN`,
`RENAME COLUMN` and `RENAME TO`; a type change, a new `NOT NULL`, a changed default or any
constraint change rebuilds the table. The column list in the `INSERT … SELECT` is the
intersection of the old and new columns; `SELECT *` does not appear. Indexes are recreated,
because they are dropped with the table.

**Two rebuilds are refused at `generate` rather than emitted.** A new `NOT NULL` column
with no default cannot be backfilled. And a table that another table references cannot be
rebuilt in the same migration. D1 rejects `PRAGMA foreign_keys = OFF`, which cannot be
changed inside the implicit transaction D1 runs every statement in. `defer_foreign_keys`,
which D1 does accept, postpones constraint checking without suppressing `ON DELETE CASCADE`,
so the `DROP TABLE` step would delete rows out of every referencing table. `generate` names
the tables holding the references and stops. Drop those foreign keys in one migration and
rebuild in the next, or pass `--emit-roundtrip` for a draft of that sequence.

**`--local` and `--remote` are one code path.** Both are the same `SqlRunner` interface.

**`check` and `verify` compare different pairs.** `check` introspects the live database and
diffs it against the snapshot the migrations imply, reporting unapplied migrations and
manual changes — a `wrangler d1 execute` run against production would otherwise make the
next generated migration compute from a false baseline. `verify` replays the migrations
into an empty database and compares that against the schema. Neither subsumes the other:
`generate` writes the SQL and the snapshot from one diff, and nothing forces them to agree,
so a renderer that drops a constraint produces two self-consistent artifacts and `check`
stays green. `verify` compares two sides that share no code path, and needs no database.

**Migrations stay interchangeable with wrangler.** They are written in wrangler's layout
and recorded in wrangler's own `d1_migrations` table, so `orm-d1-kit migrate` and
`wrangler d1 migrations apply` can be used against the same database.

## Studio

Not implemented. The Drizzle Studio browser extension introspects the live database and
never loads a schema file, so it works against an orm-d1 project unchanged; Cloudflare's D1
console covers ad-hoc queries.

## Programmatic use

Every command is a plain function, and the diff engine is pure:

```ts
import { diffSnapshots, renderMigration, snapshotFromSchema } from 'orm-d1-kit/core';

const sql = renderMigration(diffSnapshots(previousSnapshot, snapshotFromSchema(schema)));
```

`orm-d1-kit/core` has no Node dependencies, so it also runs inside workerd — which is where
the migration engine is tested against a real D1 database.

`introspect(runner, foreignTriggers?)` takes an optional out-param, populated (keyed by live
table name) with the name of every trigger found that orm-d1 did not create — pass a plain
`{}`; it does not need to be a null-prototype object, even for a live table literally named
`constructor` or another `Object.prototype` member.

## License

MIT
