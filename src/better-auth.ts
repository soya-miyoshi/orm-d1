/**
 * `d1zzle/better-auth` — a Better Auth database adapter backed by d1zzle.
 *
 * Better Auth ships an official Drizzle adapter, but it cannot be pointed at a
 * d1zzle schema: it drives the database through drizzle-orm's *runtime* — it
 * calls drizzle column methods (`col.shouldDisableInsert()`), builds predicates
 * with drizzle's own `eq`/`and`, and reads `db.query` / `db._`. `d1zzle/drizzle`
 * closes the *type* gap for adapters that only read a schema's shape; it cannot
 * close a runtime gap, because our query builder is a different implementation
 * rather than a re-typing of theirs.
 *
 * So the bridge is built at the layer Better Auth actually designed for it.
 * `createAdapterFactory` takes a `CustomAdapter` — ten methods over
 * `{ model, where, data }` — and handles field mapping, id generation, input and
 * output transforms, and the plugin schema on top. That is the whole contract,
 * and it is expressible in d1zzle directly:
 *
 * ```ts
 * import { betterAuth } from 'better-auth';
 * import { drizzle } from 'd1zzle';
 * import { d1zzleAdapter } from 'd1zzle/better-auth';
 * import { user, session, account, verification } from './schema';
 *
 * const auth = betterAuth({
 *   database: d1zzleAdapter(drizzle(env.DB), {
 *     schema: { user, session, account, verification },
 *   }),
 * });
 * ```
 *
 * `better-auth` is an **optional peer**. Nothing else in d1zzle imports this
 * module, so a project that never calls `d1zzleAdapter` never loads it.
 *
 * ## What differs from the Drizzle adapter, and why
 *
 * **No transactions.** D1 has no interactive transactions — a `BEGIN` may land
 * on a different connection — so `transaction` is reported as `false` and
 * Better Auth runs those operations sequentially. That is not merely a missing
 * convenience: the factory's *fallbacks* for `consumeOne` and `incrementOne`
 * are built out of `transaction(findMany + deleteMany/updateMany)`, and without
 * a real transaction those degrade to a read-then-write race. Both are
 * therefore implemented natively here as a single `RETURNING` statement, which
 * is atomic on D1 and is also one round trip instead of two. See the methods.
 *
 * **`select` is honoured with a projection**, not a full row read, because on D1
 * the bytes you do not select are still `rows_read` you paid for.
 *
 * **No `createSchema`.** `npx @better-auth/cli generate` cannot emit a d1zzle
 * schema, because in a d1zzle project the schema file is the source of truth
 * that `d1zzle-migrate` diffs against — generating it from Better Auth's model
 * list would invert that. Write the tables in `d1zzle/sqlite-core` (the Better
 * Auth docs' Drizzle schema ports over unchanged) and run `d1zzle-migrate
 * generate`.
 */
import { createAdapterFactory } from 'better-auth/adapters';
import type { CleanedWhere, CustomAdapter, JoinConfig } from 'better-auth/adapters';
import type { Column } from './schema/columns.js';
import type { Table } from './schema/table.js';
import { getTableColumns, getTableName } from './schema/table.js';
import type { Condition } from './sql/expressions.js';
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
} from './sql/expressions.js';
import { exceedsBytes, MAX_PATTERN_BYTES } from './limits.js';
import { count } from './sql/functions.js';
import type { SQLChunk } from './sql/sql.js';
import { sql } from './sql/sql.js';
import type { D1zzleDatabase } from './runtime/database.js';

/** Raised for a misconfiguration this adapter can detect — a missing model, an
 *  unknown field, an operator used with the wrong value shape. Named so the
 *  message is attributable when it surfaces inside Better Auth's own stack. */
export class D1zzleAdapterError extends Error {
	override readonly name = 'D1zzleAdapterError';
}

export interface D1zzleAdapterConfig {
	/**
	 * Better Auth model name → the d1zzle table backing it.
	 *
	 * Unlike the Drizzle adapter this is required, not optional: d1zzle's
	 * `drizzle()` takes `relations`, not a flat `schema` bag, so there is no
	 * `db._.fullSchema` to fall back on and no way to guess which table is the
	 * `user`. Keys are Better Auth's model names (`user`, `session`, `account`,
	 * `verification`, plus any a plugin adds) *after* your `modelName`
	 * overrides — the same thing you would pass to `drizzleAdapter`.
	 */
	schema: Record<string, Table>;
	/** Append `s` to every model name before looking it up. @default false */
	usePlural?: boolean | undefined;
	/** Forwarded to the adapter factory's debug logging. @default false */
	debugLogs?: Parameters<typeof createAdapterFactory>[0]['config']['debugLogs'];
	/**
	 * Whether `Date` values may be handed to the driver as-is.
	 *
	 * True is right when your timestamp columns are `integer({ mode: 'timestamp' })`
	 * or `timestamp_ms` — d1zzle's encoder turns the `Date` into the epoch number
	 * the column stores. Set it to `false` if you declared them as plain `text`
	 * or `integer`, and Better Auth will hand over ISO strings instead.
	 *
	 * @default true
	 */
	supportsDates?: boolean | undefined;
	/**
	 * Whether `boolean` values may be handed to the driver as-is. True is right
	 * for `integer({ mode: 'boolean' })`; set it to `false` for a bare `integer`
	 * column and Better Auth will pass `0` / `1`.
	 *
	 * @default true
	 */
	supportsBooleans?: boolean | undefined;
	/**
	 * Better Auth's `useNumberId` needs the database to hand back an id it
	 * generated. That works on SQLite with `integer('id').primaryKey({
	 * autoIncrement: true })`, so this defaults to `true`; set it to `false` to
	 * make Better Auth generate string ids regardless.
	 *
	 * @default true
	 */
	supportsNumericIds?: boolean | undefined;
}

/** The subset of a d1zzle database this adapter uses. `drizzle(env.DB)` and
 *  `drizzle(env.DB, { relations })` both satisfy it. */
export type D1zzleAdapterDatabase = Pick<D1zzleDatabase, 'select' | 'insert' | 'update' | 'delete'>;

/** A `where` value that has to be an array for the operator to make sense. */
const arrayValue = (w: CleanedWhere, model: string): readonly unknown[] => {
	if (!Array.isArray(w.value)) {
		throw new D1zzleAdapterError(
			`The value for "${w.field}" on model "${model}" must be an array to use the "${w.operator}" operator.`,
		);
	}
	return w.value;
};

/**
 * Case-insensitive comparison.
 *
 * SQLite's `like` is already case-insensitive over ASCII, but `=` is not and
 * neither is either operator over non-ASCII, so `mode: 'insensitive'` is
 * rendered explicitly with `lower()` rather than left to the collation. This
 * matches what the Drizzle adapter does on SQLite.
 *
 * The value binds through the template tag rather than the column's encoder:
 * `lower()` only means anything for text, so there is no encoding to apply.
 */
const lowerEq = (column: Column<any>, value: unknown, negated: boolean): Condition =>
	negated
		? sql<boolean>`lower(${column}) <> lower(${value})`
		: sql<boolean>`lower(${column}) = lower(${value})`;

/**
 * Escape the LIKE metacharacters in a *value* before it is wrapped in the
 * wildcards the operator itself contributes.
 *
 * `contains` / `starts_with` / `ends_with` take their value straight from a
 * caller — the admin plugin's user search is the documented case — and `%` and
 * `_` are wildcards. Unescaped, `starts_with: '%'` matched every row instead of
 * none, and `_` matched any single character. The value always *bound*, so this
 * was never injection; it silently widened the predicate, which for a search
 * over `user` is the difference between no results and the whole table.
 *
 * SQLite has no default escape character, so every site that uses this has to
 * declare one with `ESCAPE` — see {@link patternCondition}. The backslash is
 * escaped first, or it would double-escape the sequences added after it.
 */
const escapeLikeValue = (value: unknown): string =>
	String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * `column like <pattern> escape '\'`.
 *
 * Built here rather than through `like()` from `sql/expressions.ts` because
 * that helper cannot declare an escape character — and neither can Drizzle's,
 * which is why the Drizzle adapter has the same widening bug.
 *
 * The pattern-length check is reproduced rather than inherited for the same
 * reason. D1 caps a LIKE pattern at 50 bytes and `like()` enforces that by
 * throwing `CompileError` from deep inside the query builder — an unhandled
 * throw out of an auth endpoint, naming neither the model nor the field. It is
 * still a refusal (the limit is D1's, and quietly truncating would answer a
 * different question), but it is now attributable, and it accounts for escaping
 * having made the pattern longer than what the caller typed.
 */
const patternCondition = (
	column: Column<any>,
	w: CleanedWhere,
	model: string,
	insensitive: boolean,
	wrap: (escaped: string) => string,
): Condition => {
	const pattern = wrap(escapeLikeValue(w.value));
	if (exceedsBytes(pattern, MAX_PATTERN_BYTES)) {
		throw new D1zzleAdapterError(
			`"${w.operator}" on "${model}"."${column.name}" builds a ${pattern.length}-character LIKE pattern, `
				+ `past D1's ${MAX_PATTERN_BYTES}-byte limit. Shorten the search term — note that a \`%\` or `
				+ '`_` in it is escaped, which costs one character each — or match on a narrower field.',
		);
	}
	return insensitive
		? sql<boolean>`lower(${column}) like lower(${pattern}) escape '\\'`
		: sql<boolean>`${column} like ${pattern} escape '\\'`;
};

const lowerIn = (column: Column<any>, values: readonly unknown[], negated: boolean): Condition => {
	// An empty set is a constant, and `in ()` is a syntax error.
	if (values.length === 0) return sql<boolean>`${negated ? sql.raw('1 = 1') : sql.raw('1 = 0')}`;
	const lowered = sql.join(values.map((v) => sql`lower(${v})`), ', ');
	return negated
		? sql<boolean>`lower(${column}) not in (${lowered})`
		: sql<boolean>`lower(${column}) in (${lowered})`;
};

/** Whether this comparison should be folded to lower case. Only strings have a
 *  case to ignore, so a non-string value silently keeps the sensitive path —
 *  the same rule the Drizzle adapter applies. */
const isInsensitive = (w: CleanedWhere): boolean =>
	w.mode === 'insensitive'
	&& (typeof w.value === 'string' || (Array.isArray(w.value) && w.value.every((v) => typeof v === 'string')));

/**
 * One `Where` entry as a d1zzle condition.
 *
 * `null` is special-cased ahead of the operators because SQL's `=` and `<>` are
 * never true against `null`; Better Auth means `is null` / `is not null` and
 * every other adapter reads it that way.
 */
const toCondition = (column: Column<any>, w: CleanedWhere, model: string): Condition => {
	const insensitive = isInsensitive(w);

	switch (w.operator) {
		case 'in':
			return insensitive
				? lowerIn(column, arrayValue(w, model), false)
				: inArray(column, arrayValue(w, model));
		case 'not_in':
			return insensitive
				? lowerIn(column, arrayValue(w, model), true)
				: notInArray(column, arrayValue(w, model));
		case 'contains':
			return patternCondition(column, w, model, insensitive, (v) => `%${v}%`);
		case 'starts_with':
			return patternCondition(column, w, model, insensitive, (v) => `${v}%`);
		case 'ends_with':
			return patternCondition(column, w, model, insensitive, (v) => `%${v}`);
		case 'lt':
			return lt(column, w.value);
		case 'lte':
			return lte(column, w.value);
		case 'gt':
			return gt(column, w.value);
		case 'gte':
			return gte(column, w.value);
		case 'ne':
			if (w.value === null) return isNotNull(column);
			return insensitive ? lowerEq(column, w.value, true) : ne(column, w.value);
		case 'eq':
		default:
			if (w.value === null) return isNull(column);
			return insensitive ? lowerEq(column, w.value, false) : eq(column, w.value);
	}
};

/**
 * What `betterAuth({ database })` takes. Spelled as the factory's own return
 * type rather than `AdapterFactory<…>` so the `BetterAuthOptions` generic stays
 * pinned to whatever the installed Better Auth says it is, and this module
 * needs no import from `better-auth`'s type entry.
 */
export type D1zzleAdapterFactory = ReturnType<typeof createAdapterFactory>;

export const d1zzleAdapter = (
	db: D1zzleAdapterDatabase,
	config: D1zzleAdapterConfig,
): D1zzleAdapterFactory => {
	const createCustomAdapter: Parameters<typeof createAdapterFactory>[0]['adapter'] =
		({ getFieldName }) => {
			/** The d1zzle table for a Better Auth model name. */
			const tableFor = (model: string): Table => {
				const key = config.usePlural ? `${model}s` : model;
				// `hasOwn`, not a bare index: `schema` is a plain object the user
				// wrote, so `schema['constructor']` is `Object` — truthy — and a
				// plugin registering a model of that name would be handed a
				// function where a table belongs. It then fails deep inside the
				// query builder rather than here, where the message can name the
				// option that is missing an entry.
				const own = (name: string): Table | undefined =>
					Object.hasOwn(config.schema, name) ? config.schema[name] : undefined;
				const t = own(key) ?? own(model);
				if (!t) {
					throw new D1zzleAdapterError(
						`The model "${model}" is not in the d1zzle adapter's \`schema\` option. `
							+ `Add it, e.g. \`schema: { ${key}: ${key} }\`. `
							+ `Known models: ${Object.keys(config.schema).join(', ') || '(none)'}.`,
					);
				}
				return t;
			};

			/**
			 * The column backing a Better Auth field.
			 *
			 * `getFieldName` maps a model's field to the name it is stored under —
			 * which, for both this adapter and Drizzle's, is the *property* key in
			 * the schema object, not the SQL column name. The property is what a
			 * `fields: { image: 'avatarUrl' }` override names, and d1zzle turns the
			 * property back into `"avatar_url"` when it renders. Calling it here is
			 * belt and braces: the factory has already mapped `where` and `data`
			 * keys, and the mapping is idempotent because an already-mapped name is
			 * not itself a key of `fields`.
			 */
			const columnFor = (model: string, table: Table, field: string): Column<any> => {
				const key = getFieldName({ model, field });
				// `hasOwn`: this is the adapter's whole field-validation boundary —
				// every `where`, `select`, `sortBy`, `update` and `increment` key
				// passes through it. `columns['constructor']` is `Object`, which is
				// truthy, so a bare index sailed past the refusal below and handed
				// a *function* to `eq()` as though it were a column.
				//
				// Defence in depth rather than a live hole: Better Auth's own
				// `getFieldName` has the same bug one layer up and throws on such a
				// name before we can look it up, which is why the test for this
				// pins *their* error. If they fix it, this is what answers.
				const columns = getTableColumns(table) as Record<string, Column<any> | undefined>;
				const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
				if (!column) {
					throw new D1zzleAdapterError(
						`The field "${field}" does not exist on the d1zzle table "${getTableName(table)}" `
							+ `backing the model "${model}". Add the column to your schema (and generate a `
							+ `migration with \`d1zzle-migrate generate\`), or map it with \`fields\`.`,
					);
				}
				return column;
			};

			/**
			 * A `Where[]` as one condition.
			 *
			 * Better Auth flattens its predicates: every entry carries its own
			 * `connector`, so the shape is `(…AND…) AND (…OR…)` rather than a tree.
			 * That is exactly how the Drizzle adapter reads it, and Better Auth
			 * never emits anything deeper.
			 */
			const conditionFor = (model: string, table: Table, where?: CleanedWhere[]): Condition | undefined => {
				if (!where?.length) return undefined;

				const ands: Condition[] = [];
				const ors: Condition[] = [];
				for (const w of where) {
					const c = toCondition(columnFor(model, table, w.field), w, model);
					(w.connector === 'OR' ? ors : ands).push(c);
				}

				return and(and(...ands), or(...ors));
			};

			/** `select: ['id', 'email']` as a d1zzle projection, or `undefined` for
			 *  the whole row. Worth doing rather than ignoring: on D1 an unselected
			 *  column is still billed as `rows_read`. */
			const projectionFor = (
				model: string,
				table: Table,
				select?: string[],
			): Record<string, Column<any>> | undefined => {
				if (!select?.length) return undefined;
				const projection: Record<string, Column<any>> = {};
				for (const field of select) {
					projection[getFieldName({ model, field })] = columnFor(model, table, field);
				}
				return projection;
			};

			/** Better Auth's `id` column for a model — the anchor for the
			 *  single-row guarantees below. */
			const idColumnFor = (model: string, table: Table): Column<any> =>
				columnFor(model, table, 'id');

			/**
			 * `where … in (select id … limit 1)`, the single-row selector.
			 *
			 * SQLite has no `UPDATE … LIMIT` / `DELETE … LIMIT` unless it was
			 * compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which D1 is not, so
			 * a self-subquery on the primary key is how a write is pinned to one
			 * row. It stays a single statement, which is what makes it atomic.
			 */
			const oneRow = (model: string, table: Table, where: CleanedWhere[]): Condition => {
				const id = idColumnFor(model, table);
				return inArray(
					id,
					db.select({ id }).from(table).where(conditionFor(model, table, where)).limit(1),
				);
			};

			const rejectJoins = (join: JoinConfig | undefined, method: string): void => {
				if (!join || Object.keys(join).length === 0) return;
				throw new D1zzleAdapterError(
					`\`experimental.joins\` is not supported by the d1zzle adapter (${method} asked to join `
						+ `${Object.keys(join).join(', ')}). Turn the option off; Better Auth will fetch the `
						+ `related rows with follow-up queries instead.`,
				);
			};

			return {
				async create({ model, data }) {
					const table = tableFor(model);
					for (const field of Object.keys(data)) columnFor(model, table, field);
					const row = await db.insert(table).values(data as never).returning().get();
					return row as never;
				},

				async findOne({ model, where, select, join }) {
					rejectJoins(join, 'findOne');
					const table = tableFor(model);
					const projection = projectionFor(model, table, select);
					const row = await db
						.select(projection as never)
						.from(table)
						.where(conditionFor(model, table, where))
						.get();
					return (row ?? null) as never;
				},

				async findMany({ model, where, limit, select, sortBy, offset, join }) {
					rejectJoins(join, 'findMany');
					const table = tableFor(model);
					const projection = projectionFor(model, table, select);

					let builder = db
						.select(projection as never)
						.from(table)
						.where(conditionFor(model, table, where));

					if (sortBy) {
						const column = columnFor(model, table, sortBy.field);
						builder = builder.orderBy(sortBy.direction === 'desc' ? desc(column) : asc(column));
					}
					if (limit !== undefined) builder = builder.limit(limit);
					if (offset !== undefined) builder = builder.offset(offset);

					return (await builder.all()) as never;
				},

				async count({ model, where }) {
					const table = tableFor(model);
					const row = await db
						.select({ count: count() })
						.from(table)
						.where(conditionFor(model, table, where))
						.get();
					return row?.count ?? 0;
				},

				/**
				 * Update one row.
				 *
				 * The `where` is applied directly rather than through {@link oneRow}:
				 * Better Auth only ever calls this with a predicate that is unique by
				 * construction (an id, a session token, a verification identifier), so
				 * the subquery would buy nothing and cost an extra index probe on the
				 * session-refresh path, which is the hottest write it makes. An empty
				 * `where` is refused outright, per the adapter contract — a whole-table
				 * update should go through `updateMany`, deliberately.
				 */
				async update({ model, where, update }) {
					if (!where.length) return null;
					const table = tableFor(model);
					for (const field of Object.keys(update as Record<string, unknown>)) {
						columnFor(model, table, field);
					}
					const row = await db
						.update(table)
						.set(update as never)
						.where(conditionFor(model, table, where))
						.returning()
						.get();
					return (row ?? null) as never;
				},

				async updateMany({ model, where, update }) {
					if (!where.length) return 0;
					const table = tableFor(model);
					for (const field of Object.keys(update)) columnFor(model, table, field);
					const result = await db
						.update(table)
						.set(update as never)
						.where(conditionFor(model, table, where))
						.run();
					return result.meta.changes ?? 0;
				},

				async delete({ model, where }) {
					if (!where.length) return;
					const table = tableFor(model);
					await db.delete(table).where(conditionFor(model, table, where)).run();
				},

				async deleteMany({ model, where }) {
					if (!where.length) return 0;
					const table = tableFor(model);
					const result = await db.delete(table).where(conditionFor(model, table, where)).run();
					return result.meta.changes ?? 0;
				},

				/**
				 * Delete one matching row and return it, or `null` if none matched.
				 *
				 * This is the primitive behind single-use credentials — verification
				 * tokens, OAuth authorization codes, one-time tokens — so "exactly one
				 * caller wins the race" is the whole point of it. The factory's
				 * fallback gets that from a transaction; D1 has none, so it would
				 * degrade to `findMany` then `deleteMany` with a window in between and
				 * two racers could both come away with the row.
				 *
				 * `DELETE … WHERE id IN (SELECT … LIMIT 1) RETURNING *` is one
				 * statement, so D1 executes it atomically: the loser's subquery either
				 * still sees the row and its delete then affects nothing, or no longer
				 * sees it. Either way `RETURNING` gives back only rows the statement
				 * itself deleted, and exactly one caller gets a row.
				 */
				async consumeOne({ model, where }) {
					if (!where.length) return null;
					const table = tableFor(model);
					const row = await db.delete(table).where(oneRow(model, table, where)).returning().get();
					return (row ?? null) as never;
				},

				/**
				 * Apply signed deltas to one row, guarded by `where`.
				 *
				 * Same reasoning as {@link consumeOne}: the read-modify-write this
				 * replaces is only safe inside a transaction. Rendering the delta as
				 * `"col" = "col" + ?` keeps the arithmetic inside the statement, so the
				 * guard and the mutation are evaluated together and a concurrent
				 * decrement cannot be lost.
				 *
				 * The column is written with `sql.identifier` rather than the column
				 * object, which would render `"table"."col"`. Qualified names have no
				 * business on either side of a `SET` assignment — the target table is
				 * the only one in scope.
				 */
				async incrementOne({ model, where, increment, set }) {
					if (!where.length) return null;
					const table = tableFor(model);

					const assignments: Record<string, unknown> = {};
					for (const [field, delta] of Object.entries(increment)) {
						const column = columnFor(model, table, field);
						assignments[getFieldName({ model, field })] = sql<number>`${
							sql.identifier(column.name)
						} + ${delta}` satisfies SQLChunk<number>;
					}
					for (const [field, value] of Object.entries(set ?? {})) {
						columnFor(model, table, field);
						assignments[getFieldName({ model, field })] = value;
					}
					if (Object.keys(assignments).length === 0) return null;

					const row = await db
						.update(table)
						.set(assignments as never)
						.where(oneRow(model, table, where))
						.returning()
						.get();
					return (row ?? null) as never;
				},

				options: config,
			} satisfies CustomAdapter;
		};

	return createAdapterFactory({
		config: {
			adapterId: 'd1zzle',
			adapterName: 'd1zzle Adapter',
			usePlural: config.usePlural ?? false,
			debugLogs: config.debugLogs ?? false,
			supportsNumericIds: config.supportsNumericIds ?? true,
			supportsDates: config.supportsDates ?? true,
			supportsBooleans: config.supportsBooleans ?? true,
			// SQLite has neither, so Better Auth serialises them to text for us.
			supportsJSON: false,
			supportsArrays: false,
			// D1 has no interactive transactions; see the module header.
			transaction: false,
			/**
			 * Dates come back as whatever the column decodes to — a `Date` from
			 * `integer({ mode: 'timestamp' })`, an epoch number from a bare
			 * `integer`, an ISO string from `text`. Better Auth's models want a
			 * `Date`, and `new Date(…)` accepts all three.
			 */
			customTransformOutput: ({ data, fieldAttributes }) => {
				if (fieldAttributes.type !== 'date' || data === null || data === undefined) return data;
				return data instanceof Date ? data : new Date(data as string | number);
			},
		},
		adapter: createCustomAdapter,
	});
};
