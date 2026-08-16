# 14 — Migrations

`d1zzle-migrate` is a devDependency. It runs in Node and adds nothing to the Worker
bundle. Full documentation is in [kit/README.md](../kit/README.md); the design is
[09-d1zzle-migrate](./09-d1zzle-migrate.md).

```bash
npx d1zzle-migrate generate   # diff the schema against the last snapshot → a SQL migration
npx d1zzle-migrate migrate    # apply pending migrations (--local | --remote)
npx d1zzle-migrate check      # drift and unapplied migrations; non-zero exit for CI
npx d1zzle-migrate verify     # replay migrations into an empty DB and compare with the schema
```

The command surface mirrors `drizzle-kit` (`generate` `migrate` `push` `pull` `check`
`up`, plus `verify`), and migrations are written in wrangler's layout and recorded in
wrangler's own `d1_migrations` table, so `d1zzle-migrate migrate` and
`wrangler d1 migrations apply` remain interchangeable on the same database.

What differs, and why:

**Applying a migration is atomic.** A migration file is split into statements and
submitted as one `batch()`. Emitting `BEGIN`/`COMMIT` around the statements — what a
portable tool does — is not honoured by D1, so a failure halfway through leaves the
database half-migrated. When a migration is too large for one atomic unit the CLI reports
the split point rather than hiding it; a remote migration over 100 statements is routed
through the file-import endpoint, which Cloudflare rolls back as a unit, instead of being
cut in half.

**Some statements cannot go through D1's `/query` endpoint at all.** D1 re-splits the
posted string on semicolons with a splitter that does not know about compound statements,
so a trigger body is cut before its `end`:

```sql
create trigger "t_no_update" before update on "t" begin
  select raise(abort, 't is append-only');   -- /query cuts here
end;
```

D1 answers `incomplete input: SQLITE_ERROR`. Measured against a real database, this happens
for a whole batch, for a lone `create trigger`, on one line, and with the trailing
semicolon removed; the semicolon before `end` is required by SQLite's grammar, so there is
no phrasing `/query` accepts. `wrangler d1 migrations apply` fails identically — it is the
endpoint, not the client. `d1zzle-migrate` routes such a batch through the file-import
endpoint (`init` → `PUT` → `ingest` → poll), the same four steps `wrangler d1 execute
--file` uses.

**Table rebuilds are checked before they are written.** SQLite can only `ADD COLUMN`,
`DROP COLUMN`, `RENAME COLUMN` and `RENAME TO`; a type change, a new `NOT NULL`, a changed
default or any constraint change rebuilds the table. SQLite's standard recipe for that
begins with `PRAGMA foreign_keys = OFF`, which D1 rejects — it cannot be changed inside the
implicit transaction D1 runs every statement in. `defer_foreign_keys`, which D1 does
accept, postpones constraint checking but does not suppress `ON DELETE CASCADE`, so the
`DROP TABLE` step would delete rows out of every referencing table. Therefore a table that
another table references cannot be rebuilt in one migration: `generate` refuses and names
the tables holding the references, instead of emitting SQL that destroys data on apply.
Drop the referencing foreign keys in one migration and rebuild in the next. The same rule
applies to a new `NOT NULL` column with no default — it cannot be backfilled, so it fails
at `generate` rather than at apply. In the rebuild itself, the column list in
`INSERT … SELECT` is always computed from the intersection of the old and new columns;
`SELECT *` never appears.

**`verify` exists because `check` cannot catch a renderer bug.** `generate` writes two
artifacts from one diff — the SQL and the snapshot — and nothing forces them to agree. If
the renderer drops a constraint, both are self-consistent, `check` compares the live
database against the snapshot that shares the omission, and CI stays green with the
constraint gone. This is the failure the project started from: on one 64-table schema,
`drizzle-kit` dropped column-level `.unique()` and the generated-versus-committed CI check
stayed green because both artifacts shared the bug. `verify` replays the migrations into
an empty database and compares *that* against the schema, so the two sides share no code
path. It needs no database and runs in CI.

**Drift is a command.** `check` introspects the live database, diffs it against the
snapshot the migrations imply, and reports unapplied migrations and manual changes — the
`wrangler d1 execute` someone ran against production that would otherwise make the next
generated migration compute from a false baseline.

**One target, printed before it acts.** The database is read from `wrangler.jsonc` /
`wrangler.toml`, including named environment blocks, selected the way wrangler selects
them (`--env`, then `CLOUDFLARE_ENV`, then `d1.env`, then top level). An environment that
declares no `d1_databases` is an error rather than a fallback to the top-level block,
because wrangler treats that binding as non-inheritable and the fallback would apply a
migration to a database wrangler would never have bound. Every database-touching command
prints the environment, binding, database name, and — for `--remote` — the account and the
database id masked to its last four characters, each with the source it was read from.

There is no `studio`. The Drizzle Studio browser extension introspects the live database
and never loads a schema file, so it works against a d1zzle project unchanged;
Cloudflare's D1 console covers ad-hoc queries.
