# d1zzle — documentation

d1zzle is a type-safe SQL query builder / ORM built **exclusively** for Cloudflare D1
running inside Cloudflare Workers. It takes its ergonomics and API shape from Drizzle, but
shares no code with it and does not depend on it.

## Using d1zzle

Written for someone with the library installed. Start here; the [README](../README.md) is
the index of the same set.

| Doc | What it covers |
| --- | --- |
| [12-drizzle-differences.md](./12-drizzle-differences.md) | Where behaviour departs from `drizzle-orm` on D1, case by case: what Drizzle does, what d1zzle does, and which property of the platform forces it. Ends with the table of which D1 limit is enforced where |
| [13-relational-queries.md](./13-relational-queries.md) | `defineRelations`, the `db.query` filter DSL, `count`, and the two plans a `with` can run under |
| [14-migrations.md](./14-migrations.md) | `d1zzle-migrate`, and what it does differently from `drizzle-kit` because the target is D1. Full CLI reference: [kit/README.md](../kit/README.md) |
| [15-migrating-from-drizzle.md](./15-migrating-from-drizzle.md) | The one-line import change, the zero-diff path alias and its silent failure mode, and what is and is not supported |
| [16-adapters.md](./16-adapters.md) | Pothos, and the native Better Auth adapter |
| [17-entry-points.md](./17-entry-points.md) | The seven import paths, and which optional peer each one needs |
| [18-beyond-drizzle.md](./18-beyond-drizzle.md) | What Drizzle has no spelling for: append-only tables and columns, `latestPerGroup`, `impact`, `backfill`, roundtrip drafts, vocabulary drift |

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
