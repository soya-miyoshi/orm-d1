import type { CompiledQuery } from '../plan/compile.js';
import { compileInsert } from '../plan/compile.js';
import type { InsertPlan, Selection } from '../plan/plan.js';
import type { Column } from '../schema/columns.js';
import type { InferInsert, InferSelect } from '../schema/infer.js';
import type { Table } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import type { Placeholder, SQLChunk } from '../sql/sql.js';
import type { SelectionToRow } from './select.js';
import type { QueryExecutor, Runnable } from './types.js';
import { executor, resolveContext } from './types.js';

/** Values accepted for a column: a literal, a placeholder, or raw SQL. */
export type InsertValues<T extends Table> = {
	[K in keyof InferInsert<T>]: InferInsert<T>[K] | Placeholder | SQLChunk;
};

export class InsertBuilder<T extends Table, TRow = never, THasRows extends boolean = false>
	implements Promise<THasRows extends true ? TRow[] : D1Result>, Runnable<THasRows extends true ? TRow[] : D1Result>
{
	declare readonly __result?: THasRows extends true ? TRow[] : D1Result;

	readonly [Symbol.toStringTag] = 'Promise';

	#compiled: CompiledQuery<TRow> | undefined;

	constructor(
		private readonly plan: InsertPlan,
		private readonly executor: QueryExecutor | undefined,
		readonly input: Record<string, unknown> | undefined = undefined,
	) {}

	#next<TR, TH extends boolean>(patch: Partial<InsertPlan>): InsertBuilder<T, TR, TH> {
		return new InsertBuilder<T, TR, TH>({ ...this.plan, ...patch }, this.executor, this.input);
	}

	onConflictDoNothing(
		config?: { target?: Column<any> | readonly Column<any>[]; where?: Condition },
	): InsertBuilder<T, TRow, THasRows> {
		return this.#next({
			onConflict: {
				target: config?.target
					? { columns: toColumns(config.target), where: config.where }
					: undefined,
				doNothing: true,
				set: undefined,
				setWhere: undefined,
			},
		});
	}

	onConflictDoUpdate(config: {
		target: Column<any> | readonly Column<any>[];
		/**
		 * `undefined` is admitted explicitly, not just by omission: under
		 * `exactOptionalPropertyTypes` those are different types, and
		 * `{ name: touched ? value : undefined }` is how a conditional upsert
		 * is written. A set with nothing left to assign compiles to
		 * `do nothing`.
		 */
		set: { [K in keyof InsertValues<T>]?: InsertValues<T>[K] | undefined };
		/** Predicate on the conflict target (a partial-index constraint). */
		targetWhere?: Condition;
		/** Predicate on the update itself. */
		where?: Condition;
	}): InsertBuilder<T, TRow, THasRows> {
		return this.#next({
			onConflict: {
				target: { columns: toColumns(config.target), where: config.targetWhere },
				doNothing: false,
				set: config.set as Record<string, unknown>,
				setWhere: config.where,
			},
		});
	}

	returning(): InsertBuilder<T, InferSelect<T>, true>;
	returning<TSelection extends Selection>(
		selection: TSelection,
	): InsertBuilder<T, SelectionToRow<TSelection>, true>;
	returning(selection?: Selection): InsertBuilder<T, any, true> {
		return this.#next<any, true>({ returning: selection ?? true });
	}

	bind(input: Record<string, unknown>): InsertBuilder<T, TRow, THasRows> {
		return new InsertBuilder<T, TRow, THasRows>(this.plan, this.executor, { ...this.input, ...input });
	}

	compile(): CompiledQuery<TRow> {
		return (this.#compiled ??= compileInsert<TRow>(this.plan, resolveContext(this.executor)));
	}

	async run(input?: Record<string, unknown>): Promise<D1Result> {
		return executor(this.executor).executeRun(this.compile(), { ...this.input, ...input });
	}

	async all(input?: Record<string, unknown>): Promise<TRow[]> {
		return executor(this.executor).executeRows(this.compile(), { ...this.input, ...input });
	}

	async get(input?: Record<string, unknown>): Promise<TRow | undefined> {
		return (await this.all(input))[0];
	}

	then<TResult1 = THasRows extends true ? TRow[] : D1Result, TResult2 = never>(
		onfulfilled?: ((value: THasRows extends true ? TRow[] : D1Result) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		const promise = this.plan.returning ? this.all() : this.run();
		return (promise as Promise<any>).then(onfulfilled as any, onrejected);
	}

	catch<TResult1 = never>(
		onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
	): Promise<(THasRows extends true ? TRow[] : D1Result) | TResult1> {
		return this.then(undefined, onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<THasRows extends true ? TRow[] : D1Result> {
		return this.then().finally(onfinally);
	}
}

export class InsertRoot<T extends Table> {
	constructor(private readonly table: T, private readonly executor: QueryExecutor | undefined) {}

	values(values: InsertValues<T> | readonly InsertValues<T>[]): InsertBuilder<T> {
		const rows = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
		return new InsertBuilder<T>(
			{
				kind: 'insert',
				table: this.table as Table,
				values: rows,
				onConflict: undefined,
				returning: undefined,
			},
			this.executor,
		);
	}
}

const toColumns = (target: Column<any> | readonly Column<any>[]): readonly Column<any>[] =>
	Array.isArray(target) ? target : [target as Column<any>];
