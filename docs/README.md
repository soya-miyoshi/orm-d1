# d1zzle — documentation

d1zzle is a type-safe SQL query builder / ORM built **exclusively** for Cloudflare D1
running inside Cloudflare Workers. It takes its ergonomics and API shape from Drizzle, but
shares no code with it and does not depend on it.

## Using d1zzle

For someone with the library installed. The [README](../README.md) indexes the same set.

| Doc | Contents |
| --- | --- |
| [12-drizzle-differences.md](./12-drizzle-differences.md) | Ten cases where behaviour departs from `drizzle-orm` on D1: the call, what Drizzle does with it, what d1zzle does. Ends with the table of which D1 limit is checked where |
| [13-relational-queries.md](./13-relational-queries.md) | `defineRelations`, the `db.query` filter DSL, `count`, and the SQL each `with` strategy emits |
| [15-migrating-from-drizzle.md](./15-migrating-from-drizzle.md) | The import change, the path alias, its silent failure mode, and the supported and unsupported lists |
| [16-adapters.md](./16-adapters.md) | `@pothos/plugin-drizzle`, and the Better Auth adapter |
| [17-entry-points.md](./17-entry-points.md) | The seven import paths, and which optional peer each one needs |
| [18-beyond-drizzle.md](./18-beyond-drizzle.md) | Features with no spelling in Drizzle: append-only tables and columns, `latestPerGroup`, `impact`, `backfill`, roundtrip drafts, vocabulary drift |
| [../kit/README.md](../kit/README.md) | `d1zzle-migrate`: configuration, environment resolution, commands, and what it does differently from `drizzle-kit` |

## The design, in order

Why it is built the way it is. Read in this order.

| Doc | What it covers |
| --- | --- |
| [01-principles.md](./01-principles.md) | Goals, non-goals, and the rules every design decision is judged against |
| [02-d1-platform.md](./02-d1-platform.md) | The exact substrate: D1's API surface, its limits, and its cost model |
| [03-architecture.md](./03-architecture.md) | Module layout, layering, data flow, public API shape |
| [04-type-inference.md](./04-type-inference.md) | Schema types, builder state threading, keeping `tsc` fast |
| [05-query-compilation.md](./05-query-compilation.md) | The plan IR, compile-once caching, param plans, row mappers |
| [06-runtime.md](./06-runtime.md) | Execution, result mapping, `batch()`, the Sessions API, observability |
| [07-roadmap.md](./07-roadmap.md) | Phased implementation plan and current status |
| [08-drizzle-compatibility.md](./08-drizzle-compatibility.md) | Accepting existing Drizzle schemas with a one-line import change |
| [09-d1zzle-migrate.md](./09-d1zzle-migrate.md) | The migration CLI: commands, table recreation, drift detection |
| [10-ecosystem-interop.md](./10-ecosystem-interop.md) | Being recognised by Drizzle's adapters: `entityKind`, symbols, the one gap that cannot be closed — and Better Auth, where being recognised is not enough and we ship a native adapter. Ends with a survey of the rest of the ecosystem and what each one would cost |
| [11-security.md](./11-security.md) | What the compiler guarantees, the escape hatches that opt out of it, and why the filter DSL is a trust boundary rather than an input format |

## The short version

Two product commitments frame the work:

- **Existing Drizzle schemas work unchanged**, modulo the import specifier — or with zero
  diff via a path alias — and **Drizzle's adapters accept them too**. See
  [08](./08-drizzle-compatibility.md) and [10](./10-ecosystem-interop.md).
- **`d1zzle-migrate` is a first-class deliverable**, not an afterthought, because `drizzle-kit`
  on D1 is the weakest part of the current story. It is a devDependency and adds zero bytes
  to the Worker bundle. See [09](./09-d1zzle-migrate.md).

Three technical decisions drive most of the architecture:

1. **Read results positionally via `.raw()`, not `.all()`.** D1 builds a keyed object per
   row; we don't need it, and duplicate column names in joins silently collide inside it.
   We know the projection at compile time, so we map arrays positionally.
   See [02](./02-d1-platform.md#reading-rows-all-vs-raw).

2. **Compile each query once, not once per request.** Builders are immutable and memoize
   their own compilation. A builder hoisted to module scope in a Worker isolate pays SQL
   generation exactly once, then only re-binds parameters.
   See [05](./05-query-compilation.md).

3. **`batch()` is the only atomic primitive; there is no `transaction()`.** D1 has no
   interactive transactions. Shipping a `transaction()` that emits `BEGIN`/`COMMIT` is a
   correctness footgun, and omitting it deletes a whole subsystem.
   See [02](./02-d1-platform.md#no-interactive-transactions).

## Status

Implemented and tested end to end: the query builder, the runtime, relations, the DDL
generator and `d1zzle-migrate`. Tests run in two projects — Node for the pure layers, workerd
with a real D1 binding for everything that touches the platform.

See [07-roadmap.md](./07-roadmap.md) for the milestone table and, more importantly, for the
places where the implementation deliberately departs from these documents.
