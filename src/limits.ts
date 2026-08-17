/**
 * D1's documented limits, and the checks that keep a query on the right side
 * of them.
 *
 * Transcribed from <https://developers.cloudflare.com/d1/platform/limits/>.
 * Two kinds live here:
 *
 * - **Plan-independent.** Statement length, function arity, pattern length,
 *   columns per table. These are the same on both plans and are checked at
 *   *compile* time, where the failure can name the call that caused it. Left
 *   to D1 they surface as a bare SQLite error with no pointer back to your code.
 * - **Plan-dependent.** Queries per Worker invocation and database size. These
 *   are only knowable once the caller says which plan they are on, which is
 *   what the `plan` option is for, and they are only observable *after* a
 *   statement runs — so they are dev-only warnings, not errors.
 *
 * The bound-parameter budget is deliberately *not* here: it is 100 on both
 * plans, it is a compile input rather than a check, and it already lives on
 * `RenderContext` where the chunking logic reads it.
 */

import { warn } from './dev.js';

/** Which Workers plan the database is on. Only the limits below differ. */
export type D1Plan = 'free' | 'paid';

export interface PlanLimits {
	/** Statements D1 will accept per Worker invocation. */
	readonly queriesPerInvocation: number;
	/** Maximum database size. D1 reports the current size as `meta.size_after`. */
	readonly databaseBytes: number;
}

export const PLAN_LIMITS: Record<D1Plan, PlanLimits> = {
	free: { queriesPerInvocation: 50, databaseBytes: 500_000_000 },
	paid: { queriesPerInvocation: 1_000, databaseBytes: 10_000_000_000 },
};

/** Maximum SQL statement length. Bound parameters are sent separately. */
export const MAX_STATEMENT_BYTES = 100_000;
/** Maximum arguments to a single SQL function — `coalesce`, `json_array`, … */
export const MAX_FUNCTION_ARGS = 32;
/** Maximum pattern length for `like` / `glob`. */
export const MAX_PATTERN_BYTES = 50;
/** Maximum columns per table. */
export const MAX_COLUMNS_PER_TABLE = 100;

/** Fraction of the size limit at which the size warning starts firing. */
const SIZE_WARNING_RATIO = 0.9;

let encoder: TextEncoder | undefined;

/**
 * Whether `text` exceeds `limit` **bytes**, which is how D1 states its limits
 * while JavaScript counts UTF-16 code units.
 *
 * Both cheap answers are taken first, because the expensive one walks the
 * string and the common caller is a 100 KB statement on a path that runs once
 * per isolate. A UTF-8 encoding is at least one byte and at most four per code
 * unit, so anything shorter than a quarter of the limit is under it and
 * anything longer than the limit is over it. Only the band between the two
 * needs measuring.
 */
export const exceedsBytes = (text: string, limit: number): boolean => {
	if (text.length <= limit / 4) return false;
	if (text.length > limit) return true;
	encoder ??= new TextEncoder();
	return encoder.encode(text).length > limit;
};

/**
 * The plan-dependent counters, held for as long as the database object lives.
 *
 * Shared across every database derived from the one you opened — notably the
 * ones `withSession()` returns — because the limit belongs to the invocation,
 * not to the session. `orm-d1()` creates one and it rides along in the
 * resolved options.
 *
 * Counting per database object is exact for the ordinary
 * `drizzle(env.DB)`-inside-`fetch` shape, and over-counts for a database
 * hoisted to module scope and reused across requests. That is why each warning
 * fires at most once per object: a hoisted database is wrong about *when* it
 * crossed the line, and repeating the claim on every subsequent query would
 * turn a useful signal into noise.
 */
export class InvocationBudget {
	#statements = 0;
	#warnedQueries = false;
	#warnedSize = false;

	constructor(readonly plan: D1Plan, readonly limits: PlanLimits) {}

	/** Called once per executed statement, including each one inside a batch. */
	record(sizeAfter: number | undefined): void {
		this.#statements += 1;

		if (!this.#warnedQueries && this.#statements > this.limits.queriesPerInvocation) {
			this.#warnedQueries = true;
			warn(
				`This database has run ${this.#statements} statements, past the ${this.plan} plan's limit of `
					+ `${this.limits.queriesPerInvocation} queries per Worker invocation. D1 will start rejecting `
					+ 'them. Reduce the *number* of statements: one inArray() in place of N lookups, one relational '
					+ 'query with `with:` in place of a query per parent. Batching does not help here — a batch '
					+ 'member counts individually, which is what makes batch() a fix for round trips and not for '
					+ 'this limit. (Counted per database object: if you hoisted this one to module scope it spans '
					+ 'requests, and this number is not a single invocation.)',
			);
		}

		if (
			!this.#warnedSize && sizeAfter !== undefined
			&& sizeAfter > this.limits.databaseBytes * SIZE_WARNING_RATIO
		) {
			this.#warnedSize = true;
			const gb = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(2)} GB`;
			warn(
				`Database is ${gb(sizeAfter)}, past ${SIZE_WARNING_RATIO * 100}% of the ${this.plan} plan's `
					+ `${gb(this.limits.databaseBytes)} limit. Writes fail once it is reached.`,
			);
		}
	}
}
