import { DeleteBuilder, deleteFrom } from '../builders/delete.js';
import { InsertRoot } from '../builders/insert.js';
import { SelectRoot } from '../builders/select.js';
import type { BatchResult, Runnable } from '../builders/types.js';
import { UpdateRoot } from '../builders/update.js';
import { isDev } from '../dev.js';
import { NoTransactionsError, wrapQueryError } from '../errors.js';
import type { D1Plan } from '../limits.js';
import { InvocationBudget, PLAN_LIMITS } from '../limits.js';
import type { CompiledQuery } from '../plan/compile.js';
import type { Selection } from '../plan/plan.js';
import type { D1Param } from '../sql/sql.js';
import { configureCasing } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { defaultRenderContext, resolveParamBudget } from '../sql/sql.js';
import type { QueryEvent } from './result.js';
import type { D1Target, ResolvedOptions } from './session.js';
import { Executor } from './session.js';

/**
 * Spelled here rather than imported from `relations/`: that module imports this
 * one, and a value-level cycle between them is not worth a shared alias. The
 * canonical name is re-exported as `RelationalStrategy`.
 */
export type RelationalStrategy = 'split' | 'joined';

/**
 * Subset of `drizzle-orm`'s `Logger` interface (`interface Logger {
 * logQuery(query: string, params: unknown[]): void }`) — kept identical so a
 * caller's existing Drizzle logger (custom or `DefaultLogger`) can be handed
 * to `logger:` unchanged.
 */
export interface Logger {
	logQuery(query: string, params: unknown[]): void;
}

/** Matches `drizzle-orm`'s `DefaultLogger`: one line per query, to `console.log`. */
class DefaultLogger implements Logger {
	logQuery(query: string, params: unknown[]): void {
		const stringifiedParams = params.map((p) => {
			try {
				return JSON.stringify(p);
			} catch {
				return String(p);
			}
		});
		const paramsStr = stringifiedParams.length ? ` -- params: [${stringifiedParams.join(', ')}]` : '';
		console.log(`Query: ${query}${paramsStr}`);
	}
}

const resolveLogger = (logger: boolean | Logger | undefined): Logger | undefined => {
	if (!logger) return undefined;
	return logger === true ? new DefaultLogger() : logger;
};

export interface OrmD1Options {
	/** Applied to column names that don't specify one explicitly. */
	casing?: 'preserve' | 'snake_case';
	/** Called after every executed statement, including each one in a batch. */
	onQuery?: (event: QueryEvent) => void;
	/** Bound-parameter ceiling used for insert chunking and `inArray` strategy. */
	maxParams?: number;
	/** Array length at or above which `inArray` switches to `json_each`. */
	jsonEachThreshold?: number;
	/**
	 * How `db.query.<table>.find*` answers a `with`.
	 *
	 * `'split'` (default) runs one query per relation level and stitches the
	 * rows in JavaScript: readable SQL, `rows_read` proportional to what was
	 * asked for, and no bound-parameter list wider than `json_each` can carry.
	 *
	 * `'joined'` runs one statement, with each relation as a correlated
	 * subquery wrapped in `json_group_array` / `json_object` — the shape
	 * Drizzle v1 produces on SQLite. One round trip instead of one per level,
	 * which matters most on `--remote`, at the cost of running the inner query
	 * once per outer row.
	 *
	 * Both return identical results; the workers suite asserts that against a
	 * real D1 database. A query the joined plan cannot express — a
	 * many-to-many across a junction — falls back to `'split'` on its own.
	 */
	relationalStrategy?: RelationalStrategy;
	/**
	 * Accepted and ignored. v0 took a schema module here; v1 takes the result
	 * of `defineRelations` as `relations`, which the root `drizzle()` reads.
	 */
	schema?: unknown;
	/**
	 * Drizzle-shaped query logging: `true` for a default `console.log` logger,
	 * an object implementing `Logger` to receive `logQuery(sql, params)` for
	 * every statement actually run (each chunk of a chunked write, each member
	 * of a batch), or omitted/`false` for none. Distinct from `onQuery` — which
	 * this project added and which also carries timing and D1's own row-count
	 * metadata — kept because `logger: true` is the single most common Drizzle
	 * debugging switch, and silently discarding it (as this used to) reads as
	 * "no queries are running".
	 */
	logger?: boolean | Logger;
	/**
	 * Which Workers plan this database is on.
	 *
	 * Only two D1 limits differ by plan — statements per Worker invocation
	 * (50 free / 1,000 paid) and database size (500 MB / 10 GB) — and neither
	 * can be checked until a statement has already run. Setting this turns on
	 * a dev-only warning for each. Everything else orm-d1 enforces, the
	 * bound-parameter budget included, is identical on both plans and needs no
	 * configuration.
	 *
	 * Left unset, neither warning fires: guessing wrong would either cry wolf
	 * on a paid database or stay silent on a free one.
	 */
	plan?: D1Plan;
}

/**
 * The query API. `withSession()` returns the same surface backed by a
 * `D1DatabaseSession`, which is why this is written against `D1Target`.
 */
/** A database bound to a `D1DatabaseSession`, plus its bookmark. */
export type OrmD1Session = OrmD1Database & {
	/** Stash in a cookie or DO for read-your-writes across requests. */
	bookmark(): D1SessionBookmark | null;
};

export class OrmD1Database {
	/** @internal */
	readonly executor: Executor;

	constructor(readonly $client: D1Target, readonly options: ResolvedOptions) {
		this.executor = new Executor($client, options);
	}

	/** @internal The configured bound-parameter budget, for callers that chunk. */
	get $maxParams(): number {
		return this.options.compileOptions.maxParams ?? defaultRenderContext.maxParams;
	}

	/** @internal Companion to `$maxParams`; both are needed to count parameters. */
	get $jsonEachThreshold(): number {
		return this.options.compileOptions.jsonEachThreshold
			?? Math.min(defaultRenderContext.jsonEachThreshold, this.$maxParams);
	}

	select(): SelectRoot<undefined>;
	select<TSelection extends Selection>(selection: TSelection): SelectRoot<TSelection>;
	select(selection?: Selection): any {
		return new SelectRoot(selection, this.executor, false);
	}

	selectDistinct(): SelectRoot<undefined>;
	selectDistinct<TSelection extends Selection>(selection: TSelection): SelectRoot<TSelection>;
	selectDistinct(selection?: Selection): any {
		return new SelectRoot(selection, this.executor, true);
	}

	insert<T extends Table>(t: T): InsertRoot<T> {
		return new InsertRoot(t, this.executor);
	}

	update<T extends Table>(t: T): UpdateRoot<T> {
		return new UpdateRoot(t, this.executor);
	}

	delete<T extends Table>(t: T): DeleteBuilder<T> {
		return deleteFrom(t, this.executor);
	}

	/** Run a query compiled elsewhere — the hoisted, module-scope hot path. */
	async all<TRow>(query: CompiledQuery<TRow>, input?: Record<string, unknown>): Promise<TRow[]> {
		return this.executor.executeRows(query, input);
	}

	async get<TRow>(query: CompiledQuery<TRow>, input?: Record<string, unknown>): Promise<TRow | undefined> {
		return (await this.executor.executeRows(query, input))[0];
	}

	async run(query: CompiledQuery<unknown>, input?: Record<string, unknown>): Promise<D1Result> {
		return this.executor.executeRun(query, input);
	}

	/** The atomic primitive: one round trip, all statements or none. */
	async batch<T extends readonly Runnable[]>(items: readonly [...T]): Promise<BatchResult<T>> {
		return this.executor.batch(items) as Promise<BatchResult<T>>;
	}

	/**
	 * Raw escape hatch. It reports like every other path: errors carry the SQL
	 * that caused them, and `onQuery` sees the statement. Being the documented
	 * way out of the builder is a reason for better diagnostics, not worse.
	 */
	async execute(sql: string, params: unknown[] = []): Promise<D1Result> {
		const stmt = this.$client.prepare(sql);
		const started = Date.now();
		try {
			const result = await (params.length > 0 ? stmt.bind(...params) : stmt).run();
			// Counts like any other statement: D1 does not care that we did not
			// build this one.
			this.options.budget?.record(result.meta?.size_after);
			this.options.onQuery?.({
				kind: 'raw',
				sql,
				tables: [],
				durationMs: Date.now() - started,
				rowsRead: Number(result.meta?.rows_read ?? 0),
				rowsWritten: Number(result.meta?.rows_written ?? 0),
				...(isDev() ? { params: params as D1Param[] } : {}),
			});
			return result;
		} catch (cause) {
			throw wrapQueryError(cause, sql, params as D1Param[]);
		}
	}

	/**
	 * @internal Re-attaches `query`/`_` to a database derived from this one.
	 * Set by `withRelations`; absent when no relations were supplied.
	 */
	$reattach?: (db: OrmD1Database) => void;

	withSession(
		constraintOrBookmark?: D1SessionConstraint | D1SessionBookmark,
	): this & { bookmark(): D1SessionBookmark | null } {
		const binding = this.$client as unknown as D1Database;
		if (typeof binding.withSession !== 'function') {
			throw new Error('withSession() requires a D1Database binding; sessions cannot be nested.');
		}
		const session = binding.withSession(constraintOrBookmark);
		const db = new OrmD1Database(session as unknown as D1Target, this.options);
		// Composition, not inheritance: the query surface is identical, and a
		// session only adds its bookmark.
		//
		// `db.query` and `db._` are attached by `withRelations`, which lives
		// behind `orm-d1/relations` and must stay unreachable from here — the
		// core bundle does not pay for the relational layer. So the derived
		// database is handed back to whatever attached them, through a hook
		// rather than an import. Without this, `withSession()` silently
		// returned a database with no `query`, and the two features the README
		// leads with did not compose: no relational query could be served from
		// a read replica.
		this.$reattach?.(db);
		return Object.assign(db, {
			bookmark: (): D1SessionBookmark | null => session.getBookmark(),
		}) as this & { bookmark(): D1SessionBookmark | null };
	}

	/**
	 * Exists only to fail loudly. D1 has no interactive transactions; the
	 * atomic primitive is `batch()`.
	 */
	transaction(): never {
		throw new NoTransactionsError();
	}
}

export function ormD1(binding: D1Database, options: OrmD1Options = {}): OrmD1Database {
	if (options.casing) configureCasing(options.casing);
	// Fail at construction rather than on whichever query happens to trip it:
	// the two options constrain each other, and a mismatch is a config bug.
	resolveParamBudget(options.maxParams, options.jsonEachThreshold);
	// `hasOwn`, not `in`: `'constructor' in PLAN_LIMITS` is true, and the lookup
	// would then hand InvocationBudget a function as its limits — every
	// comparison NaN, both warnings silently dead. Worse than rejecting it,
	// because the caller believes the guard is on. Same trap as `params.ts`.
	if (options.plan !== undefined && !Object.hasOwn(PLAN_LIMITS, options.plan)) {
		throw new Error(
			`plan must be 'free' or 'paid'; received ${JSON.stringify(options.plan)}.`,
		);
	}
	const resolved: ResolvedOptions = {
		compileOptions: {
			...(options.maxParams !== undefined ? { maxParams: options.maxParams } : {}),
			...(options.jsonEachThreshold !== undefined ? { jsonEachThreshold: options.jsonEachThreshold } : {}),
		},
		onQuery: options.onQuery,
		logger: resolveLogger(options.logger),
		// Created here rather than per Executor so that the databases
		// `withSession()` derives share the count — they are the same invocation.
		budget: options.plan ? new InvocationBudget(options.plan, PLAN_LIMITS[options.plan]) : undefined,
	};
	return new OrmD1Database(binding, resolved);
}

/**
 * Drizzle-compatible entry point, so the setup line migrates cleanly too.
 * The `schema` option is accepted and ignored: tables are imported directly.
 */
export const drizzle = (binding: D1Database, options: OrmD1Options = {}): OrmD1Database =>
	ormD1(binding, options);
