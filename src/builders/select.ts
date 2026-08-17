import type { CompiledQuery } from '../plan/compile.js';
import { compileSelect, projectedColumns, projectedNullableGroups } from '../plan/compile.js';
import type { Join, JoinType, Selection, SelectPlan } from '../plan/plan.js';
import { emptySelectPlan } from '../plan/plan.js';
import type { Column, ColumnConfig, ColumnMeta } from '../schema/columns.js';
import { columnClassFor, isColumn } from '../schema/columns.js';
import type { ColumnsMap, NameOf, NullableColumns, Subquery, Table } from '../schema/table.js';
import type { InferSelect, Simplify } from '../schema/infer.js';
import { createSubquery } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import type { Placeholder, Query, RenderContext, SQLChunk } from '../sql/sql.js';
import { defaultRenderContext } from '../sql/sql.js';
import { resolveContext } from './types.js';
import type { QueryExecutor, Runnable } from './types.js';

/**
 * The columns a subquery exposes, derived from the row it produces.
 *
 * `notNull` is recovered from the row type rather than left as `boolean`: the
 * inner projection already knows which columns are nullable, and widening every
 * one of them forces a `!` on each read out of a subquery.
 */
export type SubqueryColumns<TRow> = {
	[K in keyof TRow]-?: unknown extends NonNullable<TRow[K]>
		// An untyped `sql\`…\`` produces `unknown`, which is not a scalar and not
		// an object either — left to the group branch it turned `sq.n` into a
		// structural expansion of the `Column` class. A value the projection
		// could not describe is still a value, so it reads as one column of
		// unknown type rather than as a group of columns.
		? Column<{ data: unknown; notNull: false; hasDefault: boolean }>
		: NonNullable<TRow[K]> extends SubqueryLeaf ? Column<{
				data: NonNullable<TRow[K]>;
				notNull: null extends TRow[K] ? false : true;
				hasDefault: boolean;
			}>
		// A group the inner join could miss stays nullable through `.as()`: the
		// mark is what `Out<>` reads to widen it, matching the `null` the mapper
		// now returns for it.
		: null extends TRow[K] ? SubqueryColumns<NonNullable<TRow[K]>> & NullableColumns
		: SubqueryColumns<NonNullable<TRow[K]>>;
};

/**
 * Values a subquery column can hold, as opposed to a *group* of columns.
 *
 * A join or a nested selection produces a row of nested objects, and the
 * subquery's surface has to nest with it — `sq.users.id`, matching what the
 * runtime now builds. The only way to tell the two apart from the row type is
 * to enumerate what a scalar looks like, which puts a JSON-mode column holding
 * a plain object on the wrong side: it reads as a group. That is the narrow
 * cost of not carrying the selection's shape into the row type, and it is
 * visible at the call site rather than at run time.
 *
 * The known limitation, then, is exactly one case: a column whose decoded value
 * is a plain object — `text({ mode: 'json' })` over an object, or a
 * `sql<{ … }>` fragment — reads as a group of columns on a subquery surface,
 * and has to be selected out under a cast. Everything else lands correctly:
 * `unknown` is handled above, and the runtime half of the surface is derived
 * from the projection (`projectedColumns`) rather than from the row, so the SQL
 * is right either way. Closing the last case means threading the selection's
 * *type* through `SelectState` into `.as()`, which is a larger change than the
 * one symptom justifies.
 */
type SubqueryLeaf = string | number | bigint | boolean | Date | Uint8Array | ArrayBuffer | null | undefined;

/** Map a user-supplied projection to its row type. */
export type SelectionToRow<S> = Simplify<
	{
		[K in keyof S]: S[K] extends Column<infer M extends ColumnMeta>
			? M['notNull'] extends true ? M['data'] : M['data'] | null
			: S[K] extends SQLChunk<infer T> ? T
			: S[K] extends object ? SelectionToRow<S[K]>
			: never;
	}
>;

export interface SelectState {
	row: unknown;
	baseName: string;
	baseRow: unknown;
	joined: Record<string, unknown>;
	explicit: boolean;
}

export type ResultRow<S extends SelectState> = S['explicit'] extends true ? S['row']
	: [keyof S['joined']] extends [never] ? S['baseRow']
	: Simplify<{ [K in S['baseName']]: S['baseRow'] } & S['joined']>;

/**
 * `TBaseNullable` is the right/full half of an outer join.
 *
 * The runtime already gets this right — `implicitSelection` marks the base
 * table nullable for a right or full join, and the mapper duly returns `null`
 * for it — but the type only ever varied the joined side, so a right join
 * typechecked as though the base row were always present and handed back a
 * `null` the caller had no reason to guard.
 */
type AddJoin<
	S extends SelectState,
	T extends Table,
	TNullable extends boolean,
	TBaseNullable extends boolean = false,
> = Simplify<
	Omit<S, 'joined' | 'baseRow'> & {
		baseRow: TBaseNullable extends true ? S['baseRow'] | null : S['baseRow'];
		// TBaseNullable also matches the runtime fold in `nullableTables`
		// (src/plan/compile.ts): a right/full join nullifies every table
		// already joined before it, not only the base table, so every
		// existing entry in `joined` needs the same `| null` widening.
		joined: (TBaseNullable extends true ? { [K in keyof S['joined']]: S['joined'][K] | null } : S['joined']) & {
			[K in NameOf<T>]: TNullable extends true ? InferSelect<T> | null : InferSelect<T>;
		};
	}
>;

/**
 * A lazy, immutable select. Each chained call returns a new builder; nothing
 * runs until `.all()`, `.get()`, or `await`.
 */
export class SelectBuilder<S extends SelectState> implements Promise<ResultRow<S>[]>, Runnable<ResultRow<S>[]>, SQLChunk {
	declare readonly __result?: ResultRow<S>[];

	readonly [Symbol.toStringTag] = 'Promise';

	#compiled: CompiledQuery<ResultRow<S>> | undefined;
	#single: SelectBuilder<S> | undefined;

	constructor(
		private readonly plan: SelectPlan,
		private readonly executor: QueryExecutor | undefined,
		readonly input: Record<string, unknown> | undefined = undefined,
	) {}

	#next(patch: Partial<SelectPlan>): SelectBuilder<S> {
		return new SelectBuilder<S>({ ...this.plan, ...patch }, this.executor, this.input);
	}

	#join<T extends Table, TNullable extends boolean, TBaseNullable extends boolean = false>(
		type: JoinType,
		t: T,
		on?: Condition,
	): SelectBuilder<AddJoin<S, T, TNullable, TBaseNullable>> {
		const join: Join = { type, table: t as Table, on };
		return new SelectBuilder<AddJoin<S, T, TNullable, TBaseNullable>>(
			{ ...this.plan, joins: [...this.plan.joins, join] },
			this.executor,
			this.input,
		);
	}

	where(condition: Condition | undefined): SelectBuilder<S> {
		return this.#next({ where: condition });
	}

	orderBy(...expressions: SQLChunk[]): SelectBuilder<S> {
		return this.#next({ orderBy: expressions });
	}

	groupBy(...expressions: SQLChunk[]): SelectBuilder<S> {
		return this.#next({ groupBy: expressions });
	}

	having(condition: Condition | undefined): SelectBuilder<S> {
		return this.#next({ having: condition });
	}

	limit(value: number | Placeholder): SelectBuilder<S> {
		return this.#next({ limit: value });
	}

	offset(value: number | Placeholder): SelectBuilder<S> {
		return this.#next({ offset: value });
	}

	innerJoin<T extends Table>(t: T, on: Condition): SelectBuilder<AddJoin<S, T, false>> {
		return this.#join<T, false>('inner', t, on);
	}

	leftJoin<T extends Table>(t: T, on: Condition): SelectBuilder<AddJoin<S, T, true>> {
		return this.#join<T, true>('left', t, on);
	}

	// A right join keeps every row of the joined table, so it is the *base*
	// row that can come back missing; a full join can drop either side.
	rightJoin<T extends Table>(t: T, on: Condition): SelectBuilder<AddJoin<S, T, false, true>> {
		return this.#join<T, false, true>('right', t, on);
	}

	fullJoin<T extends Table>(t: T, on: Condition): SelectBuilder<AddJoin<S, T, true, true>> {
		return this.#join<T, true, true>('full', t, on);
	}

	crossJoin<T extends Table>(t: T): SelectBuilder<AddJoin<S, T, false>> {
		return this.#join<T, false>('cross', t);
	}

	/** Bind placeholder values without executing. */
	bind(input: Record<string, unknown>): SelectBuilder<S> {
		return new SelectBuilder<S>(this.plan, this.executor, { ...this.input, ...input });
	}

	compile(): CompiledQuery<ResultRow<S>> {
		return (this.#compiled ??= compileSelect<ResultRow<S>>(
			this.plan,
			resolveContext(this.executor),
		));
	}

	/** Render as a nested statement: `where id in (…)`, `exists (…)`. */
	toQuery(ctx: RenderContext = defaultRenderContext): Query {
		const compiled = compileSelect(this.plan, ctx);
		return { sql: compiled.sql, params: compiled.params };
	}

	/** Name this select so it can be used as a table. */
	as<TName extends string>(name: TName): Subquery<SubqueryColumns<ResultRow<S>>, TName> {
		return createSubquery(
			name,
			this,
			subqueryColumns(this.plan, name),
			projectedNullableGroups(this.plan),
		) as unknown as Subquery<SubqueryColumns<ResultRow<S>>, TName>;
	}

	async all(input?: Record<string, unknown>): Promise<ResultRow<S>[]> {
		return this.#executor().executeRows(this.compile(), { ...this.input, ...input });
	}

	async get(input?: Record<string, unknown>): Promise<ResultRow<S> | undefined> {
		// `limit 1` cuts rows_read, and the derived builder is cached so a
		// hoisted query still compiles exactly once.
		this.#single ??= this.plan.limit === undefined ? this.limit(1) : this;
		const rows = await this.#single.all(input);
		return rows[0];
	}

	/** Execute for its metadata only. */
	async run(input?: Record<string, unknown>): Promise<D1Result> {
		return this.#executor().executeRun(this.compile(), { ...this.input, ...input });
	}

	then<TResult1 = ResultRow<S>[], TResult2 = never>(
		onfulfilled?: ((value: ResultRow<S>[]) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.all().then(onfulfilled, onrejected);
	}

	catch<TResult1 = never>(
		onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
	): Promise<ResultRow<S>[] | TResult1> {
		return this.then(undefined, onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<ResultRow<S>[]> {
		return this.then().finally(onfinally);
	}

	#executor(): QueryExecutor {
		if (!this.executor) {
			throw new Error(
				'This query has no database. Build it with db.select(), or compile it with '
					+ 'query.select()…compile() and run it via db.all(compiled, input).',
			);
		}
		return this.executor;
	}
}

/**
 * Columns a subquery exposes, derived from the projection the compiler will
 * actually emit.
 *
 * Two things make this more than a walk over `plan.selection`. `assignKeys`
 * renames the whole projection to `c0…cN` as soon as two leaves share a name,
 * which any nested selection or implicit join produces — so the emitted name
 * and the name the caller reads it back under are different, and the column has
 * to carry the former while being *keyed* by the latter. And an implicit join's
 * selection is not `plan.selection` at all; deriving from `plan.from` alone
 * dropped every joined table's columns from the surface.
 *
 * The result is nested exactly as the row is: `sq.users.id`, not `sq.id`. That
 * is what lets a subquery be selected from again, since `flattenSelection`
 * walks the same shape back out.
 */
const subqueryColumns = (plan: SelectPlan, aliasName: string): ColumnsMap => {
	const root: ColumnsMap = {};

	for (const { path, key, column: source, decode } of projectedColumns(plan)) {
		// `explicitName: key` is the emitted alias — the name inside the subquery
		// — while the map key is how the caller refers to it. Those differ under
		// any rename, and rendering used to use the map key, which named a column
		// the inner statement does not have.
		const config = source
			? { ...source.config, explicitName: key, fieldName: key }
			: {
				explicitName: key,
				fieldName: key,
				type: 'text',
				columnType: 'SQLiteText',
				notNull: false,
				primaryKey: false,
				autoIncrement: false,
				hasDefault: false,
				unique: false,
				encode: (value) => value as never,
				// An expression that knows how to decode itself has to keep doing so
				// through the alias: a nested limit routes the query through
				// `row_number()`, and without this the same extra would decode one
				// way with a limit and another way without.
				...(decode ? { decode } : {}),
			} satisfies ColumnConfig;
		// `columnClassFor`, not the base `Column`: adapters branch on the
		// per-type subclass — `is(col, SQLiteInteger)` — and a subquery column
		// built from the base class failed that walk, which is the whole reason
		// `drizzle-entity.ts` exists.
		const column = new (columnClassFor(config.columnType))(config);
		column.tableName = aliasName;

		let target = root;
		for (const segment of path.slice(0, -1)) {
			const existing = target[segment];
			target = (existing && !isColumn(existing) ? existing : (target[segment] = {})) as ColumnsMap;
		}
		target[path.at(-1)!] = column;
	}

	return root;
};

/** `db.select()` before a table is chosen. */
export class SelectRoot<TSelection extends Selection | undefined> {
	constructor(
		private readonly selection: TSelection,
		private readonly executor: QueryExecutor | undefined,
		private readonly distinct: boolean,
	) {}

	from<T extends Table>(
		t: T,
	): SelectBuilder<{
		row: TSelection extends Selection ? SelectionToRow<TSelection> : never;
		baseName: NameOf<T>;
		baseRow: InferSelect<T>;
		joined: {};
		explicit: TSelection extends undefined ? false : true;
	}> {
		return new SelectBuilder(
			{ ...emptySelectPlan(t as Table, this.selection), distinct: this.distinct },
			this.executor,
		);
	}

	/** A select with no `from`: `db.select({ now: sql`unixepoch()` })`. */
	compileStandalone(): SelectBuilder<{
		row: TSelection extends Selection ? SelectionToRow<TSelection> : never;
		baseName: string;
		baseRow: never;
		joined: {};
		explicit: true;
	}> {
		return new SelectBuilder(
			{ ...emptySelectPlan(undefined, this.selection), distinct: this.distinct },
			this.executor,
		);
	}
}
