import type { CompiledQuery, CompileOptions } from '../plan/compile.js';
import type { RenderContext } from '../sql/sql.js';
import { resolveParamBudget } from '../sql/sql.js';

/** What a builder needs from the runtime. Kept minimal to avoid a cycle. */
export interface QueryExecutor {
	readonly compileOptions: CompileOptions;
	executeRows<T>(query: CompiledQuery<T>, input?: Record<string, unknown>): Promise<T[]>;
	executeRun(query: CompiledQuery<unknown>, input?: Record<string, unknown>): Promise<D1Result>;
}

/** Anything `db.batch([...])` accepts. */
export interface Runnable<TResult = unknown> {
	compile(): CompiledQuery<any>;
	/** @internal Placeholder values bound at build time, if any. */
	readonly input?: Record<string, unknown> | undefined;
	/** Phantom: the result this statement contributes to a batch tuple. */
	readonly __result?: TResult;
}

/**
 * The element type of `db.batch([...])`, under the name the call site uses.
 *
 * The same thing as `Runnable`, exported because a caller that builds
 * statements in one function and batches them in another otherwise has to
 * spell it `Parameters<Database['batch']>[0][number]`.
 */
export type BatchStatement<TResult = unknown> = Runnable<TResult>;

export type BatchResult<T extends readonly Runnable[]> = {
	[K in keyof T]: T[K] extends Runnable<infer R> ? R : never;
};

/**
 * The render context a builder compiles under, resolved from its executor.
 *
 * Here rather than in `insert.ts`, where it used to live alongside a copy in
 * `select.ts`: every builder needs it, and importing it from a sibling builder
 * makes a value-level cycle out of what is really shared infrastructure.
 */
export const resolveContext = (exec: QueryExecutor | undefined): RenderContext =>
	resolveParamBudget(exec?.compileOptions.maxParams, exec?.compileOptions.jsonEachThreshold);

export const executor = (exec: QueryExecutor | undefined): QueryExecutor => {
	if (!exec) throw new Error('This statement has no database. Use db.insert()/db.update()/db.delete().');
	return exec;
};
