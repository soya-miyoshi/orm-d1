# Entry points and dependencies

| Import | Contents |
| --- | --- |
| `d1zzle` | schema, queries, runtime, relations |
| `d1zzle/core` | the same, minus relations — the smallest entry |
| `d1zzle/sqlite-core` | the Drizzle-named schema surface, for import aliasing |
| `d1zzle/ddl` | schema → `CREATE TABLE` / `CREATE INDEX`, and `tableOptions()` |
| `d1zzle/relations` | `defineRelations()`, `db.query`, the filter DSL |
| `d1zzle/drizzle` | the bridge to `drizzle-orm`: `asDrizzleSchema`, `asDrizzleRelations` |
| `d1zzle/better-auth` | `d1zzleAdapter()` |

`package.json` declares `"dependencies": {}`. `drizzle-orm` and `better-auth` are optional
peers, and each is confined to one entry point:

- `d1zzle`, `d1zzle/core`, `d1zzle/sqlite-core`, `d1zzle/ddl` and `d1zzle/relations` import
  neither, at runtime or for types. Both can be absent from `node_modules`.
- `d1zzle/drizzle` imports `drizzle-orm`'s types for `asDrizzleSchema` / `asDrizzleTable`,
  and its `One`/`Many` classes at runtime for `asDrizzleRelations`. Importing that module
  is what makes `drizzle-orm` required, which is why nothing else re-exports it.
- `d1zzle/better-auth` imports `createAdapterFactory` from `better-auth/adapters` at
  runtime. Only a project calling `d1zzleAdapter()` needs `better-auth` installed.

The peer range is `>=1.0.0-rc.1`: d1zzle presents v1's interface, and `asDrizzleRelations`
prototypes onto v1's `OneV2` / `ManyV2`. On v0 it would prototype onto the wrong classes.
Verified against rc.1 and rc.4.

There is no `eval`, no `new Function` and no `child_process` in either package, and `src/`
uses no Node builtins.

What `d1zzle/drizzle` exists for is [05-adapters](./05-adapters.md).
