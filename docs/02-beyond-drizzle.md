# Beyond Drizzle

[01-differences](./01-differences.md) covers the same call behaving differently. This
covers what has no spelling in `drizzle-orm` or `drizzle-kit`: seven features. Each is
specific to D1 or to SQLite, which is why a library targeting several databases has no
place to put it.

## Contents

- [Append-only tables, and append-only columns](#append-only-tables-and-append-only-columns)
- [`latestPerGroup`](#latestpergroup)
- [`STRICT` and `WITHOUT ROWID`](#strict-and-without-rowid)
- [`impact`](#impact)
- [`backfill`](#backfill)
- [`generate --emit-roundtrip`](#generate---emit-roundtrip)
- [Vocabulary divergence](#vocabulary-divergence)

## Append-only tables, and append-only columns

SQLite blocks `UPDATE` with a `BEFORE UPDATE … RAISE(ABORT)` trigger. Neither
`drizzle-orm/sqlite-core` nor `drizzle-kit` has a spelling for a trigger, so the guard is
written by hand in a migration, where the schema does not record it and `check` cannot
report its absence.

`d1zzle/ddl` declares it as a table option:

```ts
// src/db/table-options.ts — a sidecar module the schema file does not import
import { tableOptions } from 'd1zzle/ddl';
import { ledgerEntries, transactions, users } from './schema';

export default tableOptions([
  [users,         { strict: true }],
  [ledgerEntries, { strict: true, withoutRowid: true, appendOnly: true }],
  [transactions,  { appendOnly: ['amount', 'currency', 'occurred_at'] }],
]);
```

`generate` renders the trigger, `diff` compares it, and `introspect` reads it back:

```sql
create trigger "transactions_no_update"
before update of "amount", "currency", "occurred_at" on "transactions"
begin
	select raise(abort, 'these columns of transactions are append-only: UPDATE is prohibited');
end;
```

It is a separate module because a schema file must stay reverse-aliasable — every symbol
it uses also exists in `drizzle-orm/sqlite-core` ([04-migrating-from-drizzle](./04-migrating-from-drizzle.md)) —
and `strict`, `withoutRowid` and triggers do not exist there. Tables are keyed by object,
so renaming a table is a type error rather than a dropped option.

`appendOnly: true` blocks every `UPDATE`. A column list blocks only statements mentioning
those columns, which leaves the rest of the row writable. Two columns that have to stay
writable on an otherwise frozen row: a fee an outside processor confirms after the row is
written, and free text that a deletion request has to clear. `DELETE` is allowed in both
forms.

Two properties of `UPDATE OF`, both asserted against a real D1 binding in
`kit/test/workers/roundtrip.test.ts` ("fires on mention, not on change, and never applies
a statement in part"):

```sql
update "transactions" set "amount" = "amount" where "id" = 1;   -- aborts: mention, not change
update "transactions" set "amount" = 1, "note" = 'x';           -- aborts whole; "note" is not written
```

The first is why a data-access layer that rewrites every column on every save cannot be
used against a column-scoped table.

A third property is why the column list is validated: **SQLite accepts `UPDATE OF` naming
a column that does not exist, and the trigger then never fires.** The guard is present,
`create trigger` succeeds, and no `UPDATE` is blocked. `assertAppendOnlyColumns` rejects
the list where it is declared:

```
tableOptions: "transactions" declares appendOnly columns that do not exist: amt. SQLite
accepts `before update of` on unknown columns without error, and the trigger then never
fires — the table would read as guarded while every UPDATE went through. Known columns:
amount, currency, id, note, occurred_at.
```

An empty array is rejected as well, rather than read as "guard nothing". The rendered list
is sorted and de-duplicated, so reordering the array in a schema file produces no diff.

## `latestPerGroup`

SQLite has no `DISTINCT ON`, and `row_number()` cannot appear in `WHERE`, so one row per
group is a numbered subquery with an outer filter.

```ts
import { desc, inArray, latestPerGroup } from 'd1zzle';

const latest = await latestPerGroup(db, bookingEvents, {
  partitionBy: [bookingEvents.bookingId],
  orderBy: [desc(bookingEvents.recordedAt)],
  tiebreak: desc(bookingEvents.id),
  where: inArray(bookingEvents.bookingId, ids),
});
```

One statement, as emitted (line breaks added):

```sql
select "d1zzle_latest"."id", "d1zzle_latest"."bookingId", "d1zzle_latest"."state",
       "d1zzle_latest"."recordedAt"
from (select "booking_events"."id", "booking_events"."booking_id" as "bookingId",
             "booking_events"."state", "booking_events"."recorded_at" as "recordedAt",
             row_number() over (partition by "booking_events"."booking_id"
                                order by "booking_events"."recorded_at" desc,
                                         "booking_events"."id" desc) as "__d1zzle_latest_rn"
      from "booking_events" where "booking_events"."booking_id" in (?, ?)) "d1zzle_latest"
where "d1zzle_latest"."__d1zzle_latest_rn" = ?
```

The rank column is projected under a name no user column can collide with and is removed
from the returned rows, so the result type is the table's own.

It replaces two hand-written alternatives, each with its own cost. Fetching every row and
keeping the first seen per key in JavaScript transfers the whole history in order to return
its last page. `order by … desc limit 1` per group is one query per group, and on a
millisecond timestamp it is not deterministic: two rows recorded in the same millisecond
come back in whichever order the scan produced.

`tiebreak` is a required argument for that reason. `orderBy` alone accepts
`[desc(recordedAt)]`, which is not a total order, and the result is then one of two rows
with nothing downstream able to tell which. There is no default that would be correct,
since only the caller knows which column is unique within a partition.
`test/workers/latest-per-group.test.ts` runs the query against a real D1 database.

## `STRICT` and `WITHOUT ROWID`

Both are options in the same sidecar module, and both are validated at `generate` against
behaviour confirmed on D1. `WITHOUT ROWID` on a table with no primary key fails with
`PRIMARY KEY missing`. `STRICT` with a `NUMERIC` column fails with `unknown datatype`;
`numeric()` is the only d1zzle column type that renders one. The alternative to checking is
a migration that applies to production halfway and then fails.

## `impact`

D1 rejects `PRAGMA foreign_keys = OFF` inside a migration, so a table other tables
reference cannot be rebuilt on its own: every foreign key pointing at it has to be dropped
first, and dropping a foreign key rebuilds the table holding it. The cost runs backwards
along the reference edges, transitively.

```bash
npx d1zzle-migrate impact                                 # every table, most expensive first
npx d1zzle-migrate impact --table transactions            # from the schema; no database
npx d1zzle-migrate impact --table transactions --remote   # …and count(*) per table
```

```
Rebuilding "transactions" means dropping and restoring the foreign keys of 7 table(s):
  transaction_lines  (12,904 rows)
  refunds  (318 rows)
  …
Referenced directly by 2: transaction_lines, refunds
"transactions" itself holds 8,441 row(s), all of which a rebuild copies.
```

The closure says how many tables come apart; the row counts say how long the copy takes.
Both are computed from the snapshot rather than measured by hand, so the answer tracks the
schema. Checked against a 58-table schema: the closures for 20 tables matched values
computed by hand.

## `backfill`

Filling a column added to an append-only table requires the guard to be off for the
duration. A trigger can be dropped and re-created without rebuilding the table, so the
operation is cheap; the two ways it fails when assembled by hand are both silent.

```bash
npx d1zzle-migrate backfill --table transactions --file ./migrations/manual/fees.sql --remote
```

The guard is read out of `sqlite_master`, dropped, and re-created **from the captured
text** — never restated. Restating it would mean retyping the column list, and a list one
column short reads as protection without being it; omitting the re-create leaves the table
accepting `UPDATE`s indefinitely. Everything is submitted as one `batch()`, which D1
executes as one transaction, so a backfill that fails leaves the table as it was, guard
included. `kit/test/workers/backfill.test.ts` asserts that the guard is present after a
statement inside the backfill fails.

## `generate --emit-roundtrip`

When `generate` refuses to rebuild a table that others reference
([kit/README](../kit/README.md#what-it-does-differently)), the change still has to be
made. The three-pass sequence it appears to need — drop the children's foreign keys,
rebuild the parent, restore them — does not apply: dropping a child's foreign key is a
rebuild of the child, which is refused for the same reason whenever that child has
children of its own.

```bash
npx d1zzle-migrate generate --emit-roundtrip
```

One file per refused table, `<out>/roundtrip/<timestamp>_<table>.draft.sql`, holding the
passes in order under a header:

```sql
-- DRAFT — not a migration. Review, split, and record each pass yourself.
--   * Each pass has to be its own migration, applied and verified in order.
--   * Between pass 1 and pass 3 the foreign keys are absent. …
-- Tables in the closure: transaction_lines, refunds, refund_lines

-- 1. Detach every foreign key inside the closure of "transactions"
-- 2. Rebuild "transactions"
-- 3. Restore the foreign keys of "refund_lines"
-- 4. Restore the foreign keys of "transaction_lines", "refunds"
```

Detaching has to remove every reference edge inside the closure at once. Restoring cannot:
restoring a table's foreign key rebuilds that table, so nothing may reference it at that
moment, which makes it one migration per level of the reference graph. A reference cycle
inside the closure admits no such ordering and is reported instead — breaking it means
choosing which constraint to leave off.

Each leg is a `diffSnapshots` between two synthesised snapshots, so the SQL comes from the
same renderer as every other migration. Between the detach and the last restore the
database runs without those foreign keys, and a row inserted in that window can be one the
restored constraint rejects, which fails the restore. The files are written to
`<out>/roundtrip/`, outside the journal `migrate` reads, so they are never applied
automatically. `kit/test/workers/roundtrip.test.ts` applies the legs in order against a
real database and asserts that the rows survive, the foreign keys return, and the final
schema matches the target exactly.

## Vocabulary divergence

`check ("method" in ('card', 'cash'))` is per table, and nothing compares one table's copy
with another's. A vocabulary widened at three call sites and missed at the fourth leaves a
`CHECK` that rejects a value its siblings accept, and it fails at an `INSERT` on the one
path that writes the new value.

`generate` reports a pair when one value set is a **proper subset** of the other under the
same column name:

```
  ! "transactions"."method" allows 2 value(s) but "payment_attempts"."method" allows 3,
    and the smaller set is contained in the larger — so this looks like one vocabulary
    that was widened in one place and not the other. "transactions" rejects: 'transfer'.
    If the two are meant to differ, rename one of the columns or the constraint so they
    stop looking like the same list.
```

Sets that overlap partially, or not at all, are not reported: two tables can share a column
name with unrelated vocabularies, and only a strict subset indicates one list that was not
updated. Matching is by column name, which is the only link between two constraints left in
a snapshot — a shared constant in the schema file is gone by then, so a copy under a
differently named column is not compared. On the 58-table schema this came from, three
divergences were reported before the fix and none after.

Whether a vocabulary belongs in a `CHECK` at all is the prior question: adding one value to
an enum on a referenced table is a rebuild, which is what [`impact`](#impact) prices.
