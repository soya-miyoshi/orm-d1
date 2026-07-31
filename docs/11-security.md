# 11 — Security model

What d1zzle guarantees, what it does not, and where the boundary between the two sits.

The short version: **values are always bound and identifiers are always quoted**, so
d1zzle does not produce injectable SQL from data. What it *does* produce, on request, is a
query — and a query built from an attacker's description is an attacker's query, however
carefully every value in it was bound. That distinction is most of this document.

## What the compiler guarantees

These hold for every query the builder emits, and are the properties to re-check whenever
`plan/compile.ts` or `sql/` changes.

- **Every value binds.** `Writer` appends fixed keywords, `quoteIdentifier(...)` output, or
  the result of rendering a chunk. There is no path from a JavaScript value to SQL text.
- **Every identifier is quoted, with interior quotes doubled.** Four modules implement this
  independently — `sql/sql.ts`, `relations/joined.ts` (raw `json_object` construction),
  `ddl.ts` (`literal`, for `'`), and `kit/core/sql.ts` — and they have to agree. A
  projection key, a table alias and a column name are all identifiers; none can break out.
- **`limit` / `offset` are validated, not trusted.** They are the only values that reach the
  SQL text unbound, because keeping them literal is what lets a query with a fixed limit
  memoize. A non-placeholder value goes through `Number.isFinite` and `Math.trunc`, so
  `limit(Number(searchParams.get('n')))` fails closed on `NaN` rather than interpolating it.
- **DDL parameter inlining uses a NUL sentinel**, not a `?` count, so a literal `?` inside a
  `sql.raw(...)` check constraint cannot be mistaken for a bound slot.
- **Bound parameters never leave the process outside `__DEV__`.** They are stripped from
  `QueryEvent` and `D1zzleQueryError`; the SQL text always rides along, and contains no
  values. See [06](./06-runtime.md#observability).

## The escape hatches, and what they cost

Three APIs hand you the pen. All three are documented as such, and none of them can be
made safe by d1zzle:

| API | What it skips |
| --- | --- |
| `sql.raw(value)` | Everything. The string is emitted verbatim. |
| `db.execute(sql, params)` | The builder entirely; you supply the statement text. |
| `RAW` in the filter DSL | Nothing is parsed — you hand back a fragment. |

`sql.raw` is the one to watch, because it is easy to reach for when composing an identifier
that is not known until run time. If you need a caller-chosen column or sort direction,
resolve it against an allow-list you wrote and pass the resulting **column object**, never
the caller's string:

```ts
// Wrong — a caller-controlled identifier reaches SQL text unescaped.
.orderBy(sql.raw(`"${req.query.sort}" desc`))

// Right — the caller picks from a set you defined; the column object renders itself.
const SORTABLE = { name: users.name, created: users.createdAt };
const column = Object.hasOwn(SORTABLE, sort) ? SORTABLE[sort] : users.id;
.orderBy(desc(column))
```

Note the `hasOwn`. That is not defensiveness for its own sake — see below.

## The filter DSL is a query language

`db.query.<table>.find*` takes a `FindConfig` whose `where`, `orderBy`, `columns` and `with`
keys describe a query. It is deliberately JSON-shaped: that is what lets Pothos pass a
GraphQL `where` argument straight through, and it is the shape a client would send.

**Handing an untrusted object to it delegates query construction to the caller.** Nothing
is injected — every value still binds, every key is still checked against the real column
list — and the data still leaves:

```ts
// Do not do this with a request body.
db.query.users.findMany({ where: await request.json() })
```

A caller who reaches that can:

- **Read any column of the table by oracle**, without selecting it.
  `{ passwordHash: { like: 'a%' } }` answers one character per request; nothing in the
  projection has to mention the column for the filter to test it.
- **Traverse into related tables.** A relation key compiles to a correlated `exists (…)`
  against the target, so the reach is the relation graph, not the one table queried.
- **Choose the query plan.** An unindexed predicate over a large table is a slow query the
  caller selected, and on D1 `rows_read` is billed.

None of this is a defect in the DSL — it is what a filter language *is*. The rule is that
the boundary belongs to your application:

- **Project the client's filter onto one you build.** Accept a small, named set of
  filterable fields and operators and construct the `where` yourself. This is the only
  approach that holds as the schema grows a column you did not think about.
- **Or scope it.** If you must pass a filter through, `AND` it with a predicate the caller
  cannot influence — tenant id, owner id, `deleted_at is null` — and strip `RAW`.
- **Never mix trust levels in one object.** `{ ...userFilter, tenantId }` is not a scope: a
  caller-supplied `OR` at the top level answers around it.

The same applies to `columns` (which fields come back), `with` (how far the traversal goes)
and `orderBy`. `limit` is the one d1zzle bounds for you only in the sense that it validates
the *type*; a caller-chosen `limit` of 100000 is a caller-chosen `rows_read` bill.

### Prototype keys

Every one of those config keys is resolved against a plain object — a bag of columns, or of
relations. `columns['constructor']` is `Object`, which is truthy, so a bare index walks
straight past an unknown-field refusal and compiles a *function* into the parameter list.
`bind()` then rejects it at execution time: a clean 400 turns into an unhandled 500, and
`JSON.parse` makes `__proto__` an own key, so it survives `Object.entries` too.

Every such lookup therefore goes through `Object.hasOwn`, and the same applies to
`update().set()`, whose keys routinely come from a request body. The guard is about *where
the key lives*, not how it is spelled: a real column named `constructor` still works. The
sites are pinned by `test/unit/relations-filter.test.ts`,
`test/unit/relations-config-keys.test.ts` and the `set()` suite in
`test/unit/compile-write.test.ts`.

## Error messages disclose schema

An unknown filter field is refused with the list of columns and relations that would have
been valid. That is the right trade for a developer typo and the wrong one for a probing
client, so **do not forward d1zzle error messages to untrusted callers**. `CompileError`
and `D1zzleQueryError` are the two to catch; the latter also carries `.sql`.

Compile-time refusals are reachable from caller-controlled input in a few places by size
rather than by content — an `inArray` list past the bound-parameter budget, a `like` pattern
past D1's 50-byte cap. Bound the input before it reaches the builder if the size is the
caller's to choose.

## The migration CLI

`d1zzle-migrate` is a devDependency and ships no bytes to the Worker, but it holds
credentials and writes to production databases.

- **`--remote` needs a Cloudflare API token with D1 write scope.** Prefer
  `CLOUDFLARE_API_TOKEN` in the environment. `d1.token` in `d1zzle.config.ts` is supported
  for completeness, but a config file is a thing that gets committed; the token is never
  logged either way.
- **It imports your schema module to read it**, which executes that module. The schema is
  your own source, but it is worth knowing the CLI runs code rather than parsing files.
- **Destructive statements are refused unless you pass `--accept-data-loss`**, and `pull`
  will not overwrite an existing schema file without `--force`.

## Supply chain

- **`src/` has zero runtime dependencies** and no `node:` builtins. There is no transitive
  package to audit in what reaches your Worker.
- **No `eval`, no `new Function`, no `child_process`** anywhere in either package. The row
  mapper is a monomorphic loop specifically so it need not compile code (rule R2).
- **Publishing is npm trusted publishing (OIDC)** with automatic provenance attestation.
  There is no long-lived `NPM_TOKEN` in CI to leak. See `RELEASING.md`.

## Reporting — welcome, but do not wait on it

This project is not open to contributions and has no dedicated security process. You are
welcome to open an issue for a vulnerability, and for anything already public that is
probably the right call — it warns other people running forks. But **there is no embargo
process, no guaranteed response, no advisory, and no promise that a patched version ships.**
See [CONTRIBUTING](../CONTRIBUTING.md).

That changes what this document is for. It is not a promise backed by a maintainer who will
answer when the promise fails — it is a description of how the code behaves, written so
that **you can audit your own fork**. The guarantees in the first section are properties to
verify and keep verifying, not assurances to rely on.

So: report it if it helps others, but do not hold your own users' safety on a fix arriving
from upstream. Fix it in your fork and tell them.
