# orm-d1 — documentation

orm-d1 is an ORM for Cloudflare D1 on Workers. Its API is taken from Drizzle; it shares no
code with `drizzle-orm` and does not depend on it.

| Doc | Contents |
| --- | --- |
| [01-differences.md](./01-differences.md) | Ten cases where behaviour departs from `drizzle-orm` on D1: the call, what Drizzle does with it, what orm-d1 does. Ends with the table of which D1 limit is checked where |
| [02-beyond-drizzle.md](./02-beyond-drizzle.md) | The seven features with no spelling in Drizzle: append-only tables and columns, `latestPerGroup`, `STRICT` / `WITHOUT ROWID`, `impact`, `backfill`, roundtrip drafts, vocabulary drift |
| [03-relational-queries.md](./03-relational-queries.md) | `defineRelations`, the `db.query` filter DSL, `count`, and the SQL each `with` strategy emits |
| [04-migrating-from-drizzle.md](./04-migrating-from-drizzle.md) | The import change, the path alias, its silent failure mode, and the supported and unsupported lists |
| [05-adapters.md](./05-adapters.md) | `@pothos/plugin-drizzle`, and the Better Auth adapter |
| [06-entry-points.md](./06-entry-points.md) | The seven import paths, and which optional peer each one needs |
| [07-security.md](./07-security.md) | What the compiler guarantees, the three APIs that opt out of it, and why the filter DSL is a trust boundary rather than an input format |
| [../kit/README.md](../kit/README.md) | `orm-d1-kit`: configuration, environment resolution, commands, and what it does differently from `drizzle-kit` |

Tests run in two projects: Node for the layers above the runtime, and workerd with a real
D1 binding for everything that touches the platform. Every claim here about D1's or
SQLite's behaviour is asserted in the second.
