# 10 — Ecosystem interoperability

[08](./08-drizzle-compatibility.md) scoped compatibility at the source level: match the
call signatures, and put "anything under Drizzle's `~/` paths, `entityKind`, or the dialect
classes" out of scope.

That line turned out to be in the wrong place. It holds for *user code* — a schema file
only uses the public DSL. It does not hold for **adapters**, and adapters are most of why
Drizzle is worth adopting: the Zod/Valibot/TypeBox adapters, Pothos' drizzle plugin,
Studio. None of them can work from the public API, because Drizzle does not
have one for "describe this schema". They all read internals.

So the target moved: a d1zzle schema should be indistinguishable from a Drizzle schema **to
Drizzle's own code**.

## What adapters actually read

Three mechanisms, all of them internal:

**1. `entityKind` on the constructor chain.** `is(value, SQLiteTable)` does not use
`instanceof` — it walks the prototype chain of `value.constructor`, comparing a static
symbol property against the target class's:

```js
// drizzle-orm/entity.js
let cls = Object.getPrototypeOf(value).constructor;
while (cls) {
  if (entityKind in cls && cls[entityKind] === type[entityKind]) return true;
  cls = Object.getPrototypeOf(cls);
}
```

Two consequences. A table must be a **class instance**, not an object literal — a
null-prototype object has no constructor and fails immediately. And it must have real
**ancestors**, because a check against `Table` has to match somewhere above the check
against `SQLiteTable`.

**2. Well-known symbols.** `Symbol.for('drizzle:Name')`, `drizzle:Columns`,
`drizzle:OriginalName`, `drizzle:Schema`, `drizzle:IsDrizzleTable`, and friends. This is
how `getTableName()` and `getTableColumns()` work.

**3. The column surface.** `.dataType`, `.columnType`, `.name`, `.notNull`, `.primary`,
`.hasDefault`, `.enumValues`, `.isUnique`, `.table`, `.getSQLType()`,
`.mapFromDriverValue()`, `.mapToDriverValue()`. Adapters branch on `dataType` to pick a
GraphQL or Zod type, and on the concrete class — `is(column, SQLiteInteger)` — to decide
whether a primary key is auto-generated.

## What d1zzle does about it

`src/schema/drizzle-entity.ts` declares the chain, and `columns.ts` creates one empty
subclass per Drizzle column type, cached and instantiated by the column factories:

```
DrizzleTableEntity ('Table') → SQLiteTableEntity ('SQLiteTable') → D1zzleTable
DrizzleColumnEntity ('Column') → SQLiteColumnEntity ('SQLiteColumn') → Column
                                                                    → ('SQLiteInteger')
                                                                    → ('SQLiteText')
                                                                    → ('SQLiteBoolean') …
```

`table()` builds an instance of `D1zzleTable`, assigns the columns onto it, and attaches
both our symbols and Drizzle's. Each column gets a back-reference to its table, because
`column.table` is part of the surface.

**This breaks rule R3** ([01](./01-principles.md#r3--prefer-closures-and-plain-objects-over-class-hierarchies)),
deliberately and in exactly one file. The classes have no members; the cost is prototype
setup for a handful of empty constructors.

The relational layer follows the same principle. `defineRelations()` returns the plain
`{ [tsName]: { table, name, relations } }` record Drizzle v1 produces — no class, no
prototype, reproducible with zero imports — and the relation values carry the matching
`RelationV2` / `OneV2` / `ManyV2` entity kinds. `db._` exposes `relations`, `schema`,
`fullSchema`, `tableNamesMap` and `session`, because that is what schema-aware adapters
read instead of asking.

### Verified, not assumed

`test/unit/drizzle-interop.test.ts` imports the **real `drizzle-orm`** as a devDependency
and calls its functions on d1zzle objects:

```ts
is(users, SQLiteTable);        // true
is(users, Table);              // true
is(users.id, SQLiteInteger);   // true
is(users.email, SQLiteInteger); // false — the negative case matters just as much
getTableName(alias(users, 'author'));  // 'author'
getTableColumns(users);        // every column, in declaration order
```

plus the column surface, every `mode`'s `dataType`/`columnType` pairing, and both
directions of value mapping. If Drizzle changes how recognition works, this suite fails
rather than some user's adapter.

## The part that cannot be fixed

Runtime recognition is solvable. **Type-level assignability to Drizzle's `Column` is not.**

```ts
export declare abstract class Column</* … */> {
  protected config: ColumnRuntimeConfig<…>;   // ← this
}
```

TypeScript considers a `protected` member compatible only when both types inherit it from
the *same declaration*. That is a language rule with no structural workaround: no class
that does not extend `drizzle-orm`'s `Column` can ever be assignable to it, no matter what
shape it has. And extending it would make `drizzle-orm` a runtime dependency of the Worker
bundle, which is the one thing this project cannot do.

`Table` has no protected members, so tables are fine — but `InferSelectModel<T>` bottoms
out in `Record<string, Column>` constraints, so the column rule propagates.

### The escape hatch

`d1zzle/drizzle` exports `asDrizzleSchema()` / `asDrizzleTable()`: identity at runtime,
with a return type computed from the metadata each column already carries
([04](./04-type-inference.md#column-types)).

```ts
import { asDrizzleSchema } from 'd1zzle/drizzle';

const graphql = buildSchema(db as never, { schema: asDrizzleSchema(schema) });
```

`drizzle-orm` is an **optional peer dependency**. `asDrizzleSchema` / `asDrizzleTable`
import types only and contribute nothing at runtime; `asDrizzleRelations` (below) is the
one export that needs Drizzle's classes themselves. Nothing outside `d1zzle/drizzle`
imports `drizzle-orm` at all, so a project that never touches an adapter never loads it.

**Peer, not a dependency — for the same reason `asDrizzleRelations` exists.**

```jsonc
"peerDependencies":     { "drizzle-orm": ">=1.0.0-rc.1 <2" },
"peerDependenciesMeta": { "drizzle-orm": { "optional": true } }
```

`instanceof` compares constructor *identity*. A regular dependency lets npm install a
nested `node_modules/d1zzle/node_modules/drizzle-orm` on any version conflict — and then
`asDrizzleRelations` re-prototypes onto **d1zzle's** `Many` while the plugin tests against
**the app's** `Many`. Every `many` resolves as a single object again: exactly the bug this
function was written to prevent, reintroduced by the dependency graph, invisible to
TypeScript, and not caught by any test that installs a flat tree. A peer dependency is the
declaration that there must be one copy and it belongs to the application.

`optional: true` is what keeps that from taxing everyone else — npm 7+ installs peers
automatically, and without the flag every d1zzle user would pull Drizzle to satisfy a
constraint most of them never reach.

The upper bound is deliberate. `>=1.0.0-rc.1` alone is satisfied by `2.0.0` and beyond, so
a future major that renames or restructures `Many` / `One` would install clean and fail at
runtime with the silent single-object bug — no warning, because the range said yes. Since
the whole purpose of the peer dependency is guarding a fragile `instanceof` contract,
leaving it open would undercut the reason for declaring it. `<2` makes that bump an
explicit decision.

Note that `^1.0.0-rc.1` would *not* be equivalent: a caret on a prerelease admits only
prereleases of that same `1.0.0` and would reject the stable `1.0.0` when it ships. The
range as written accepts `1.0.0-rc.1` through `1.x`, and rejects `0.44.0` and `2.0.0`.

`test/unit/drizzle-types.test.ts` checks the result is honest: Drizzle's `InferSelectModel`
and `InferInsertModel`, applied to `asDrizzleTable(users)`, agree with our own `InferSelect`
/ `InferInsert` on every key and every value type — including `boolean` for
`{ mode: 'boolean' }`, `Date` for timestamps, the narrowed enum union, and which keys are
optional on insert.

## `instanceof`, the mechanism the survey missed

The three mechanisms above are all *structural* — `entityKind` walks, symbol reads, duck
typing — and all three can be satisfied without importing `drizzle-orm`. A survey that
greps for `is(` finds them.

`@pothos/plugin-drizzle` has one line that is none of them:

```js
type: relationField instanceof Many ? [ref] : ref
```

`instanceof` consults the **right-hand** constructor's `Symbol.hasInstance` and prototype
chain, so nothing we do on our side can satisfy it. There is no structural workaround, and
the failure is silent: every `many` relation resolves as a single object instead of a list.

`asDrizzleRelations()` closes it by giving each relation a shallow copy whose prototype is
Drizzle's `One`/`Many`, carrying every field the plugin reads. The originals are untouched,
so `db._.relations` and the query executor keep working on ours. This is the only place in
the ecosystem where an `instanceof` has turned up; the lesson is that grepping for `is(`
was not sufficient, and the next adapter deserves a real test rather than a survey.

## Better Auth — where the bridge stops being the answer

Everything above is about being *recognised*: an adapter reads a schema, and the job is to
make our objects answer its questions the way Drizzle's would. Better Auth's Drizzle
adapter does something else. It does not read the schema and hand the result to its own
engine — it **drives the database through drizzle-orm's query builder**:

```js
db.insert(schemaModel).values(values).returning()
db.select().from(schemaModel).where(and(eq(schemaModel[field], value)))
```

Those are drizzle-orm's `insert` / `select` / `eq` / `and`, executing through drizzle-orm's
dialect, session and prepared-statement machinery. `asDrizzleSchema()` retypes a schema; it
cannot retype a *runtime*. Point the adapter at a d1zzle table and it fails on the first
write with `col.shouldDisableInsert is not a function` — and if it did not, satisfying it
would mean reimplementing the very subsystem d1zzle exists to delete.

So this one is not a compatibility gap to close. It is the case where the bridge is the
wrong tool, and the right one is sitting in Better Auth's own API.

### `createAdapterFactory` is the real seam

Better Auth's Drizzle adapter is not privileged. It is one caller of
`createAdapterFactory`, which takes a `CustomAdapter` — ten methods over
`{ model, where, data }` — and layers model and field mapping, id generation, default
application, and input/output transforms on top. Write those ten methods against d1zzle and
Better Auth is satisfied by construction, with no Drizzle in the picture at all:

```ts
import { betterAuth } from 'better-auth';
import { drizzle } from 'd1zzle';
import { d1zzleAdapter } from 'd1zzle/better-auth';
import { user, session, account, verification } from './schema';

const auth = betterAuth({
  database: d1zzleAdapter(drizzle(env.DB), {
    schema: { user, session, account, verification },
  }),
});
```

`schema` is required here where the Drizzle adapter's is optional: `drizzle()` takes
`relations`, not a flat schema bag, so there is no `db._.fullSchema` to fall back on and no
way to guess which table is the `user`.

### Two methods that had to be written natively

`CustomAdapter` marks `consumeOne` and `incrementOne` optional, and the factory supplies
fallbacks — but both are built out of `transaction(findMany + deleteMany/updateMany)`.
[D1 has no interactive transactions](./02-d1-platform.md#no-interactive-transactions), so
`transaction` is declared `false` and those fallbacks degrade to a read, a gap, and a
write. That is not a missing optimisation. `consumeOne` is the primitive behind
single-use credentials — verification tokens, OAuth authorization codes — where "exactly
one caller wins" *is* the semantics, and two racers would both come away with the row.

Both are therefore implemented as one statement, which D1 executes atomically:

```sql
delete from "verification" where "id" in (
  select "id" from "verification" where "value" = ? limit 1
) returning *
```

SQLite has no `DELETE … LIMIT` unless compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`,
which D1 is not, so the self-subquery on the primary key is how a write is pinned to one
row. `RETURNING` reports only rows the statement itself deleted, so the loser gets nothing
back. `incrementOne` uses the same selector with `"col" = "col" + ?`, keeping the guard and
the arithmetic inside one statement so a concurrent decrement cannot be lost.

`test/workers/better-auth.test.ts` runs both under `Promise.all` against real D1 in
workerd, and asserts the counts — one row consumed out of two callers, five decrements
landing as five.

### What it does not do

- **No `experimental.joins`.** The Drizzle adapter serves those from `db.query`; ours
  throws a named error rather than silently returning rows with the joined models missing.
- **No `createSchema`.** `@better-auth/cli generate` cannot emit a d1zzle schema, because
  in a d1zzle project the schema file is the source of truth that `d1zzle-migrate` diffs
  against — generating it from Better Auth's model list would invert that. Write the tables
  in `d1zzle/sqlite-core` (the Better Auth docs' Drizzle schema ports over unchanged) and
  run `d1zzle-migrate generate`.
- **`update` applies its `where` directly** rather than pinning to one row the way
  `consumeOne` does. Better Auth only ever calls it with a predicate that is unique by
  construction — an id, a session token — so the subquery would buy nothing and cost an
  index probe on the session-refresh path, the hottest write it makes. An empty `where` is
  refused outright, per the adapter contract.

`better-auth` is an optional peer, declared for the same reason `drizzle-orm` is. The
import is `better-auth/adapters` rather than `@better-auth/core/db/adapter` — which is what
the first-party adapter uses — because `@better-auth/core` is a *transitive* dependency of
`better-auth`, and under pnpm's default layout a transitive dependency is not resolvable
from `d1zzle`'s own `node_modules`. `better-auth/adapters` re-exports the same factory from
a package the application already depends on directly.

## Status by adapter

| Adapter | Runtime | Types |
| --- | --- | --- |
| `drizzle-orm` core helpers (`is`, `getTableName`, `getTableColumns`) | Verified by test | Direct use needs `asDrizzleTable` |
| Drizzle `SQL` fragments over d1zzle columns (`eq`, `inArray`, `sql`) | **Verified by test** — rendered through the bridge in `sql/drizzle-sql.ts` | n/a |
| Pothos `plugin-drizzle` | **Verified end to end** — `test/workers/pothos.test.ts` executes GraphQL against real D1 in workerd. Needs our `getTableConfig` and `asDrizzleRelations` | `DrizzleRelations: PothosRelations<typeof relations>`; see below |
| Better Auth | **Verified end to end** — `test/workers/better-auth.test.ts` drives `d1zzle/better-auth` against real D1 in workerd. Not a bridge: a native `CustomAdapter`, no `drizzle-orm` involved | n/a — the adapter is typed against Better Auth, not Drizzle |
| Validator adapters (Zod, Valibot, TypeBox) | Read columns only; expected to work | `asDrizzleSchema` |
| Drizzle Studio (extension) | Works — it introspects the live database and never sees our objects at all | n/a |

The honest gaps:

- **Adapters that check the database object.** `is(db, BaseSQLiteDatabase)` will not
  recognise `D1zzleDatabase`; matching it would mean matching Drizzle's session and dialect
  classes too — a far larger surface than the schema, and one whose behaviour we would then
  have to keep in step. Nothing currently shipped needs it.

  Adding that entity chain was scoped as its own phase, conditional on measuring whether
  the one adapter that wanted it — drizzle-graphql — then got further. It does not, and the
  reason is not ours: drizzle-graphql@0.8.5 is the latest release, it has no v1 build, and
  it calls `createTableRelationsHelpers`, which `drizzle-orm@1` does not export at all
  (nor `extractTablesRelationalConfig`, `normalizeRelation`, or `relations`). It cannot run
  against Drizzle v1 whatever d1zzle does. Satisfying `is(db, BaseSQLiteDatabase)` would
  only move its failure from a clear "unknown database instance type" to an undefined-is-
  not-a-function further in — strictly worse. **Decided: not built**, and this is the
  measurement rather than a deferral.
- **Pothos' types — typed, not opted out of.** This entry used to read "permanent, not
  pending": the *type* parameter `DrizzleRelations` slots against Drizzle's
  `TablesRelationalConfig`, whose `table` is Drizzle's `Table` class, so — the reasoning
  went — the protected-member rule applies one level up and `DrizzleRelations: never` plus
  a cast is the supported spelling. That was wrong. The rule applies to Drizzle's
  `Column`/`Table` *classes*, but v1's `TableRelationalConfig` asks only for
  `{ table; name; relations }`, and its `table` is `SchemaEntry` — `Table<any> | View<…>` —
  which `ToDrizzleTable` already produces. Nothing in that interface is compared nominally.

  `PothosRelations<typeof relations>` fills the slot outright, and `asPothosRelations()`
  supplies the value, so only `client` and `getTableConfig` still take casts — those do
  slot against Drizzle's database and table classes. Opting out was not free: it took the
  whole GraphQL layer off compile-time checking, so a typo'd column reached production as a
  runtime resolver error. `test/unit/pothos-types.test.ts` pins the replacement with
  negative controls, and `test/workers/pothos.test.ts` runs on the real generic against a
  real D1 binding.

- **`AggregatedField`.** Raised as an open question when the interface was scoped. Grepped
  again against the plugin's runtime code: it references neither `AggregatedField` nor a
  relation-count key, so `with` does not have to handle an aggregate in place of a
  relation. The question is closed and nothing is owed.
- **drizzle-graphql** was removed from this repo's devDependencies. It had sat there with
  no test importing it, which is exactly the shape of an unverified claim, and it branches
  on `is(db, BaseSQLiteDatabase)` — the gap above. It is not claimed as supported.
