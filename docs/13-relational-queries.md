# 13 — Relational queries

```ts
import { defineRelations, drizzle } from 'd1zzle';

export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}));

const db = drizzle({ client: env.DB, relations });   // or drizzle(env.DB, { relations })

const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: { posts: { columns: { title: true }, where: { views: { gt: 100 } } } },
  orderBy: { id: 'desc' },
  limit: 10,
});
```

This is Drizzle v1's interface: `defineRelations`, the RQBv2 `db.query` config, and v1's
`getTableConfig` shape. The v0 `relations()` API is not supported.

The join is stated once, with `from`/`to` on either side; the other side picks it up.
`optional: false` on a `one` relation removes `| null` from the inferred type.

`where` is an object DSL. A bare scalar means equality, so `{ id: 1 }` is
`{ id: { eq: 1 } }`. Besides the per-column operators (`eq` `ne` `gt` `gte` `lt` `lte`
`in` `notIn` `like` `ilike` `notLike` `notIlike` `isNull` `isNotNull`) there are `AND`,
`OR`, `NOT`, a `RAW` escape hatch, and relation keys: `{ posts: { views: { gt: 100 } } }`
filters users by their posts, compiled as a correlated `exists` in the parent's own query.

Every operator accepts a `ph()` placeholder except `in` and `notIn`, which take a literal
array or a subquery — `in (…)` renders one parameter per value, so the count is part of
the SQL text and a placeholder filled after compilation could only ever fill one slot.
Passing one is a `CompileError` naming the column.

`count` takes the same `where`, including relation keys, and answers how many rows
`findMany` would return without a limit:

```ts
const where = { status: { in: ['paid', 'shipped'] } };

const rows  = await db.query.orders.findMany({ where, orderBy: { id: 'desc' }, limit: 20 });
const total = await db.query.orders.count({ where });
```

It accepts no `with`, `limit` or `offset`: relations are stitched rather than joined, so
none of them changes the total.

## How a `with` is executed

Two plans, selected with `relationalStrategy`. Both return identical results — the workers
suite runs a matrix of queries through each and deep-compares them against a real D1
database — so the choice affects timing only.

```ts
const db = drizzle({ client: env.DB, relations });                              // 'split' (default)
const db = drizzle({ client: env.DB, relations, relationalStrategy: 'joined' });
```

`'split'` runs one query per relation level and stitches the rows in JavaScript. Levels
cost round trips; rows do not — two parents or two thousand, a level is one query with an
`in`, which collapses to `json_each` past the parameter budget.

```sql
select "id", "email" from "users"
select "id", "title" from "posts" where "author_id" in (?, ?)
```

`'joined'` answers the whole tree in one statement, each relation a correlated subquery
wrapped in `json_group_array` / `json_object` — the shape Drizzle v1 produces on SQLite.
SQLite has no `LATERAL`, so it is a correlated subquery rather than the lateral join
Drizzle emits on Postgres; the two are equivalent here.

```sql
select "d0"."id",
  (select json_group_array(json_object('id', "id", 'title', "title"))
   from (select "d1"."id" as "id", "d1"."title" as "title"
         from "posts" as "d1" where "d0"."id" = "d1"."author_id") as "t") as "posts"
from "users" as "d0"
```

Neither dominates. Joined makes one call and runs the inner query once per outer row;
split makes one call per level and does one index scan each. The default is split because
its failure modes are visible: `rows_read` is predictable, no function-argument cap
constrains the projection, and the SQL in a log is readable.

`'joined'` falls back to split, per query and silently, for anything it cannot express as
a correlated subquery:

| Falls back when | Why |
| --- | --- |
| a relation goes `through` a junction table | needs a join inside the inner select |
| a payload holds a `blob` column | `json_object` rejects binary — *JSON cannot hold BLOB values* |
| a payload is wider than 63 keys | `json_object` costs 2 arguments per key against SQLite's 127-argument cap |
| a nested `limit`/`offset` is a placeholder | split cannot take one, and the strategy must not change which queries are legal |

Three further properties of the split plan:

- Relations at the same level are fetched concurrently, so round trips scale with the
  *depth* of the `with` tree, not the number of relations in it.
- A nested `limit`/`offset` is a page per parent, taken with a `row_number()` window so
  the level stays one query. One query per parent would be an unbounded fan-out against
  the Workers subrequest limit.
- Join keys are fetched whether or not you selected them, and removed from the rows before
  they are returned. A parent with no children gets `[]` for a `many` and `null` for a
  `one`, never a missing key. A `where` on a child narrows the children, not the parents.

## Many-to-many

Declared with `.through()` on both ends:

```ts
articles: {
  tags: r.many.tags({
    from: r.articles.id.through(r.articleTags.articleId),
    to: r.tags.id.through(r.articleTags.tagId),
  }),
},
```

## The filter DSL is a trust boundary

Before passing a client-supplied object to `findMany`, read
[11-security](./11-security.md#the-filter-dsl-is-a-query-language): the filter DSL is a
query language, and handing one an untrusted body delegates query construction to the
caller.
