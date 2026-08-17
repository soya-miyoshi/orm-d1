# Adapters: Pothos and Better Auth

Drizzle has no public API for describing a schema, so adapters read its internals:
`entityKind`, `Symbol.for('drizzle:Columns')`, `db._.relations`. orm-d1 tables and columns
carry those, so Drizzle's own helpers work on them:

```ts
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteInteger, SQLiteTable } from 'drizzle-orm/sqlite-core';

is(users, SQLiteTable);       // true
is(users.id, SQLiteInteger);  // true
getTableColumns(users);       // { id, email, name }
```

Drizzle `SQL` fragments built over orm-d1 columns — `eq(users.id, 1)`, `inArray(...)`,
`` sql`…` `` — render correctly inside an orm-d1 query, which is how an adapter's own
predicates reach the database.

## Pothos

`test/workers/pothos.test.ts` runs a GraphQL schema over an orm-d1 database inside workerd
with `@pothos/plugin-drizzle`. Two substitutions are required:

```ts
import type { PothosRelations } from 'orm-d1/drizzle';
import { asPothosRelations } from 'orm-d1/drizzle';
import { getTableConfig } from 'orm-d1';           // ours, not drizzle-orm/sqlite-core's

const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof relations> }>({
  plugins: [DrizzlePlugin],
  drizzle: { client: db, getTableConfig, relations: asPothosRelations(relations) },
});
```

- `getTableConfig` must be orm-d1's. Drizzle's derives constraints by running a table's
  `ExtraConfigBuilder`, which an orm-d1 table does not have, so it reports the columns and
  leaves every other field empty — and the plugin then cannot find a composite primary key.
  The plugin reads `getTableConfig` from its own config, so substituting it is enough.
- `asPothosRelations` re-prototypes the relations onto Drizzle's `One`/`Many`. The plugin
  is duck-typed everywhere except `relationField instanceof Many`, which decides whether a
  field is a GraphQL list. `instanceof` consults the right-hand constructor, so no
  structural match satisfies it; without this, every `many` relation resolves as a single
  object.

  `instanceof` also fails silently if *your app* resolves a different `drizzle-orm` copy
  than orm-d1 did — a lockfile that hoists two versions, a range bump in any dependency —
  because `asDrizzleRelations` re-prototypes onto the copy orm-d1 resolved, and
  `instanceof` checks the caller's own `Many`. `assertSameDrizzle({ Many })` (also from
  `orm-d1/drizzle`), called with the `Many` your own code resolves, proves exactly that —
  the calling code and orm-d1 share one `Many`/instance. It cannot see what a third-party
  adapter resolved *internally*: there is no way to import a package's private copy of
  `drizzle-orm` from outside it. In the ordinary case — one `drizzle-orm` dependency,
  nothing forcing npm/pnpm to hoist a second copy — the adapter shares the same resolution
  as your app, so this transitively covers it; that is a fact about your dependency tree,
  not something the call verifies on the adapter's behalf. Put this in your own suite:

  ```ts
  import { Many } from 'drizzle-orm';
  import { assertSameDrizzle } from 'orm-d1/drizzle';
  assertSameDrizzle({ Many });
  ```

  it throws with a clear message when the two copies diverge, instead of leaving every
  list field silently returning one object.

  If you would rather assert on a live relation object than on the class identity alone,
  search every declared relation for one that is a `Many` — not `Object.values(r)[0]`,
  which is wrong the moment a relation is declared from the *child* side (`r.one.users(…)`
  on `posts`, with nothing declared on `users` itself — see `defineRelations` in
  `src/relations/define.ts`) or the first relation you happen to hit is a `One`:

  ```ts
  import { Many } from 'drizzle-orm';
  import { asDrizzleRelations } from 'orm-d1/drizzle';
  const r = asDrizzleRelations(relations);
  const anyMany = Object.values(r)
    .flatMap((table) => Object.values(table.relations))
    .find((relation) => relation instanceof Many);
  expect(anyMany).toBeInstanceOf(Many);
  ```

  This needs at least one `many` relation declared anywhere in the schema to find; a
  schema with only `one` relations has nothing for it to assert on, and
  `assertSameDrizzle` above is the check to use instead.

- `pothosFindConfig(query, selection)` is the resolver-side counterpart: `query()` — the
  merged selection `@pothos/plugin-drizzle` hands every drizzle-backed resolver — carries a
  phantom `$pothosQueryFor` key in its type that is never actually constructed, so the
  merged config type-checks against nothing without it. `pothosFindConfig` drops that key
  and returns the selection's own type, so `db.query.<table>.findMany(pothosFindConfig(query,
  { where: { clubId } }))` still gets the schema-checked `where`/`columns`/`with`/`orderBy`
  that an `as never` cast would otherwise give up.

`asDrizzleSchema` / `asDrizzleTable` are identity functions at runtime. They exist because
Drizzle's `Column` declares a `protected` member, and TypeScript accepts protected members
only from the declaring class, so no independent implementation is assignable — they
compute the equivalent Drizzle types from metadata the columns already carry.
`asDrizzleRelations` is the one export that does runtime work, for the `instanceof` reason
above.

Pothos' relation types are checked rather than opted out of:
`test/unit/pothos-types.test.ts` pins the negative controls — an unknown column, an
unknown property on a resolver's row, a resolver whose return type disagrees with its
field, and an undeclared relation name are each rejected. `client` and `getTableConfig`
still require casts, because they slot against Drizzle's database and table classes and
the protected-member rule applies there.

## Better Auth

`orm-d1/better-auth` is a Better Auth database adapter written against
`createAdapterFactory`, not a shim over the Drizzle one:

```ts
import { betterAuth } from 'better-auth';
import { drizzle } from 'orm-d1';
import { ormD1Adapter } from 'orm-d1/better-auth';
import { user, session, account, verification } from './schema';

const auth = betterAuth({
  database: ormD1Adapter(drizzle(env.DB), {
    schema: { user, session, account, verification },
  }),
});
```

Write the four tables with `sqliteTable` as usual — the schema in Better Auth's Drizzle
documentation ports over unchanged — and generate the migration with `orm-d1-kit`.
Model names map to tables through `schema`; field names map to columns through Better
Auth's own `fields` option.

The reason for a separate adapter: everything in the section above is about being *read*.
Better Auth's Drizzle adapter instead *executes* through drizzle-orm — `db.insert(t)
.values(…)`, `eq()`, `and()`, its dialect and session layer. `asDrizzleSchema()` retypes a
schema; it cannot retype a runtime, and an orm-d1 table fails there on the first write.
`createAdapterFactory` takes ten methods over `{ model, where, data }` and supplies the
mapping, id generation and transforms itself, so it needs no Drizzle at all.

`consumeOne` and `incrementOne` are implemented as one `RETURNING` statement pinned to a
single row. Better Auth's fallbacks for them are built on transactions, which D1 does not
have, and a fallback would leave a read-then-write gap in exactly the operations where
only one caller may win — consuming a verification token, decrementing a guarded counter.
`test/workers/better-auth.test.ts` races them against real D1 and asserts the counts.

`experimental.joins` is not supported: the adapter raises a named error rather than
dropping the joined models. There is no `createSchema` for `@better-auth/cli generate`,
because in an orm-d1 project the schema file is what `orm-d1-kit` diffs against, and
generating it from Better Auth's model list would invert the source of truth.
