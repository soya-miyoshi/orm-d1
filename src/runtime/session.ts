import type { QueryExecutor, Runnable } from '../builders/types.js';
import { assertHeader, assertScan, isDev } from '../dev.js';
import { wrapQueryError } from '../errors.js';
import type { InvocationBudget } from '../limits.js';
import type { CompiledQuery, CompileOptions } from '../plan/compile.js';
import { bindParams } from '../plan/params.js';
import type { D1Param } from '../sql/sql.js';
import type { QueryEvent } from './result.js';
import { buildEvent } from './result.js';

/**
 * `D1Database` and `D1DatabaseSession` both expose `prepare()` and `batch()`
 * with identical signatures, so the execution layer is written against the
 * intersection and needs no branching.
 */
export interface D1Target {
	prepare(query: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface ResolvedOptions {
	readonly compileOptions: CompileOptions;
	readonly onQuery: ((event: QueryEvent) => void) | undefined;
	/** See `Logger` in `runtime/database.ts` — `undefined` means no logging. */
	readonly logger: { logQuery(query: string, params: unknown[]): void } | undefined;
	/**
	 * Present only when `plan` was supplied. Shared by every database derived
	 * from the one that was opened — `withSession()` reuses these options — so
	 * a session's statements count toward the same invocation.
	 */
	readonly budget: InvocationBudget | undefined;
}

const now = (): number => Date.now();

/**
 * Summarise a chunked statement's parts for `wrapQueryError`, instead of
 * joining every part's SQL. D1's `batch()` gives no indication of which
 * member failed, so the earlier approach reported every part — measured at
 * 62KB+ for a 3000-row insert failing on its last chunk (~1KB baseline). The
 * first and last part plus the total count is almost always enough to place
 * the failure (an insert's parts are otherwise identical text with different
 * bound values) without scaling with the number of chunks. See [F-064].
 */
const summarizeParts = (sqls: readonly string[]): string => {
	if (sqls.length === 1) return sqls[0]!;
	const first = sqls[0]!;
	const last = sqls.at(-1)!;
	return `${sqls.length} parts; first: ${first}${first === last ? '' : `; last: ${last}`}`;
};

/**
 * Parameters to attach to a chunked-statement error — `__DEV__` only, same as
 * `OrmD1QueryError.params`, so the potentially-large `bound.flat()` allocation
 * is skipped entirely outside dev rather than computed and then discarded by
 * the constructor. Bounded to the first and last part's params, matching
 * `summarizeParts`.
 */
const summarizedParams = (bound: readonly (readonly D1Param[])[]): D1Param[] | undefined => {
	if (!isDev()) return undefined;
	if (bound.length <= 2) return bound.flat();
	return [...bound[0]!, ...bound.at(-1)!];
};

/**
 * Fold the results of a statement that compiled to several parts back into one.
 *
 * Returning only the last part's meta made `.run()` on a chunked bulk insert
 * report the last chunk's row count as the whole insert's — a wrong number with
 * no signal that anything had been split. Counters sum; `last_row_id` and the
 * flags come from the final part, which is the one that ran last.
 */
const mergeResults = (results: readonly D1Result[]): D1Result => {
	const last = results.at(-1)!;
	if (results.length === 1) return last;

	const sum = (key: 'changes' | 'rows_read' | 'rows_written' | 'duration'): number =>
		results.reduce((total, r) => total + (Number(r.meta?.[key]) || 0), 0);

	return {
		...last,
		meta: {
			...last.meta,
			changes: sum('changes'),
			rows_read: sum('rows_read'),
			rows_written: sum('rows_written'),
			duration: sum('duration'),
		},
	};
};

export class Executor implements QueryExecutor {
	constructor(readonly target: D1Target, readonly options: ResolvedOptions) {}

	get compileOptions(): CompileOptions {
		return this.options.compileOptions;
	}

	#emit(
		query: CompiledQuery<unknown>,
		sql: string,
		meta: (Partial<D1Meta> & Record<string, unknown>) | undefined,
		started: number,
		params: readonly D1Param[],
		rowsReturned: number,
	): void {
		// Reached for every statement, batch members included, because `isDev()`
		// forces the keyed read path — which is the same reason `onQuery` sees
		// them all. Outside dev, `warn()` is inert and this is a counter bump.
		// Unconditional, and first: the budget counts statements whether or not
		// anyone is listening to them.
		this.options.budget?.record(meta?.size_after);

		// `executeRows` already gates its keyed path on this pair, but
		// `executeRun` and `batch` call `#emit` unconditionally — so every
		// insert, update, delete and batch member built a `QueryEvent`, with up
		// to six conditional spreads, and dropped it unread. Nothing below has
		// an effect when no one is listening, so the whole tail is skipped.
		const onQuery = this.options.onQuery;
		if (!onQuery && !isDev()) return;

		const event = buildEvent(query, sql, meta, now() - started, isDev() ? params : undefined);
		if (isDev()) assertScan(event.rowsRead, rowsReturned, sql);
		onQuery?.(event);
	}

	#prepare(sql: string, params: readonly D1Param[]): D1PreparedStatement {
		// Every statement actually sent to D1 passes through here — each chunk
		// of a chunked write, each member of a `batch()`, and `db.execute()`'s
		// raw escape hatch via `prepareRaw` below — which is what makes this
		// the one place to log rather than the call sites above it.
		this.options.logger?.logQuery(sql, [...params]);
		const stmt = this.target.prepare(sql);
		return params.length > 0 ? stmt.bind(...params) : stmt;
	}

	/**
	 * The public seam for `db.execute()` — Database's raw escape hatch — so
	 * that path observes `logger`/`onQuery` the same as every built statement,
	 * instead of calling `$client.prepare()` directly and skipping this class
	 * entirely.
	 */
	prepareRaw(sql: string, params: readonly D1Param[]): D1PreparedStatement {
		return this.#prepare(sql, params);
	}

	async executeRows<T>(query: CompiledQuery<T>, input: Record<string, unknown> = {}): Promise<T[]> {
		if (query.parts.length > 1) return this.#executeChunked(query, input);

		const params = bindParams(query.params, input);
		const started = now();
		try {
			// The keyed path is only taken when someone is listening: `.raw()`
			// gives no D1Meta, so observability costs the object allocation.
			if (this.options.onQuery || isDev()) {
				const result = await this.#prepare(query.sql, params).all<Record<string, unknown>>();
				const rows = query.mapKeyed(result.results);
				if (isDev() && result.results.length > 0) {
					assertHeader(query.columnNames, Object.keys(result.results[0]!));
				}
				this.#emit(query, query.sql, result.meta, started, params, rows.length);
				return rows;
			}

			const raw = await this.#prepare(query.sql, params).raw<unknown[]>();
			return query.map(raw);
		} catch (cause) {
			throw wrapQueryError(cause, query.sql, params);
		}
	}

	async executeRun(query: CompiledQuery<unknown>, input: Record<string, unknown> = {}): Promise<D1Result> {
		if (query.parts.length > 1) {
			return mergeResults(await this.#runParts(query, input));
		}

		const params = bindParams(query.params, input);
		const started = now();
		try {
			const result = await this.#prepare(query.sql, params).run();
			this.#emit(query, query.sql, result.meta, started, params, result.results?.length ?? 0);
			return result;
		} catch (cause) {
			throw wrapQueryError(cause, query.sql, params);
		}
	}

	/**
	 * A statement that exceeded the bound-parameter budget compiled to several
	 * statements. They go out as one `batch()`, which keeps them atomic and
	 * keeps it to one round trip.
	 */
	async #runParts(query: CompiledQuery<unknown>, input: Record<string, unknown>): Promise<D1Result[]> {
		// Kept alongside the statements so `onQuery` can report them: a listener
		// used to see an empty parameter list for anything batched, which is
		// every chunked insert — exactly the case worth inspecting.
		const bound = query.parts.map((part) => bindParams(part.params, input));
		const prepared = query.parts.map((part, i) => this.#prepare(part.sql, bound[i]!));
		const started = now();
		try {
			const results = await this.target.batch(prepared);
			for (const [i, result] of results.entries()) {
				this.#emit(query, query.parts[i]!.sql, result.meta, started, bound[i]!, result.results?.length ?? 0);
			}
			return results as D1Result[];
		} catch (cause) {
			// `query.sql` is always `parts[0].sql` — reporting only it named the
			// wrong statement for anything but a failure in the first chunk. D1's
			// `batch()` gives no indication of which member failed, so the first
			// and last part's SQL and bound parameters are reported rather than
			// guessing which one to blame (or joining every part unbounded — see
			// `summarizeParts`). See [F-064].
			throw wrapQueryError(
				cause,
				summarizeParts(query.parts.map((part) => part.sql)),
				summarizedParams(bound),
			);
		}
	}

	async #executeChunked<T>(query: CompiledQuery<T>, input: Record<string, unknown>): Promise<T[]> {
		const results = await this.#runParts(query, input);
		const rows: T[] = [];
		for (const result of results) {
			rows.push(...query.mapKeyed((result.results ?? []) as Record<string, unknown>[]));
		}
		return rows;
	}

	/** One round trip, all-or-nothing, result tuple typed per statement. */
	async batch(items: readonly Runnable[]): Promise<unknown[]> {
		// D1 rejects an empty batch with "No SQL statements detected", which a
		// batch assembled from a filtered array reaches easily. No statements is
		// not an error; it is no results.
		if (items.length === 0) return [];

		const compiled = items.map((item) => ({ query: item.compile(), input: item.input ?? {} }));
		const statements: D1PreparedStatement[] = [];
		/** Which statement indices belong to which input item. */
		const spans: number[][] = [];

		/** Parallel to `statements`, so `onQuery` can report what was bound. */
		const bound: (readonly D1Param[])[] = [];
		/** Parallel to `statements` too — every part's SQL, not just each item's first. */
		const sqls: string[] = [];

		for (const { query, input } of compiled) {
			const span: number[] = [];
			for (const part of query.parts) {
				span.push(statements.length);
				const params = bindParams(part.params, input);
				bound.push(params);
				sqls.push(part.sql);
				statements.push(this.#prepare(part.sql, params));
			}
			spans.push(span);
		}

		const started = now();
		let results: D1Result<Record<string, unknown>>[];
		try {
			results = await this.target.batch<Record<string, unknown>>(statements);
		} catch (cause) {
			// `compiled.map((c) => c.query.sql)` joined only each item's *first*
			// part — an item that itself compiled to several chunked statements
			// (a wide insert inside `batch()`) lost every part but the first.
			// D1 gives no indication of which statement in the batch failed, so
			// the first and last statement actually sent are reported (not every
			// part unbounded — see `summarizeParts`). See [F-064].
			throw wrapQueryError(cause, summarizeParts(sqls), summarizedParams(bound));
		}

		return compiled.map(({ query }, i) => {
			const span = spans[i]!;
			const rows: unknown[] = [];
			const parts: D1Result[] = [];

			for (const [position, index] of span.entries()) {
				const result = results[index]!;
				parts.push(result as D1Result);
				this.#emit(query, query.parts[position]!.sql, result.meta, started, bound[index]!, result.results?.length ?? 0);
				// `batch()` has no raw mode, so selects take the keyed path —
				// which is why colliding projections are aliased at compile time.
				if (query.hasRows) rows.push(...query.mapKeyed(result.results ?? []));
			}

			// A chunked statement inside a batch folds down to one result too.
			return query.hasRows ? rows : mergeResults(parts);
		});
	}
}
