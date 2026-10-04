/**
 * Per-invocation totals (`usage`) and the caller's own ceilings (`budget`).
 *
 * `onQuery` reports one statement at a time, which leaves every caller writing
 * the same accumulator: an object, a closure that adds to it, and somewhere to
 * read it at the end. The version written outside the ORM also misses
 * `rows_read` — the number D1 bills — because a `Proxy` around the binding only
 * sees `prepare()` calls, and counts nothing at all on the `withSession()` path.
 *
 * The ceilings live here rather than in `limits.ts` because they are not D1's:
 * `plan` describes the platform's limit and stays a warning, while a `budget` is
 * a number the caller chose, usually well below it, and the only one of the two
 * that can say *stop*.
 */

import { warnAlways } from '../dev.js';
import type { BudgetReason } from '../errors.js';
import { D1BudgetExceededError } from '../errors.js';
import type { QueryEvent } from './result.js';

export interface BudgetOptions {
	/** Statements this database may send before `onExceeded` fires. */
	maxStatements?: number;
	/** Accumulated `rowsRead`, checked against the total so far. */
	maxRowsRead?: number;
	/** How many times one parameterised SQL shape may be executed. */
	repeatsPerShape?: number;
	/** Default `'warn'`, matching `plan`. */
	onExceeded?: 'warn' | 'throw';
}

export interface TableUsage {
	readonly statements: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

export interface UsageSnapshot {
	readonly statements: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	/** Summed `QueryEvent.durationMs` — wall clock, so it includes network. */
	readonly durationMs: number;
	/**
	 * Per table named by the statement. A join counts its rows against every
	 * table it reads, so these sum to more than `rowsRead`.
	 */
	readonly byTable: Record<string, TableUsage>;
	readonly byKind: Record<QueryEvent['kind'], number>;
	/** SQL shapes executed more than once, most repeated first. */
	readonly repeats: readonly { readonly sql: string; readonly count: number }[];
}

/**
 * One logical statement, for repeat counting; a `CompiledQuery` satisfies it.
 * A chunked statement is one shape however many parts it was split into.
 */
export interface Shape {
	readonly sql: string;
	readonly kind: QueryEvent['kind'];
}

/** What the meter needs off a finished statement; a `QueryEvent` satisfies it. */
export interface Measured {
	readonly kind: QueryEvent['kind'];
	readonly tables: readonly string[];
	readonly durationMs: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

/**
 * The fix for a repeated shape depends on what it does: the read advice the
 * `queriesPerInvocation` warning gives sends someone looping over writes the
 * wrong way.
 */
const REPEAT_ADVICE: Record<QueryEvent['kind'], string> = {
	select: 'one inArray() in place of a lookup per key, or one relational query with `with:` in '
		+ 'place of a query per parent',
	insert: 'one insert with every row, values([...]), in place of one per row — it is chunked to fit '
		+ 'the parameter limit',
	update: 'one update whose where covers every row, e.g. inArray(), where the rows take the same values',
	delete: 'one delete whose where covers every row, e.g. inArray()',
	raw: 'one statement covering every row in place of one per row',
};

/**
 * The counters, held for as long as the database object lives.
 *
 * Shared by every database derived from the one that was opened — notably those
 * `withSession()` returns, which reuse the resolved options — because an
 * invocation is one budget however many sessions it opens. Counting per
 * database object is exact for the ordinary `drizzle(env.DB)`-inside-`fetch`
 * shape and over-counts for a database hoisted to module scope, which is why
 * each warning fires at most once. There is no `reset()`, so a hoisted database
 * with `onExceeded: 'throw'` refuses every statement of every later request
 * once its isolate-lifetime total passes the limit, until the isolate goes.
 */
export class UsageMeter {
	#statements = 0;
	#rowsRead = 0;
	#rowsWritten = 0;
	#durationMs = 0;
	#byTable = new Map<string, { statements: number; rowsRead: number; rowsWritten: number }>();
	#byKind = new Map<QueryEvent['kind'], number>();
	/**
	 * Keyed on the parameterised SQL text: two runs with different bound values
	 * are one shape. Unbounded — one entry per distinct text — which is fine for
	 * a database per request and grows for the isolate's life on a hoisted one.
	 */
	#shapes = new Map<string, number>();
	#warned: Set<BudgetReason> | undefined;

	constructor(readonly budget: BudgetOptions | undefined) {
		// Rejected rather than accepted, for the reason a bad `plan` is: a limit
		// of `NaN` — `Number(env.MAX)` with the variable unset — compares false
		// against everything, so the guard is off while the caller believes it
		// is on. An unknown `onExceeded` would quietly mean `'warn'`.
		if (!budget) return;
		for (const key of ['maxStatements', 'maxRowsRead', 'repeatsPerShape'] as const) {
			const limit: unknown = budget[key];
			if (limit !== undefined && !(Number.isFinite(limit) && (limit as number) >= 0)) {
				throw new Error(`budget.${key} must be a finite number >= 0; received ${String(limit)}.`);
			}
		}
		const mode: unknown = budget.onExceeded;
		if (mode !== undefined && mode !== 'warn' && mode !== 'throw') {
			throw new Error(`budget.onExceeded must be 'warn' or 'throw'; received ${JSON.stringify(mode)}.`);
		}
	}

	/**
	 * Called once per send — one statement, one chunked statement's parts, or a
	 * whole `batch()` — after it is bound and before anything is logged or sent.
	 *
	 * The ceilings are checked here and not where the response arrives because a
	 * limit evaluated after execution is a post-mortem: `onExceeded: 'throw'` has
	 * to mean D1 is not read again. Every ceiling is checked before anything is
	 * counted, so a refused batch leaves the totals as they were — counting
	 * members one at a time left the ones ahead of the refusal counted, unsent.
	 *
	 * `sent` is every statement D1 will run, each chunk included, because that
	 * is how D1 counts them. `shapes` is one entry per *logical* statement
	 * (`undefined` for a relational read's continuation chunks): a statement
	 * split to fit the parameter budget is one execution of its shape, not a
	 * loop, and counting each part made `repeatsPerShape` refuse a wide insert.
	 */
	admit(sent: number, shapes: Shape | readonly Shape[] | undefined): void {
		const list: readonly Shape[] = shapes === undefined
			? []
			: Array.isArray(shapes)
			? shapes as readonly Shape[]
			: [shapes as Shape];
		const budget = this.budget;

		if (budget) {
			// `statements` and `repeats` report the count this send *would* make,
			// and both are checked and committed synchronously, so they hold
			// exactly even with statements in flight. `rowsRead` reports the total
			// so far: rows are only known once a response arrives, so everything
			// admitted while the total was still under the limit overshoots it —
			// a whole batch, and every statement running concurrently.
			const { maxStatements, maxRowsRead, repeatsPerShape } = budget;
			if (maxStatements !== undefined && this.#statements + sent > maxStatements) {
				this.#exceeded('statements', maxStatements, this.#statements + sent, undefined);
			}
			if (maxRowsRead !== undefined && this.#rowsRead > maxRowsRead) {
				this.#exceeded('rowsRead', maxRowsRead, this.#rowsRead, undefined);
			}
			if (repeatsPerShape !== undefined) {
				// A batch may carry one shape several times; each is an execution.
				const pending = new Map<string, number>();
				for (const shape of list) {
					const next = (pending.get(shape.sql) ?? this.#shapes.get(shape.sql) ?? 0) + 1;
					pending.set(shape.sql, next);
					if (next > repeatsPerShape) this.#exceeded('repeats', repeatsPerShape, next, shape);
				}
			}
		}

		this.#statements += sent;
		for (const shape of list) this.#shapes.set(shape.sql, (this.#shapes.get(shape.sql) ?? 0) + 1);
	}

	/** Called with every statement's response, from the one emit point. */
	record(event: Measured): void {
		this.#rowsRead += event.rowsRead;
		this.#rowsWritten += event.rowsWritten;
		// Every member of a `batch()` reports the batch's own wall clock, so this
		// sums to more than the batch took. It is the sum of what `onQuery` was
		// told, which is what it claims to be.
		this.#durationMs += event.durationMs;
		this.#byKind.set(event.kind, (this.#byKind.get(event.kind) ?? 0) + 1);

		for (const table of event.tables) {
			const row = this.#byTable.get(table);
			if (row) {
				row.statements += 1;
				row.rowsRead += event.rowsRead;
				row.rowsWritten += event.rowsWritten;
			} else {
				this.#byTable.set(table, {
					statements: 1,
					rowsRead: event.rowsRead,
					rowsWritten: event.rowsWritten,
				});
			}
		}
	}

	/** A copy, safe to hand to a structured logger: reading it counts nothing. */
	snapshot(): UsageSnapshot {
		const byTable: Record<string, TableUsage> = {};
		for (const [name, row] of this.#byTable) byTable[name] = { ...row };

		const byKind: Record<QueryEvent['kind'], number> = {
			select: 0,
			insert: 0,
			update: 0,
			delete: 0,
			raw: 0,
		};
		for (const [kind, count] of this.#byKind) byKind[kind] = count;

		const repeats: { sql: string; count: number }[] = [];
		for (const [sql, count] of this.#shapes) if (count > 1) repeats.push({ sql, count });
		repeats.sort((a, b) => b.count - a.count);

		return {
			statements: this.#statements,
			rowsRead: this.#rowsRead,
			rowsWritten: this.#rowsWritten,
			durationMs: this.#durationMs,
			byTable,
			byKind,
			repeats,
		};
	}

	#exceeded(reason: BudgetReason, limit: number, observed: number, shape: Shape | undefined): void {
		const message = reason === 'statements'
			? `This database is about to reach ${observed} statements, past budget.maxStatements of ${limit}. `
				+ 'Send fewer: fold a loop into one statement (inArray(), a multi-row insert, a relational '
				+ 'query with `with:`). batch() does not help; each member counts.'
			: reason === 'rowsRead'
			? `This database has read ${observed} rows, past budget.maxRowsRead of ${limit}. Read less: a `
				+ 'narrower where clause, a column list in place of select(), or an index.'
			: `This database is about to run one SQL shape ${observed} times, past budget.repeatsPerShape `
				+ `of ${limit}: ${shape!.sql}. If a loop sends it, use ${REPEAT_ADVICE[shape!.kind]}. If the `
				+ 'repetition is intended, raise repeatsPerShape.';
		const full = `${message} (Counted per database object: a database hoisted to module scope spans `
			+ 'requests and never resets.)';

		// Thrown before anything is sent, so nothing further reaches D1. Not an
		// `OrmD1QueryError`: no statement failed, we refused to send one.
		if (this.budget?.onExceeded === 'throw') {
			throw new D1BudgetExceededError(full, reason, limit, observed, shape?.sql);
		}

		// Once per reason per database object, for the reason the plan warnings
		// fire once: past the line every further statement is also past it, and
		// repeating the claim buries it.
		this.#warned ??= new Set();
		if (this.#warned.has(reason)) return;
		this.#warned.add(reason);
		warnAlways(full);
	}
}
