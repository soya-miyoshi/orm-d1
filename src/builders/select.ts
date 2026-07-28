import type { CompiledQuery } from '../plan/compile.js';
import { compileSelect } from '../plan/compile.js';
import type { Join, JoinType, Selection, SelectPlan } from '../plan/plan.js';
import { emptySelectPlan } from '../plan/plan.js';
import type { Column, ColumnMeta } from '../schema/columns.js';
import { Column as ColumnClass, isColumn } from '../schema/columns.js';
import type { ColumnsMap, NameOf, Subquery, Table } from '../schema/table.js';
import type { InferSelect, Simplify } from '../schema/infer.js';
import { createSubquery, getTableColumns } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import { hasDecode } from '../sql/functions.js';
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
	[K in keyof TRow]-?: Column<{
		data: NonNullable<TRow[K]>;
		notNull: null extends TRow[K] ? false : true;
		hasDefault: boolean;
	}>;
};

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
		joined: S['joined'] & {
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

/** Columns a subquery exposes, derived from its projection. */
const subqueryColumns = (plan: SelectPlan, aliasName: string): ColumnsMap => {
	const source: Selection = plan.selection
		?? (plan.from ? (getTableColumns(plan.from) as unknown as Selection) : {});
	const columns: ColumnsMap = {};

	for (const [key, entry] of Object.entries(source)) {
		if (isColumn(entry)) {
			const column = new ColumnClass({ ...entry.config, explicitName: key, fieldName: key });
			column.tableName = aliasName;
			columns[key] = column;
			continue;
		}
		const column = new ColumnClass({
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
			// `row_number()`, and without this the same extra would decode one way
			// with a limit and another way without.
			...(hasDecode(entry) ? { decode: entry.decode } : {}),
		});
		column.tableName = aliasName;
		columns[key] = column;
	}

	return columns;
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
