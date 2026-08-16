# 18 — Beyond Drizzle

[12-drizzle-differences](./12-drizzle-differences.md) is about the same call behaving
differently. This is the other direction: things that have no spelling in `drizzle-orm` or
`drizzle-kit` at all, and exist here because the target is one database whose constraints
are known.

Each one replaces something that was being written by hand, and each is written down with
the failure it prevents, because in every case the hand-written version *looks* correct.

## Contents

- [Append-only tables, and append-only columns](#append-only-tables-and-append-only-columns)
- [`latestPerGroup`](#latestpergroup)
- [`STRICT` and `WITHOUT ROWID`, checked when the migration is written](#strict-and-without-rowid-checked-when-the-migration-is-written)
- [`impact` — what a rebuild will drag with it](#impact--what-a-rebuild-will-drag-with-it)
- [`backfill` — writing to an append-only table on purpose](#backfill--writing-to-an-append-only-table-on-purpose)
- [`generate --emit-roundtrip` — the sequence a refused rebuild needs](#generate---emit-roundtrip--the-sequence-a-refused-rebuild-needs)
- [The same vocabulary, spelled two ways](#the-same-vocabulary-spelled-two-ways)

## Append-only tables, and append-only columns

A ledger row, an audit record and a payment event are facts: they are appended, never
rewritten. SQLite expresses that with a `BEFORE UPDATE … RAISE(ABORT)` trigger, and
neither `drizzle-orm/sqlite-core` nor `drizzle-kit` has a spelling for a trigger, so the
guard ends up hand-written in a migration — where nothing keeps it in step with the schema
and nothing puts it back after someone drops it.

`d1zzle/ddl` declares it as an option, and the kit renders, diffs and introspects it like
any other part of the schema:

```ts
// src/db/table-options.ts — a sidecar module the schema file never imports
import { tableOptions } from 'd1zzle/ddl';
import { ledgerEntries, transactions, users } from './schema';

export default tableOptions([
  [users,          { strict: true }],
  [ledgerEntries,  { strict: true, withoutRowid: true, appendOnly: true }],
  [transactions,   { appendOnly: ['amount', 'currency', 'occurred_at'] }],
]);
```

It is a separate module, and keyed by the table *object* rather than its name, for two
reasons. A schema file must stay reverse-aliasable — every symbol it uses has to exist in
`drizzle-orm/sqlite-core` too ([08](./08-drizzle-compatibility.md)), and `strict`,
`withoutRowid` and triggers do not — and keying by the object makes a table rename a
compile error instead of a silently dropped flag.

`appendOnly: true` blocks every `UPDATE`. A column list narrows the guard to those columns
(`before update of "amount", …`), which is what a table needs when part of the row is
still moving: a fee an outside processor confirms after the row is written, free text a
deletion request has to be able to clear. `DELETE` stays allowed either way — what the
table protects is that a recorded fact is never *rewritten*, and expiring a retention
window or tearing down a test database are legitimate.

Two properties of `UPDATE OF` decide whether a column list is usable, and both were
measured against a real D1 binding rather than read off the documentation:

- It fires on **mention, not on change**. `set amount = amount` aborts. An ORM layer that
  rewrites every column on every save cannot be used against a column-scoped table.
- A statement touching both a guarded and an unguarded column aborts whole. Nothing is
  partially applied.

And the reason the column list is validated at all: **SQLite accepts `UPDATE OF` naming a
column that does not exist, and that trigger then never fires.** A typo produces a guard
that is present, syntactically valid, and protecting nothing — the same shape as the
dropped-`.unique()` bug this project started from. `assertAppendOnlyColumns` rejects it
where the schema is declared. An empty array is rejected too, rather than read as "guard
nothing".

The rendered list is sorted and de-duplicated, so reordering the array in a schema file
does not re-render the trigger and `generate` stays quiet. Introspection reads the column
list back out of `sqlite_master`, so a snapshot diff compares list to list; a guard that
is dropped by hand in production is drift that `check` reports.

## `latestPerGroup`

SQLite has no `DISTINCT ON`, and `row_number()` cannot appear in a `WHERE`, so "the latest
row per group" is a numbered subquery with an outer filter — four moving parts. The two
shapes it gets written as instead are both wrong on real data: fetching every row and
keeping the first seen per key in JavaScript transfers the whole history to return its
last page, and `order by … desc limit 1` per group is N queries *and* is not deterministic
on a millisecond timestamp.

```ts
import { desc, inArray, latestPerGroup } from 'd1zzle';

const latest = await latestPerGroup(db, bookingEvents, {
  partitionBy: [bookingEvents.bookingId],
  orderBy: [desc(bookingEvents.recordedAt)],
  tiebreak: desc(bookingEvents.id),
  where: inArray(bookingEvents.bookingId, ids),
});
```

`tiebreak` is a required argument, not an option with a default. `orderBy` alone accepts
`[desc(recordedAt)]`, and two rows written in the same millisecond then come back in
whichever order the scan produced — a state machine that occasionally reads one transition
stale, with no way to tell from the result which row it got. Only the caller knows which
of its columns is unique within a partition, so there is no default that would be right;
requiring it means the broken form cannot be written. `test/workers/latest-per-group.test.ts`
runs it against a real D1 database.

The rank column is projected under a name no user column can collide with and is removed
from the rows handed back, so the result type is the table's own.

## `STRICT` and `WITHOUT ROWID`, checked when the migration is written

Both are per-table options in the same sidecar module, and both are validated at
`generate` against rules confirmed on D1: `WITHOUT ROWID` without a primary key fails with
`PRIMARY KEY missing`, and `STRICT` with a `NUMERIC` column fails with `unknown datatype`
(`numeric()` is the only d1zzle column type that produces one). Catching them while the
migration is written is the point — the alternative is a migration that passes review and
then fails halfway through applying to production.

## `impact` — what a rebuild will drag with it

D1 does not allow `PRAGMA foreign_keys = OFF` inside a migration, so a table that other
tables reference cannot be rebuilt on its own: every foreign key pointing at it has to
come off first, and dropping a foreign key is itself a rebuild of the table holding it.
The cost runs *backwards* along the reference edges, transitively, and it is not something
you can see by reading a schema file.

```bash
npx d1zzle-migrate impact                                # every table, most expensive first
npx d1zzle-migrate impact --table transactions           # from the schema; no database
npx d1zzle-migrate impact --table transactions --remote   # …plus row counts
```

That number decides whether widening a `CHECK` is an afternoon or a week of migrations,
and it changes as the schema grows — which is why it is computed from the snapshot rather
than measured by hand into a design document that then goes stale. With a runner it also
reports `count(*)` per table in the closure: the closure says how many tables come apart,
the row counts say how long the copy takes, and a decision needs both. Verified against a
58-table schema by comparing 20 tables' closures with hand-computed values.

## `backfill` — writing to an append-only table on purpose

Adding a column to an append-only table means filling it once, and the guard blocks
exactly that. A trigger can be dropped and put back without rebuilding anything, so this
is cheap — it is just not *safe* assembled by hand, and both failures are silent: the
`create trigger` is forgotten and the table quietly accepts `UPDATE`s from then on, or it
is retyped and comes back with a column list one column short, which reads as protection
and is not.

```bash
npx d1zzle-migrate backfill --table transactions --file ./drizzle/manual/fees.sql --remote
```

The guard is never restated. It is read out of `sqlite_master`, dropped, and put back from
the captured text — so whatever protected the table before protects it after, including a
hand-written guard this tool did not author. Everything goes through one `batch()`, which
is one transaction on D1: a backfill that fails leaves the table exactly as it was, guard
included. There is no window in which the table is writable and nobody is watching.
`kit/test/workers/backfill.test.ts` asserts that the guard survives a failure.

## `generate --emit-roundtrip` — the sequence a refused rebuild needs

When `generate` refuses to rebuild a table with children ([14](./14-migrations.md)), the
change still has to be made, and the way through is a sequence nothing writes down. The
naive three passes — drop the children's foreign keys, rebuild the parent, put them back —
**do not work**: dropping a child's foreign key is a rebuild of the child, which is
refused for the same reason whenever that child has children of its own.

```bash
npx d1zzle-migrate generate --emit-roundtrip
```

Detaching therefore has to take out every reference edge inside the closure at once.
Restoring has the mirror problem and does not collapse the same way: restoring a table's
foreign key rebuilds that table, so nothing may reference it at that moment — one
migration per level of the reference graph, deepest last. A reference cycle inside the
closure has no such ordering at all, and is reported rather than papered over, because
breaking it means choosing which constraint to leave off and that is a decision.

Each leg is a `diffSnapshots` between two synthesised schemas, so the SQL comes out of the
same renderer as every other migration. **The draft is not a migration**: between the
detach and the last restore the database runs with those foreign keys absent, and whether
that window is acceptable is a judgement about a live system. It is written to
`<out>/roundtrip/`, outside the journal, so `migrate` can never apply it by accident.
`kit/test/workers/roundtrip.test.ts` applies the legs in order against a real database and
asserts that the data survives, the foreign keys come back, and the final shape matches
the target schema exactly.

## The same vocabulary, spelled two ways

`check ("method" in ('card', 'cash'))` is per table, and nothing compares one table's copy
to another's. When a vocabulary is widened it gets widened at the call sites someone
remembered, and the one they missed is a `CHECK` that now rejects a value its siblings
accept — which fails much later, at an `INSERT`, on the one path that writes the new value.

`generate` reports it, and reports it only when one value set is a **proper subset** of
another under the same column name. Two tables that legitimately share a column name with
unrelated vocabularies overlap partially or not at all and are left alone; only a strict
subset says "these were meant to be the same list, and one was not updated". On the
58-table schema this came from, three divergences were reported before the fix and none
after.

Matching is by column name, which is the only thing tying two constraints together once
the snapshot exists — a shared constant in the schema file has been erased by then. A copy
of the list under a differently named column is not compared: catching the divergence at
all is what matters, and a looser match buys false positives.

The warning is about keeping copies in step. Whether a vocabulary should be a `CHECK` at
all is the prior question: on D1, adding one value to an enum on a table that has children
is a rebuild, which is what [`impact`](#impact--what-a-rebuild-will-drag-with-it) prices.
