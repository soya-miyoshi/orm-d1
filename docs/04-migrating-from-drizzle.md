# 15 — Migrating an existing project

Change the import specifier:

```diff
- import { drizzle } from 'drizzle-orm/d1';
- import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
+ import { drizzle, sqliteTable, text, integer } from 'd1zzle';
```

For a zero-diff migration, alias the modules instead of editing files:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "drizzle-orm": ["./node_modules/d1zzle/dist/index.js"],
      "drizzle-orm/d1": ["./node_modules/d1zzle/dist/index.js"],
      "drizzle-orm/sqlite-core": ["./node_modules/d1zzle/dist/sqlite-core.js"]
    }
  }
}
```

Point at the `.js`, not the `.d.ts`. Getting this wrong fails silently: the build
succeeds, the types are d1zzle's, the editor is satisfied, and the Worker runs on
`drizzle-orm`. esbuild — wrangler's bundler — honours `paths` for module resolution but
cannot bundle a declaration file, so it falls through to node resolution and finds the real
`drizzle-orm`, which is installed by definition during a migration. TypeScript picks up the
sibling `.d.ts` from the `.js` path on its own, so types are unaffected. Set `baseUrl` as
well; a relative `./node_modules/…` path resolved without it depends on the bundler's
working directory.

Bundling a two-import Worker with each target, unminified — these numbers identify which
library ended up in the bundle rather than measure its size:

| `paths` target | bundle | contains |
| --- | --- | --- |
| `dist/index.d.ts` | 175 kB | `drizzle-orm` — the mapping did nothing |
| `dist/index.js` | 81 kB | d1zzle |

`test/unit/module-resolution.test.ts` bundles that fixture and asserts it.

## What carries over

**Supported unchanged:** `sqliteTable` · every column type and `mode` · `.notNull()`
`.primaryKey({ autoIncrement })` `.default()` `.$defaultFn()` `.$onUpdate()` `.$type<T>()`
`.references()` `.unique()` `.generatedAlwaysAs()` · `index()` `uniqueIndex()`
`primaryKey()` `foreignKey()` `unique()` `check()` · both table-extras forms · the `sql`
tag · the comparison and aggregate operators · `defineRelations()` and `db.query` ·
`InferSelectModel` / `InferInsertModel`.

**Not supported:**

- `transaction()` — throws, with a pointer to `batch()`.
- The v0 `relations()` API, and the `where`/`orderBy` callback forms. d1zzle presents v1's
  interface only. The old `schema` option is accepted and ignored.
- Views, CTEs and set operations. They are absent rather than silently no-op.
- Drizzle's execution plan for relational queries is not adopted, only its interface.

The schema DSL is a strict subset of `drizzle-orm/sqlite-core`: every symbol usable in a
schema file also exists there with the same meaning. That is what makes the aliasing work
in both directions, and it is why `STRICT`, `WITHOUT ROWID` and the append-only trigger are
configured in a separate `tableOptions` module rather than on the table.

Where the behaviour differs once the imports are changed is
[01-differences](./01-differences.md).
