/**
 * `db.query.<table>.findMany({ with: … })` — RQBv2's interface, executed our way.
 *
 * **Interface, not plan.** Drizzle v1 answers a relational query with lateral
 * joins and JSON aggregation. This does not: parents are fetched, then each
 * level of children is fetched by parent key and stitched in JS. Split queries
 * are what ship because their failure modes are all visible — predictable
 * `rows_read`, no SQLite function-argument cap on how wide a child projection
 * can be, and SQL that is readable in a log. Children at the same level are
 * fetched concurrently, so the *depth* of the query, not the number of
 * relations, is what costs round trips.
 *
 * What v1 changed here is the config that feeds the executor — an object
 * filter DSL instead of a callback, an object form for `orderBy`, a callback
 * form for `extras` — not the executor itself.
 */
import type { D1zzleDatabase } from '../runtime/database.js';
import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { alias, getTableColumns } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import { and, asc, collapsesToJsonEach, desc, eq, gt, inArray, lte, or } from '../sql/expressions.js';
import { avg, count, countDistinct, max, min, sum } from '../sql/functions.js';
import type { Placeholder, RenderContext, SQLChunk } from '../sql/sql.js';
import { render, sql } from '../sql/sql.js';
import type { Relation, RelationsConfig, TableRelationalConfig } from './define.js';
import type { RelationsFilter } from './filter.js';
import { compileFilter, filterOperators } from './filter.js';

/**
 * The operator bag passed to an `orderBy` or `extras` callback.
 *
 * Drizzle hands an `orderBy` callback `{ sql, asc, desc }`; the rest are ours
 * and cost nothing to keep, since a callback that destructures only the three
 * it was promised is unaffected by the others being present.
 */
export const operators = {
	...filterOperators,
	asc,
	desc,
	count,
	countDistinct,
	sum,
	avg,
	min,
	max,
};

export type Operators = typeof operators;

/**
 * The bag handed to an `extras` or `orderBy` callback — callable *and*
 * destructurable.
 *
 * The two conventions disagree. Drizzle passes an object and its own callbacks
 * read `(table, { sql })`; Pothos' drizzle plugin documents and writes
 * `(table, sql) => sql\`…\`` and calls the argument directly. Neither is wrong
 * and both reach this code, so what is passed is the `sql` tag itself with the
 * operators — and a self-referential `sql` — hung off it. `sql\`…\`` works, and
 * so does destructuring `{ sql }`, `{ asc }` or `{ eq }`.
 */
const callableOperators = (() => {
	// A fresh callable rather than the shared `sql` export: properties are
	// about to be attached, and mutating the module-level tag would leak the
	// operator bag into every other use of it.
	const tag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
		sql(strings, ...values)) as unknown as typeof sql;
	Object.assign(tag, {
		identifier: sql.identifier,
		raw: sql.raw,
		placeholder: sql.placeholder,
		empty: sql.empty,
		join: sql.join,
	});
	return Object.assign(tag, operators, { sql: tag });
})();

/** What an `extras`/`orderBy` callback receives as its second argument. */
export type CallableOperators = typeof callableOperators;

/** `orderBy`, in either of v1's two forms. */
export type OrderByArg<TFields = Record<string, Column<any>>> =
	| Record<string, 'asc' | 'desc' | undefined>
	| ((fields: TFields, ops: CallableOperators) => readonly (SQLChunk | Column<any>)[] | SQLChunk | Column<any> | undefined);

/** `extras`, as a fragment or as a callback producing one. */
export type ExtrasArg<TFields = Record<string, Column<any>>> = Record<
	string,
	SQLChunk | ((fields: TFields, ops: CallableOperators) => SQLChunk) | undefined
>;

export interface FindConfig {
	columns?: Record<string, boolean | undefined>;
	with?: Record<string, true | FindConfig | undefined>;
	extras?: ExtrasArg;
	where?: RelationsFilter;
	orderBy?: OrderByArg;
	limit?: number | Placeholder<number>;
	offset?: number | Placeholder<number>;
	/**
	 * Accepted and ignored. v1's config carries a sqlcommenter comment; D1
	 * reports its own per-statement statistics, so a comment would only widen
	 * every query for nothing.
	 */
	comment?: string;
}

/** A column, as opposed to an already-built ordering fragment. */
const isColumnLike = (value: unknown): value is Column<any> =>
	typeof value === 'object' && value !== null && typeof (value as Column<any>).getSQLType === 'function';

const resolveOrderBy = (orderBy: OrderByArg | undefined, columns: Record<string, Column<any>>): SQLChunk[] => {
	if (!orderBy) return [];

	if (typeof orderBy === 'function') {
		const resolved = orderBy(columns, callableOperators);
		if (resolved === undefined || resolved === null) return [];
		const list = Array.isArray(resolved) ? resolved : [resolved];
		// A bare column means ascending, as Drizzle reads it.
		return list.map((entry) => (isColumnLike(entry) ? asc(entry) : entry as SQLChunk));
	}

	return Object.entries(orderBy)
		.filter(([, direction]) => direction)
		.map(([key, direction]) => {
			const column = columns[key];
			if (!column) {
				throw new Error(
					`Cannot order by "${key}": it is not a column of this table. `
						+ `Columns: ${Object.keys(columns).join(', ')}.`,
				);
			}
			return direction === 'desc' ? desc(column) : asc(column);
		});
};

const resolveExtras = (
	extras: ExtrasArg | undefined,
	columns: Record<string, Column<any>>,
): Record<string, SQLChunk> => {
	const resolved: Record<string, SQLChunk> = {};
	for (const [key, value] of Object.entries(extras ?? {})) {
		if (value === undefined) continue;
		resolved[key] = typeof value === 'function' ? value(columns, callableOperators) : value;
	}
	return resolved;
};

/** Which columns to project: explicit `true`s win; otherwise all but the `false`s. */
const pickColumns = (
	all: Record<string, Column<any>>,
	selection: Record<string, boolean | undefined> | undefined,
): string[] => {
	const keys = Object.keys(all);
	if (!selection) return keys;
	const included = keys.filter((key) => selection[key] === true);
	if (included.length > 0) return included;
	return keys.filter((key) => selection[key] !== false);
};

/**
 * One stitching-key component.
 *
 * Type-tagged, so the integer `1` and the text `'1'` cannot land in the same
 * bucket. `bigint`, `Date` and blob keys are spelled out because `String()`
 * flattens them into something ambiguous.
 */
const keyPart = (value: unknown): string => {
	if (value === null || value === undefined) return 'z';
	if (typeof value === 'bigint' || typeof value === 'number') return `n${value}`;
	if (value instanceof Date) return `d${value.getTime()}`;
	if (value instanceof Uint8Array) return `b${Array.from(value).join(',')}`;
	if (value instanceof ArrayBuffer) return `b${Array.from(new Uint8Array(value)).join(',')}`;
	if (typeof value === 'string') return `s${value}`;
	return `j${JSON.stringify(value)}`;
};

/** A per-parent page, expressed as a `row_number()` partition. */
interface PerParentWindow {
	readonly limit?: number;
	readonly offset?: number;
}

/** Projected alongside the child's columns; never survives into a result. */
const ROW_NUMBER = '__d1zzle_rn';

/**
 * Prefix for a junction column projected onto a `through` child.
 *
 * A many-to-many target row carries nothing that says which parent it arrived
 * by — the same row can belong to several — so the junction's own key column
 * is projected under a name no user column can collide with, and dropped once
 * the buckets are keyed.
 */
const JUNCTION_PREFIX = '__d1zzle_j';

/** The database's own budget, for the places that need to count parameters. */
const renderContextOf = (db: D1zzleDatabase): RenderContext => ({
	maxParams: db.$maxParams,
	jsonEachThreshold: db.$jsonEachThreshold,
});

const chunk = <T>(items: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};

/**
 * Separates key components. A character no identifier or value can contain, so
 * `['a b', 'c']` and `['a', 'b c']` cannot collide — but written as an escape
 * rather than inline, because a literal NUL in the source makes `grep` treat
 * this whole file as binary and silently return nothing.
 */
const KEY_SEPARATOR = '\u0000';

const keyOf = (row: Record<string, unknown>, fields: readonly string[]): string =>
	fields.map((field) => keyPart(row[field])).join(KEY_SEPARATOR);

/**
 * A `limit`/`offset` on a nested relation has to be a literal.
 *
 * Per parent, it is applied by a `row_number()` window whose bounds are part of
 * the SQL text; a placeholder would have to move into the predicate, which is
 * a different query. At the top level a placeholder is fine and passes through.
 */
const perParentBound = (value: number | Placeholder<number> | undefined, what: string): number | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === 'number') return value;
	throw new Error(
		`"${what}" on a nested relation cannot be a placeholder: the per-parent page is taken with a `
			+ 'row_number() window whose bounds are baked into the SQL. Use a literal number here, or apply '
			+ 'the placeholder to the top-level query.',
	);
};

/** What a child level needs in order to be fetched by its parents' keys. */
interface ChildFetch {
	readonly matcher: Condition | undefined;
	/** Columns each parent's page is numbered within. */
	readonly partitionBy: readonly Column<any>[];
	readonly window?: PerParentWindow | undefined;
	readonly through?: ThroughFetch | undefined;
}

interface ThroughFetch {
	readonly junction: Table;
	/** The junction columns that carry the parent key, in `from` order. */
	readonly keys: readonly Column<any>[];
	readonly on: Condition;
}

export class RelationalQueryBuilder {
	constructor(
		private readonly db: D1zzleDatabase,
		private readonly schema: RelationsConfig,
		private readonly config: TableRelationalConfig,
	) {}

	/** `select … from <table> [inner join <junction> on …] where …`. */
	#base(selection: Record<string, SQLChunk>, where: Condition | undefined, through: ThroughFetch | undefined) {
		const from = this.db.select(selection).from(this.config.table as never);
		const joined = through ? from.innerJoin(through.junction as never, through.on as never) : from;
		return joined.where(where);
	}

	/**
	 * One page per parent, taken with a window function rather than one query
	 * per parent key.
	 *
	 * `row_number()` is not allowed in `where`, so the numbering happens in a
	 * subquery and the outer select filters on it. The row number is projected
	 * under a name no column can collide with, and dropped before the rows are
	 * handed back.
	 */
	async #windowed(
		selection: Record<string, SQLChunk>,
		where: Condition | undefined,
		orderBy: readonly SQLChunk[],
		child: ChildFetch,
		input: Record<string, unknown> | undefined,
	): Promise<Record<string, unknown>[]> {
		const partition = sql.join([...child.partitionBy], ', ');
		const ordering = orderBy.length > 0 ? sql` order by ${sql.join([...orderBy], ', ')}` : sql.empty();

		const numbered = this.#base(
			{ ...selection, [ROW_NUMBER]: sql`row_number() over (partition by ${partition}${ordering})` },
			where,
			child.through,
		).as('d1zzle_window');

		const inner = getTableColumns(numbered as unknown as Table) as unknown as Record<string, SQLChunk>;
		const outerSelection: Record<string, SQLChunk> = {};
		for (const key of Object.keys(selection)) outerSelection[key] = inner[key]!;

		const rank = inner[ROW_NUMBER]!;
		const offset = child.window?.offset ?? 0;
		const bounds: Condition[] = [];
		if (offset > 0) bounds.push(gt(rank as never, offset));
		if (child.window?.limit !== undefined) bounds.push(lte(rank as never, offset + child.window.limit));

		// Ordering by the row number reproduces the requested order inside each
		// partition, which is all the stitching needs.
		return await this.db.select(outerSelection)
			.from(numbered as never)
			.where(and(...bounds))
			.orderBy(asc(rank as never))
			.all(input) as Record<string, unknown>[];
	}

	findMany(config: FindConfig = {}): RelationalQuery<Record<string, unknown>[]> {
		return new RelationalQuery((input) => this.#run(config, [], false, undefined, input));
	}

	findFirst(config: FindConfig = {}): RelationalQuery<Record<string, unknown> | undefined> {
		return new RelationalQuery(async (input) => (await this.#run({ ...config, limit: 1 }, [], false, undefined, input))[0]);
	}

	/**
	 * @param joinKeys column keys the caller needs for stitching. They are
	 * fetched even when the projection excludes them, and dropped again before
	 * the rows are handed back.
	 */
	async #run(
		config: FindConfig,
		joinKeys: readonly string[],
		keepJoinKeys = false,
		child?: ChildFetch,
		input?: Record<string, unknown>,
	): Promise<Record<string, unknown>[]> {
		const columns = this.config.columns;
		const requested = new Set(pickColumns(columns, config.columns));
		const projected = new Set(requested);
		for (const key of joinKeys) projected.add(key);

		const children = Object.entries(config.with ?? {})
			.filter(([, value]) => value)
			.map(([name, value]) => {
				const relation = this.config.relations[name];
				if (!relation) {
					throw new Error(
						`"${this.config.name}" has no relation named "${name}". `
							+ `Relations: ${Object.keys(this.config.relations).join(', ') || '(none)'}.`,
					);
				}
				if (!relation.sourceColumns || !relation.targetColumns) {
					throw new Error(`Relation "${name}" on "${this.config.name}" has no resolved join columns.`);
				}
				return { name, relation, config: value === true ? {} : value as FindConfig };
			});

		// Join keys have to be fetched even when the caller did not ask for
		// them, or the children cannot be stitched back on.
		for (const entry of children) {
			for (const column of entry.relation.sourceColumns!) projected.add(fieldNameOf(columns, column));
		}

		/**
		 * Fetched only to make the stitching possible; removed before returning.
		 *
		 * `keepJoinKeys` protects the keys *our caller* asked for — it must not
		 * also protect the ones this level added for its own children, or a
		 * grandchild's join column leaks into the child's projection.
		 */
		const helperKeys = [...projected].filter(
			(key) => !requested.has(key) && !(keepJoinKeys && joinKeys.includes(key)),
		);

		const selection: Record<string, SQLChunk> = {};
		for (const key of projected) selection[key] = columns[key]!;
		if (child?.through) {
			for (const [i, column] of child.through.keys.entries()) selection[`${JUNCTION_PREFIX}${i}`] = column;
		}
		Object.assign(selection, resolveExtras(config.extras, columns));

		const orderBy = resolveOrderBy(config.orderBy, columns);
		const where = and(
			compileFilter(config.where, this.config.table, columns, this.config.relations, this.schema),
			child?.matcher,
		);

		let rows: Record<string, unknown>[];
		if (child?.window) {
			rows = await this.#windowed(selection, where, orderBy, child, input);
		} else {
			let builder = this.#base(selection, where, child?.through);
			if (orderBy.length > 0) builder = builder.orderBy(...orderBy);
			if (config.limit !== undefined) builder = builder.limit(config.limit as never);
			if (config.offset !== undefined) builder = builder.offset(config.offset as never);
			rows = await builder.all(input) as Record<string, unknown>[];
		}

		if (rows.length === 0 || children.length === 0) return dropKeys(rows, helperKeys);

		await Promise.all(children.map((entry) => this.#fetchChild(entry, rows, input)));

		return dropKeys(rows, helperKeys);
	}

	async #fetchChild(
		entry: { name: string; relation: Relation; config: FindConfig },
		rows: Record<string, unknown>[],
		input: Record<string, unknown> | undefined,
	): Promise<void> {
		const { name, relation } = entry;
		const targetConfig = this.schema[relation.targetTableName];
		if (!targetConfig) throw new Error(`Unknown table "${relation.targetTableName}" in relation "${name}".`);

		const isMany = relation.relationType === 'many';
		const parentFieldNames = relation.sourceColumns!.map((c) => fieldNameOf(this.config.columns, c));

		/**
		 * The junction table is aliased so a self-referencing many-to-many —
		 * `users.following` through a `follows` table — cannot collide with the
		 * target it is joined to.
		 */
		const junction = relation.throughTable ? alias(relation.throughTable, 'd1zzle_through') : undefined;
		const rebind = junction ? columnRebinder(junction) : undefined;

		/**
		 * What the child rows are matched on, and the key each row carries back.
		 * Without `through` those are the target's own columns; with it, the
		 * junction's, projected under {@link JUNCTION_PREFIX}.
		 */
		const through: ThroughFetch | undefined = junction && relation.through
			? {
				junction,
				keys: relation.through.source.map(rebind!),
				on: and(...relation.through.target.map((c, i) => eq(rebind!(c), relation.targetColumns![i]!)))!,
			}
			: undefined;

		const matchColumns = through ? through.keys : relation.targetColumns!;
		const childFieldNames = through
			? through.keys.map((_, i) => `${JUNCTION_PREFIX}${i}`)
			: relation.targetColumns!.map((c) => fieldNameOf(targetConfig.columns, c));

		// Deduped on the key string, but the *raw* values are what get bound —
		// a JSON round trip would hand the encoder an ISO string for a
		// timestamp key, `{"0":…}` for a blob, and throw outright on a bigint.
		const byKey = new Map<string, unknown[]>();
		for (const row of rows) {
			if (!parentFieldNames.every((f) => row[f] !== null && row[f] !== undefined)) continue;
			byKey.set(keyOf(row, parentFieldNames), parentFieldNames.map((f) => row[f]));
		}
		const keys = [...byKey.values()];

		if (keys.length === 0) {
			for (const row of rows) row[name] = isMany ? [] : null;
			return;
		}

		const matcherFor = (subset: readonly unknown[][]): Condition | undefined =>
			matchColumns.length === 1
				? inArray(matchColumns[0]!, subset.map((k) => k[0]))
				: or(...subset.map((key) => and(...matchColumns.map((column, i) => eq(column, key[i])))));

		// `limit`/`offset` on a nested `with` mean "per parent", which a single
		// batched child query cannot express with a plain LIMIT — it would
		// apply once, globally, and every parent after the first would come
		// back empty. `row_number() over (partition by …)` numbers each
		// parent's children separately, so the page can be taken per parent
		// while this stays one query. Fanning out per key would be correct too,
		// but it is an unbounded N+1 against a Workers subrequest limit.
		const limit = perParentBound(entry.config.limit, 'limit');
		const offset = perParentBound(entry.config.offset, 'offset');
		const window: PerParentWindow | undefined = limit !== undefined || offset !== undefined
			? { ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }
			: undefined;

		const nested = new RelationalQueryBuilder(this.db, this.schema, targetConfig);

		const runFor = (subset: readonly unknown[][]): Promise<Record<string, unknown>[]> =>
			nested.#run(entry.config, childFieldNames, true, {
				matcher: matcherFor(subset),
				partitionBy: matchColumns,
				window,
				through,
			}, input);

		/**
		 * A single-column key *usually* collapses to `inArray`, which turns into
		 * `json_each` above the threshold and binds one parameter however many
		 * keys there are. A composite key cannot: it expands to
		 * `or(and(eq, eq), …)`, one bound parameter per key column per parent,
		 * so 60 parents with a two-column key is 120 parameters against a limit
		 * of ~100. Those are chunked, which is what `subset` was always for.
		 *
		 * The exception is a binary key. A `Uint8Array` has no faithful JSON
		 * spelling, so `inArray` bindsblobs individually rather than change the
		 * answer — which makes a single blob column the one shape that both
		 * skips `json_each` *and* would skip chunking if this only counted
		 * columns. A UUID-as-bytes primary key with more than ~100 parents is
		 * a real query, and it overflowed. Ask `inArray` what it will actually
		 * do rather than assuming; the integer path is untouched.
		 */
		const perKey = matchColumns.length;
		const collapses = perKey === 1 && collapsesToJsonEach(matchColumns[0], keys.map((k) => k[0]));

		// The keys are not the only parameters in the child statement. A nested
		// `where` binds, and so do the window's bounds — so a chunk sized to the
		// whole budget leaves them nothing and overflows by exactly their count.
		// Rendering the filter twice (here and again in `#run`) is cheap next to
		// the round trip it protects.
		const targetColumns = getTableColumns(targetConfig.table) as unknown as Record<string, Column<any>>;
		const childFilter = compileFilter(
			entry.config.where,
			targetConfig.table,
			targetColumns,
			targetConfig.relations,
			this.schema,
		);
		const reserved = (childFilter ? render(childFilter, renderContextOf(this.db)).params.length : 0)
			+ (window?.limit !== undefined ? 1 : 0)
			+ (window?.offset ? 1 : 0);

		const budget = Math.max(1, this.db.$maxParams - reserved);
		const maxKeys = collapses ? keys.length : Math.max(1, Math.floor(budget / perKey));

		const childRows = maxKeys >= keys.length
			? await runFor(keys)
			: (await Promise.all(chunk(keys, maxKeys).map((subset) => runFor(subset)))).flat();

		const grouped = new Map<string, Record<string, unknown>[]>();
		for (const row of childRows) {
			const key = keyOf(row, childFieldNames);
			const bucket = grouped.get(key);
			if (bucket) bucket.push(row);
			else grouped.set(key, [row]);
		}

		// Before stitching, not after: `one` hands the parent a shallow copy, and
		// a copy taken while the join columns are still present keeps them —
		// leaking a column the projection never asked for. The map holds
		// references into `childRows`, and the keys have already been read out.
		// A junction key is never something the caller asked for, so it always
		// goes; a target column goes only if it was not in the projection.
		const childRequested = new Set(pickColumns(targetConfig.columns, entry.config.columns));
		dropKeys(childRows, childFieldNames.filter((key) => through !== undefined || !childRequested.has(key)));

		/** Buckets already handed to a parent — see the `isMany` branch. */
		const claimed = new Set<string>();

		for (const row of rows) {
			const parentKey = keyOf(row, parentFieldNames);
			const bucket = grouped.get(parentKey) ?? [];
			if (isMany) {
				// Same rule as `one` below, one container up. Two parents share a
				// bucket whenever they share a join key, which needs only a
				// non-unique join column — `many` keyed on `customerId` rather
				// than a primary key — and is legal and not rare. Handing both
				// the identical array means pushing to one result pushes to the
				// other; sharing the elements means mutating a child row mutates
				// it for both.
				//
				// The first parent to claim a bucket takes it as-is, so the
				// overwhelmingly common unique-key case allocates nothing.
				row[name] = claimed.has(parentKey) ? bucket.map((child) => ({ ...child })) : bucket;
				claimed.add(parentKey);
				continue;
			}
			// Copied, not shared. Several parents legitimately resolve to the
			// same child row — two posts by one author — and handing them all
			// the identical object means mutating one result mutates the others.
			// Drizzle's JSON executor materialises a fresh object per parent, so
			// sharing here would be a silent divergence in a place nobody looks.
			// A shallow copy is enough: nested relations were themselves built
			// per parent one level down.
			row[name] = bucket[0] ? { ...bucket[0] } : null;
		}
	}
}

/** Re-express columns of a table against one of its aliases. */
const columnRebinder = (aliased: Table) => {
	const byName = new Map(
		Object.values(getTableColumns(aliased) as Record<string, Column<any>>).map((c) => [c.name, c]),
	);
	return (column: Column<any>): Column<any> => byName.get(column.name) ?? column;
};

/** Remove columns that were only fetched to make the stitching possible. */
const dropKeys = <T extends Record<string, unknown>>(rows: T[], keys: readonly string[]): T[] => {
	if (keys.length === 0) return rows;
	for (const row of rows) {
		for (const key of keys) delete row[key];
	}
	return rows;
};

const fieldNameOf = (columns: Record<string, Column<any>>, column: Column<any>): string => {
	for (const [key, candidate] of Object.entries(columns)) {
		if (candidate.name === column.name) return key;
	}
	return column.name;
};

/**
 * Lazy, awaitable, and re-runnable — the shape Drizzle's query builders have.
 *
 * `Promise`, not just `PromiseLike`: Drizzle's `QueryPromise` is a full
 * `Promise<T>`, and callers rely on it. Declaring only `then` typechecks the
 * `await` path but rejects `.catch()`, `.finally()`, and any assignment to a
 * `Promise<T>` — including the common `const p: Promise<T> = q.findMany().then(…)`
 * memo. `then` already returns a real promise at runtime, so this widens the
 * declaration to match what the class always did.
 */
export class RelationalQuery<TResult> implements Promise<TResult> {
	readonly [Symbol.toStringTag] = 'Promise';

	constructor(private readonly runner: (input?: Record<string, unknown>) => Promise<TResult>) {}

	/** @param input values for the placeholders used anywhere in the filter. */
	execute(input?: Record<string, unknown>): Promise<TResult> {
		return this.runner(input);
	}

	then<TResult1 = TResult, TResult2 = never>(
		onfulfilled?: ((value: TResult) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.runner().then(onfulfilled, onrejected);
	}

	catch<TResult1 = never>(
		onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
	): Promise<TResult | TResult1> {
		return this.then(undefined, onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<TResult> {
		return this.then().finally(onfinally);
	}
}
