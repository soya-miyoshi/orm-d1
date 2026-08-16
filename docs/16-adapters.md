# 16 — Adapters: Pothos and Better Auth

Drizzle has no public API for describing a schema, so adapters read its internals:
`entityKind`, `Symbol.for('drizzle:Columns')`, `db._.relations`. d1zzle tables and columns
carry those, so Drizzle's own helpers work on them:

```ts
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteInteger, SQLiteTable } from 'drizzle-orm/sqlite-core';

is(users, SQLiteTable);       // true
is(users.id, SQLiteInteger);  // true
getTableColumns(users);       // { id, email, name }
```

Drizzle `SQL` fragments built over d1zzle columns — `eq(users.id, 1)`, `inArray(...)`,
`` sql`…` `` — render correctly inside a d1zzle query, which is how an adapter's own
predicates reach the database.

The reasoning, and a survey of the rest of the ecosystem with what each one would cost, is
[10-ecosystem-interop](./10-ecosystem-interop.md).

## Pothos

`test/workers/pothos.test.ts` runs a GraphQL schema over a d1zzle database inside workerd
with `@pothos/plugin-drizzle`. Two substitutions are required:

```ts
import type { PothosRelations } from 'd1zzle/drizzle';
import { asPothosRelations } from 'd1zzle/drizzle';
import { getTableConfig } from 'd1zzle';           // ours, not drizzle-orm/sqlite-core's

const builder = new SchemaBuilder<{ DrizzleRelations: PothosRelations<typeof relations> }>({
  plugins: [DrizzlePlugin],
  drizzle: { client: db, getTableConfig, relations: asPothosRelations(relations) },
});
```

- `getTableConfig` must be d1zzle's. Drizzle's derives constraints by running a table's
  `ExtraConfigBuilder`, which a d1zzle table does not have, so it reports the columns and
  leaves every other field empty — and the plugin then cannot find a composite primary key.
  The plugin reads `getTableConfig` from its own config, so substituting it is enough.
- `asPothosRelations` re-prototypes the relations onto Drizzle's `One`/`Many`. The plugin
  is duck-typed everywhere except `relationField instanceof Many`, which decides whether a
  field is a GraphQL list. `instanceof` consults the right-hand constructor, so no
  structural match satisfies it; without this, every `many` relation resolves as a single
  object.

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

`d1zzle/better-auth` is a Better Auth database adapter written against
`createAdapterFactory`, not a shim over the Drizzle one:

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

Write the four tables with `sqliteTable` as usual — the schema in Better Auth's Drizzle
documentation ports over unchanged — and generate the migration with `d1zzle-migrate`.
Model names map to tables through `schema`; field names map to columns through Better
Auth's own `fields` option.

The reason for a separate adapter: everything in the section above is about being *read*.
Better Auth's Drizzle adapter instead *executes* through drizzle-orm — `db.insert(t)
.values(…)`, `eq()`, `and()`, its dialect and session layer. `asDrizzleSchema()` retypes a
schema; it cannot retype a runtime, and a d1zzle table fails there on the first write.
`createAdapterFactory` takes ten methods over `{ model, where, data }` and supplies the
mapping, id generation and transforms itself, so it needs no Drizzle at all.

`consumeOne` and `incrementOne` are implemented as one `RETURNING` statement pinned to a
single row. Better Auth's fallbacks for them are built on transactions, which D1 does not
have, and a fallback would leave a read-then-write gap in exactly the operations where
only one caller may win — consuming a verification token, decrementing a guarded counter.
`test/workers/better-auth.test.ts` races them against real D1 and asserts the counts.

`experimental.joins` is not supported: the adapter raises a named error rather than
dropping the joined models. There is no `createSchema` for `@better-auth/cli generate`,
because in a d1zzle project the schema file is what `d1zzle-migrate` diffs against, and
generating it from Better Auth's model list would invert the source of truth.
