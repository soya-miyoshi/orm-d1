import type { CompiledQuery } from '../plan/compile.js';
import { compileDelete } from '../plan/compile.js';
import type { DeletePlan, Selection } from '../plan/plan.js';
import type { InferSelect } from '../schema/infer.js';
import type { Table } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import { executor, resolveContext } from './types.js';
import type { SelectionToRow } from './select.js';
import type { QueryExecutor, Runnable } from './types.js';

export class DeleteBuilder<T extends Table, TRow = never, THasRows extends boolean = false>
	implements Promise<THasRows extends true ? TRow[] : D1Result>, Runnable<THasRows extends true ? TRow[] : D1Result>
{
	declare readonly __result?: THasRows extends true ? TRow[] : D1Result;

	readonly [Symbol.toStringTag] = 'Promise';

	#compiled: CompiledQuery<TRow> | undefined;

	constructor(
		private readonly plan: DeletePlan,
		private readonly executor: QueryExecutor | undefined,
		readonly input: Record<string, unknown> | undefined = undefined,
	) {}

	where(condition: Condition | undefined): DeleteBuilder<T, TRow, THasRows> {
		return new DeleteBuilder<T, TRow, THasRows>({ ...this.plan, where: condition }, this.executor, this.input);
	}

	returning(): DeleteBuilder<T, InferSelect<T>, true>;
	returning<TSelection extends Selection>(
		selection: TSelection,
	): DeleteBuilder<T, SelectionToRow<TSelection>, true>;
	returning(selection?: Selection): DeleteBuilder<T, any, true> {
		return new DeleteBuilder<T, any, true>(
			{ ...this.plan, returning: selection ?? true },
			this.executor,
			this.input,
		);
	}

	bind(input: Record<string, unknown>): DeleteBuilder<T, TRow, THasRows> {
		return new DeleteBuilder<T, TRow, THasRows>(this.plan, this.executor, { ...this.input, ...input });
	}

	compile(): CompiledQuery<TRow> {
		return (this.#compiled ??= compileDelete<TRow>(this.plan, resolveContext(this.executor)));
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

export const deleteFrom = <T extends Table>(
	t: T,
	executorRef: QueryExecutor | undefined,
): DeleteBuilder<T> =>
	new DeleteBuilder<T>(
		{ kind: 'delete', table: t as Table, where: undefined, returning: undefined },
		executorRef,
	);
