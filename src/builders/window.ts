/**
 * One row per group, chosen by an ordering.
 *
 * SQLite has no `DISTINCT ON`, and `row_number()` cannot appear in `WHERE`, so
 * the only correct shape is a subquery that numbers the rows and an outer
 * select that keeps the ones numbered 1. Written by hand that is four moving
 * parts, and the two ways it gets written instead are both wrong on real data:
 *
 *   - **Fetch every row and keep the first seen per key in JS.** Correct, but
 *     it transfers the whole history to return its last page — the shape this
 *     helper replaces at its first call site.
 *   - **`order by <timestamp> desc limit 1` per group.** N queries, and on a
 *     millisecond timestamp it is not even deterministic: two rows written in
 *     the same millisecond are returned in whichever order the scan produced.
 *
 * That second failure is why `tiebreak` is a required argument rather than an
 * optional extra. A "latest row" query whose ordering is not a total order has
 * a right answer and a wrong answer and no way to tell which it returned, and
 * the bug surfaces as a state machine that occasionally reads one transition
 * stale. Making the parameter required means the broken form cannot be
 * written; there is no default that would be right, because only the caller
 * knows which of its columns is unique within a partition.
 */
import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { getTableColumns } from '../schema/table.js';
import type { Condition } from '../sql/expressions.js';
import { and, eq } from '../sql/expressions.js';
import type { SQLChunk } from '../sql/sql.js';
import { sql } from '../sql/sql.js';
import type { OrmD1Database } from '../runtime/database.js';
import type { InferSelectModel } from '../schema/infer.js';

/** Projected alongside the row's own columns; never survives into a result. */
const ROW_NUMBER = '__ormd1_latest_rn';

export interface LatestPerGroupConfig<T extends Table> {
	/** Columns the rows are grouped by — one row comes back per distinct value. */
	readonly partitionBy: readonly Column<any>[];
	/**
	 * The ordering that decides which row wins, newest first.
	 *
	 * Usually a single `desc(table.recordedAt)`. Ties are broken by `tiebreak`,
	 * so this does not have to be a total order on its own.
	 */
	readonly orderBy: readonly SQLChunk[];
	/**
	 * The last term of the ordering, which must be **unique within a
	 * partition** — an integer primary key, a ULID, a monotonic sequence.
	 *
	 * Required, not optional. See the note at the top of this file: without it
	 * the query silently returns either of two rows written in the same
	 * millisecond, and nothing downstream can tell.
	 */
	readonly tiebreak: SQLChunk;
	/** Narrows the rows considered, before the numbering. */
	readonly where?: Condition | undefined;
}

/**
 * The latest row in each group, as one statement.
 *
 * ```ts
 * const latest = await latestPerGroup(db, bookingEvents, {
 *   partitionBy: [bookingEvents.bookingId],
 *   orderBy: [desc(bookingEvents.recordedAt)],
 *   tiebreak: desc(bookingEvents.id),
 *   where: inArray(bookingEvents.bookingId, ids),
 * });
 * ```
 *
 * Compiles to a `row_number() over (partition by … order by …)` subquery whose
 * outer select keeps rank 1. The rank column is projected under a name no user
 * column can collide with and is dropped from the rows handed back.
 */
export async function latestPerGroup<T extends Table>(
	db: OrmD1Database,
	table: T,
	config: LatestPerGroupConfig<T>,
): Promise<InferSelectModel<T>[]> {
	if (config.partitionBy.length === 0) {
		throw new Error(
			'latestPerGroup: `partitionBy` is empty, so every row would be in one group and the query '
				+ 'would return a single row. Use an ordinary `select … order by … limit 1` for that.',
		);
	}
	if (config.orderBy.length === 0) {
		throw new Error(
			'latestPerGroup: `orderBy` is empty, so which row is "latest" is undefined. Order by the '
				+ 'column that decides it — usually a timestamp, newest first.',
		);
	}

	const columns = getTableColumns(table) as unknown as Record<string, SQLChunk>;
	const partition = sql.join([...config.partitionBy], ', ');
	const ordering = sql.join([...config.orderBy, config.tiebreak], ', ');

	const numbered = db
		.select({
			...columns,
			[ROW_NUMBER]: sql`row_number() over (partition by ${partition} order by ${ordering})`,
		})
		.from(table as never)
		.where(config.where as never)
		.as('ormd1_latest');

	const inner = getTableColumns(numbered as unknown as Table) as unknown as Record<string, SQLChunk>;
	const projection: Record<string, SQLChunk> = {};
	for (const key of Object.keys(columns)) projection[key] = inner[key]!;

	const rows = await db
		.select(projection)
		.from(numbered as never)
		.where(and(eq(inner[ROW_NUMBER] as never, 1)))
		.all();
	return rows as InferSelectModel<T>[];
}
