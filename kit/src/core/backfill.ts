/**
 * Write to an append-only table on purpose, once.
 *
 * The guard is a trigger, and a trigger can be dropped and put back without
 * rebuilding anything — so backfilling a column on an append-only table is
 * cheap. It is just not *safe* when assembled by hand, and the two ways it
 * goes wrong are both silent:
 *
 *   - **The `create trigger` is forgotten.** Nothing errors. The table simply
 *     accepts UPDATEs from then on, and the next person to notice is whoever
 *     is auditing the ledger months later.
 *   - **The `create trigger` is retyped and comes back different.** Since the
 *     guard may now name a column list, restating it means restating that
 *     list, and a list that is one column short reads as protection but is
 *     not.
 *
 * So the guard is never restated here: it is read out of `sqlite_master`,
 * dropped, and put back from the captured text. Whatever was protecting the
 * table before is exactly what protects it after — including a hand-written
 * guard this tool did not author.
 *
 * The whole thing goes through `batch()`, which is one transaction on D1. A
 * backfill that fails leaves the table exactly as it was, guard included;
 * there is no window in which the table is writable and no one is watching.
 */
import { appendOnlyTriggerGuard } from './introspect.js';
import type { SqlRunner } from './apply.js';

export interface BackfillResult {
	/** Tables whose guard was suspended, with the guard's columns (`true` = all). */
	readonly suspended: Readonly<Record<string, boolean | string[]>>;
	/** Every statement sent, in order, including the drops and re-creates. */
	readonly statements: readonly string[];
}

interface TriggerRow {
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string | null;
}

/**
 * Run `statements` with the append-only guards on `tables` suspended.
 *
 * ```ts
 * await backfill(runner, {
 *   tables: ['transactions'],
 *   statements: [`update "transactions" set "stripe_fee" = 0 where "stripe_fee" is null`],
 * });
 * ```
 *
 * Refuses rather than proceeding when a named table has no guard: that means
 * either the name is wrong or the write did not need this, and both are worth
 * stopping for. Refuses an empty `statements` for the same reason — dropping
 * and re-creating a guard to do nothing is not a thing to do by accident.
 */
export async function backfill(
	runner: SqlRunner,
	options: { readonly tables: readonly string[]; readonly statements: readonly string[] },
): Promise<BackfillResult> {
	const tables = [...new Set(options.tables)];
	if (tables.length === 0) {
		throw new Error('backfill: no tables named. Name the append-only tables whose guard to suspend.');
	}
	if (options.statements.length === 0) {
		throw new Error(
			'backfill: no statements to run. Suspending a guard to write nothing leaves the table '
				+ 'unprotected for the length of the batch and changes nothing.',
		);
	}

	const rows = await runner.all<TriggerRow>(
		"select name, tbl_name, sql from sqlite_master where type = 'trigger'",
	);

	const guards = new Map<string, { name: string; sql: string; columns: boolean | string[] }>();
	for (const row of rows) {
		if (!row.sql) continue;
		const columns = appendOnlyTriggerGuard(row.sql, row.tbl_name);
		if (columns === false) continue;
		guards.set(row.tbl_name, { name: row.name, sql: row.sql, columns });
	}

	const missing = tables.filter((t) => !guards.has(t));
	if (missing.length > 0) {
		const known = [...guards.keys()].sort();
		throw new Error(
			`backfill: no append-only guard found on ${missing.map((t) => `"${t}"`).join(', ')}. `
				+ 'Either the table name is wrong, or the table is already writable and the statements can '
				+ `be run directly. Guarded tables in this database: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
		);
	}

	const chosen = tables.map((t) => ({ table: t, ...guards.get(t)! }));
	const statements = [
		...chosen.map((g) => `drop trigger ${quote(g.name)}`),
		...options.statements,
		// Verbatim, not regenerated: see the note at the top of this file.
		...chosen.map((g) => g.sql),
	];

	await runner.batch(statements);

	// The batch is a transaction, so this cannot have half-applied — but the
	// cost of the guard being gone is high enough, and the check cheap enough,
	// that it is worth confirming rather than assuming.
	const after = await runner.all<TriggerRow>(
		"select name, tbl_name, sql from sqlite_master where type = 'trigger'",
	);
	const restored = new Set(
		after.filter((r) => r.sql && appendOnlyTriggerGuard(r.sql, r.tbl_name) !== false).map((r) => r.tbl_name),
	);
	const lost = tables.filter((t) => !restored.has(t));
	if (lost.length > 0) {
		throw new Error(
			`backfill: the append-only guard is missing from ${lost.map((t) => `"${t}"`).join(', ')} after the `
				+ 'batch. The table is writable right now. Re-create the trigger before anything else writes '
				+ 'to it.',
		);
	}

	return {
		suspended: Object.fromEntries(chosen.map((g) => [g.table, g.columns])),
		statements,
	};
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
