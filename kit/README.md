# d1zzle-migrate

Migrations, introspection and drift detection for [d1zzle](../README.md) on Cloudflare D1.

A **devDependency**. It runs in Node, and contributes zero bytes to the Worker bundle.

```bash
npm install -D d1zzle-migrate
```

```ts
// d1zzle.config.ts
import { defineConfig } from 'd1zzle-migrate';

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
`d1zzle/ddl` — `STRICT`, `WITHOUT ROWID` and the append-only trigger, which have no
spelling in `drizzle-orm/sqlite-core` and therefore live outside the schema file. What
each does, and what `generate` checks about it, is
[18-beyond-drizzle](../docs/18-beyond-drizzle.md).

The database is read from `wrangler.jsonc` / `wrangler.toml` unless overridden here, so
the binding is stated in one place rather than two.

### Environments

Wrangler's `[[env.<name>.d1_databases]]` (TOML) and `env: { <name>: { d1_databases } }`
(JSON/JSONC) blocks are read, and selected the same way wrangler selects them:

| | Which environment |
| --- | --- |
| 1 | `--env <name>` on the command line |
| 2 | `CLOUDFLARE_ENV` |
| 3 | `d1.env` in `d1zzle.config.ts` |
| — | none of them: the **top-level** block, which is what `wrangler` uses without `--env` |

`CLOUDFLARE_ENV` and `d1.env` disagreeing is an error rather than a preference — wrangler
has no `d1.env`, so there is no precedent to copy, and picking either one silently is how a
migration lands on production while the deploy goes to staging. `--env` settles it, exactly
as it does for wrangler.

**An environment that is missing, or that declares no `d1_databases`, is an error — it never
falls back to the top-level block.** Wrangler classifies `d1_databases` as *non-inheritable*:
an environment without its own gets no D1 binding at all. Falling back would therefore point
d1zzle at a database wrangler would never have bound, and applying a migration is not
undoable. `account_id` *is* inheritable in wrangler, so it does fall back. `migrations_dir`
is a property of the individual binding, which is where it is read from.

### Where each value comes from

One rule for every value: **`d1zzle.config.ts` > environment variable > wrangler config.**
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
config, so a d1zzle that did would read a different value than wrangler from the same line —
a new instance of the drift this all exists to prevent. A `database_id` that is still a
`__PLACEHOLDER__`, or the literal `local`, is rejected on `--remote` rather than sent to the
API as a mystery 404.

Every database-touching command prints what it resolved, and from where, before it acts —
on `--local` as well as `--remote`, with the id masked to its last four characters:

```
Target: remote D1 (HTTP API)
  environment    prd  ← --env
  binding        DB  ← wrangler.toml [env.prd]
  database_name  acme-db-prd  ← wrangler.toml [env.prd]
  database_id    …1234  ← CLOUDFLARE_D1_DATABASE_ID
  account_id     …f00d  ← CLOUDFLARE_ACCOUNT_ID
```

## Commands

```
d1zzle-migrate generate      # diff schema against the last snapshot → a new SQL migration
d1zzle-migrate migrate       # apply pending migrations (--local | --remote)
d1zzle-migrate push          # diff and apply directly, no migration file (dev only)
d1zzle-migrate pull          # introspect a live database → schema.ts + baseline snapshot
d1zzle-migrate check         # detect drift and unapplied migrations; non-zero exit for CI
d1zzle-migrate verify        # replay the migrations into an empty DB and compare with the
                             #   schema; needs no database at all, so it runs in CI
d1zzle-migrate up            # upgrade snapshot format after a kit version bump
d1zzle-migrate backfill      # run one-off statements against append-only tables, with
                             #   their guards suspended and put back verbatim, in one batch
d1zzle-migrate impact        # how many tables a rebuild of one table drags with it;
                             #   --local/--remote adds row counts
```

Flags: `--local` (default) targets the `.wrangler` SQLite state; `--remote` goes through
the D1 HTTP API. `--env <name>` picks a wrangler environment (see above).
`--accept-data-loss` is required for anything destructive. `generate --emit-roundtrip`
writes a draft sequence for a rebuild that was refused because the table has children.

`backfill` takes `--table <name>` (repeatable) and `--file <path.sql>`. `impact` takes an
optional `--table <name>`; without one it ranks every table in the schema by rebuild cost.
What each is for, and why they exist rather than being assembled by hand, is
[18-beyond-drizzle](../docs/18-beyond-drizzle.md).

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
rebuilt in the same migration: D1 rejects `PRAGMA foreign_keys = OFF` (it cannot be changed
inside the implicit transaction D1 runs every statement in), and `defer_foreign_keys`,
which D1 accepts, postpones constraint checking without suppressing `ON DELETE CASCADE` —
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
and recorded in wrangler's own `d1_migrations` table, so `d1zzle-migrate migrate` and
`wrangler d1 migrations apply` can be used against the same database.

## Studio

Not implemented. The Drizzle Studio browser extension introspects the live database and
never loads a schema file, so it works against a d1zzle project unchanged; Cloudflare's D1
console covers ad-hoc queries.

## Programmatic use

Every command is a plain function, and the diff engine is pure:

```ts
import { diffSnapshots, renderMigration, snapshotFromSchema } from 'd1zzle-migrate/core';

const sql = renderMigration(diffSnapshots(previousSnapshot, snapshotFromSchema(schema)));
```

`d1zzle-migrate/core` has no Node dependencies, so it also runs inside workerd — which is where
the migration engine is tested against a real D1 database.

## License

MIT
