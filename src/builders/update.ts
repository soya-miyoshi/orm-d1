import type { CompiledQuery } from '../plan/compile.js';
import { compileUpdate } from '../plan/compile.js';
import type { Selection, UpdatePlan } from '../plan/plan.js';
import type { InferInsert, InferSelect } from '../schema/infer.js';
import type { Table } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import type { Placeholder, SQLChunk } from '../sql/sql.js';
import { executor, resolveContext } from './types.js';
import type { SelectionToRow } from './select.js';
import type { QueryExecutor, Runnable } from './types.js';

/**
 * `undefined` is allowed explicitly, not just by omission: under
 * `exactOptionalPropertyTypes` the two are different types, and
 * `{ name: touched ? value : undefined }` is how a conditional update is
 * written. The compiler treats such a key as unset.
 */
export type UpdateValues<T extends Table> = {
	[K in keyof InferInsert<T>]?: InferInsert<T>[K] | Placeholder | SQLChunk | undefined;
};

export class UpdateBuilder<T extends Table, TRow = never, THasRows extends boolean = false>
	implements Promise<THasRows extends true ? TRow[] : D1Result>, Runnable<THasRows extends true ? TRow[] : D1Result>
{
	declare readonly __result?: THasRows extends true ? TRow[] : D1Result;

	readonly [Symbol.toStringTag] = 'Promise';

	#compiled: CompiledQuery<TRow> | undefined;

	constructor(
		private readonly plan: UpdatePlan,
		private readonly executor: QueryExecutor | undefined,
		readonly input: Record<string, unknown> | undefined = undefined,
	) {}

	where(condition: Condition | undefined): UpdateBuilder<T, TRow, THasRows> {
		return new UpdateBuilder<T, TRow, THasRows>({ ...this.plan, where: condition }, this.executor, this.input);
	}

	returning(): UpdateBuilder<T, InferSelect<T>, true>;
	returning<TSelection extends Selection>(
		selection: TSelection,
	): UpdateBuilder<T, SelectionToRow<TSelection>, true>;
	returning(selection?: Selection): UpdateBuilder<T, any, true> {
		return new UpdateBuilder<T, any, true>(
			{ ...this.plan, returning: selection ?? true },
			this.executor,
			this.input,
		);
	}

	bind(input: Record<string, unknown>): UpdateBuilder<T, TRow, THasRows> {
		return new UpdateBuilder<T, TRow, THasRows>(this.plan, this.executor, { ...this.input, ...input });
	}

	compile(): CompiledQuery<TRow> {
		return (this.#compiled ??= compileUpdate<TRow>(this.plan, resolveContext(this.executor)));
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

export class UpdateRoot<T extends Table> {
	constructor(private readonly table: T, private readonly executor: QueryExecutor | undefined) {}

	set(values: UpdateValues<T>): UpdateBuilder<T> {
		return new UpdateBuilder<T>(
			{
				kind: 'update',
				table: this.table as Table,
				set: values as Record<string, unknown>,
				where: undefined,
				returning: undefined,
			},
			this.executor,
		);
	}
}
