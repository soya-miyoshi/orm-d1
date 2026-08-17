# Entry points and dependencies

| Import | Contents |
| --- | --- |
| `orm-d1` | schema, queries, runtime, relations |
| `orm-d1/core` | the same, minus relations — the smallest entry |
| `orm-d1/sqlite-core` | the Drizzle-named schema surface, for import aliasing |
| `orm-d1/ddl` | schema → `CREATE TABLE` / `CREATE INDEX`, and `tableOptions()` |
| `orm-d1/relations` | `defineRelations()`, `db.query`, the filter DSL |
| `orm-d1/drizzle` | the bridge to `drizzle-orm`: `asDrizzleSchema`, `asDrizzleRelations` |
| `orm-d1/better-auth` | `ormD1Adapter()` |

`package.json` declares `"dependencies": {}`. `drizzle-orm` and `better-auth` are optional
peers, and each is confined to one entry point:

- `orm-d1`, `orm-d1/core`, `orm-d1/sqlite-core`, `orm-d1/ddl` and `orm-d1/relations` import
  neither, at runtime or for types. Both can be absent from `node_modules`.
- `orm-d1/drizzle` imports `drizzle-orm`'s types for `asDrizzleSchema` / `asDrizzleTable`,
  and its `One`/`Many` classes at runtime for `asDrizzleRelations`. Importing that module
  is what makes `drizzle-orm` required, which is why nothing else re-exports it.
- `orm-d1/better-auth` imports `createAdapterFactory` from `better-auth/adapters` at
  runtime. Only a project calling `ormD1Adapter()` needs `better-auth` installed.

The peer range is `>=1.0.0-rc.1`: orm-d1 presents v1's interface, and `asDrizzleRelations`
prototypes onto v1's `OneV2` / `ManyV2`. On v0 it would prototype onto the wrong classes.
Verified against rc.1 and rc.4.

There is no `eval`, no `new Function` and no `child_process` in either package, and `src/`
uses no Node builtins.

What `orm-d1/drizzle` exists for is [05-adapters](./05-adapters.md).
