import { isDev } from './dev.js';
import type { D1Param } from './sql/sql.js';

/**
 * The one module permitted to use `extends` (rule R3): subclassing `Error` is
 * the only way to get `instanceof` working for consumers.
 */
export class OrmD1QueryError extends Error {
	readonly sql: string;
	/** `__DEV__` only — parameters routinely contain PII. */
	readonly params: readonly D1Param[] | undefined;
	override readonly cause: unknown;

	constructor(message: string, sql: string, cause: unknown, params?: readonly D1Param[]) {
		super(message);
		this.name = 'OrmD1QueryError';
		this.sql = sql;
		this.cause = cause;
		this.params = isDev() ? params : undefined;
	}
}

/** Which ceiling a `budget` refusal hit. See `runtime/usage.ts`. */
export type BudgetReason = 'statements' | 'rowsRead' | 'repeats';

/**
 * A statement the caller's own `budget` refused to send.
 *
 * Deliberately not an `OrmD1QueryError` subclass: nothing failed in D1 — the
 * statement was never sent — so a caller mapping errors to responses can tell
 * "I set a ceiling and we hit it" from "the database rejected a query" by type
 * rather than by matching on a message.
 */
export class D1BudgetExceededError extends Error {
	constructor(
		message: string,
		readonly reason: BudgetReason,
		readonly limit: number,
		/**
		 * The count that crossed the limit: for `statements` and `repeats` the
		 * count the refused send would have made, for `rowsRead` the total so far.
		 */
		readonly observed: number,
		/** The parameterised SQL of the refused statement; `repeats` only. */
		readonly sql?: string,
	) {
		super(message);
		this.name = 'D1BudgetExceededError';
	}
}

export const wrapQueryError = (
	cause: unknown,
	sql: string,
	params?: readonly D1Param[],
): OrmD1QueryError | D1BudgetExceededError => {
	// A budget refusal travels through here because the budget is checked inside
	// `Executor#prepare`, which `executeRows`/`executeRun` call inside their try.
	// Wrapping it would bury the one error a caller is meant to catch by type.
	if (cause instanceof D1BudgetExceededError) return cause;
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new OrmD1QueryError(`${detail}\n  in: ${sql}`, sql, cause, params);
};

/**
 * A query that cannot be compiled at all — a malformed plan, or one whose
 * bound parameters cannot be made to fit the budget by any amount of chunking.
 *
 * Lives here rather than in `plan/compile.ts` because `sql/expressions.ts`
 * throws it too, and `expressions` sits below `compile` in the import graph.
 */
export class CompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CompileError';
	}
}

/** Thrown by the `transaction()` stub. D1 has no interactive transactions. */
export class NoTransactionsError extends Error {
	constructor() {
		super(
			'orm-d1 does not provide transaction(). D1 has no interactive transactions: statements '
				+ 'in a session are not guaranteed to land on the same connection, so an emitted BEGIN may '
				+ 'apply elsewhere. Use db.batch([...]) instead — it is atomic and takes one round trip.',
		);
		this.name = 'NoTransactionsError';
	}
}
