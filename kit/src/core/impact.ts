/**
 * What rebuilding a table costs, before you write the change that needs it.
 *
 * D1 does not allow `PRAGMA foreign_keys = OFF` inside a migration, so a table
 * that other tables reference cannot be rebuilt on its own: every foreign key
 * pointing at it has to be dropped first, and dropping a foreign key is itself
 * a rebuild of the table that holds it. The cost therefore runs *backwards*
 * along the reference edges, transitively, and the number it lands on is not
 * something you can see by reading a schema file.
 *
 * That number decides whether a CHECK is cheap to widen or is a week of
 * migrations, and it changes as the schema grows. Measuring it by hand — the
 * way a design document does, once, and then goes stale — is how a project
 * ends up quoting a table count from an older schema at the moment it matters
 * most. This computes it from the snapshot, so the answer is as current as the
 * schema is.
 *
 * Snapshot-only by default: no database, so it runs on a bare checkout. Given
 * a runner it also reports row counts, which is the second half of the cost —
 * a rebuild copies every row, and a table with no children but a hundred
 * million rows is not cheap either.
 */
import type { Snapshot } from './snapshot.js';
import type { SqlRunner } from './apply.js';

export interface TableImpact {
	readonly table: string;
	/** Foreign keys pointing directly at this table, as `child.constraint`. */
	readonly directReferences: readonly string[];
	/**
	 * Every table whose foreign keys have to come off and go back for this one
	 * to be rebuilt — the transitive closure over reverse-reference edges.
	 * Excludes the table itself.
	 */
	readonly closure: readonly string[];
	/** `select count(*)` per table in the closure, when a runner was given. */
	readonly rows?: Readonly<Record<string, number>>;
}

/** Child table → the tables it references. Self-references count. */
const referencesOf = (snapshot: Snapshot): Map<string, Set<string>> => {
	const out = new Map<string, Set<string>>();
	for (const [name, table] of Object.entries(snapshot.tables)) {
		const targets = new Set<string>();
		for (const fk of Object.values(table.foreignKeys)) targets.add(fk.tableTo);
		for (const column of Object.values(table.columns)) {
			if (column.references) targets.add(column.references.tableTo);
		}
		out.set(name, targets);
	}
	return out;
};

export function impactOf(snapshot: Snapshot, table: string): TableImpact {
	if (!snapshot.tables[table]) {
		const known = Object.keys(snapshot.tables).sort();
		throw new Error(
			`impact: no table named "${table}" in the snapshot. Known tables: ${known.join(', ')}.`,
		);
	}

	const references = referencesOf(snapshot);

	const direct: string[] = [];
	for (const [child, targets] of references) {
		if (!targets.has(table)) continue;
		const childTable = snapshot.tables[child]!;
		for (const fk of Object.values(childTable.foreignKeys)) {
			if (fk.tableTo === table) direct.push(`${child}.${fk.name}`);
		}
		for (const column of Object.values(childTable.columns)) {
			if (column.references?.tableTo === table) direct.push(`${child}.${column.name}`);
		}
	}

	// Breadth-first over reverse edges. A self-reference puts the table in its
	// own frontier, which is correct — `booking_payment_events.refund_of_id`
	// makes that table its own child — but it must not appear in its own
	// closure, so it is filtered at the end rather than skipped here.
	const closure = new Set<string>();
	const frontier = [table];
	while (frontier.length > 0) {
		const current = frontier.pop()!;
		for (const [child, targets] of references) {
			if (!targets.has(current)) continue;
			if (closure.has(child)) continue;
			closure.add(child);
			frontier.push(child);
		}
	}
	closure.delete(table);

	return { table, directReferences: direct.sort(), closure: [...closure].sort() };
}

/** `impactOf` plus a `select count(*)` for the table and everything in its closure. */
export async function impactWithRows(
	snapshot: Snapshot,
	table: string,
	runner: SqlRunner,
): Promise<TableImpact> {
	const base = impactOf(snapshot, table);
	const rows: Record<string, number> = {};
	for (const name of [table, ...base.closure]) {
		const [row] = await runner.all<{ n: number }>(
			`select count(*) as n from "${name.replaceAll('"', '""')}"`,
		);
		rows[name] = Number(row?.n ?? 0);
	}
	return { ...base, rows };
}

/** Every table, ordered by how expensive it is to rebuild. For a survey. */
export function impactRanking(snapshot: Snapshot): TableImpact[] {
	return Object.keys(snapshot.tables)
		.map((name) => impactOf(snapshot, name))
		.sort((a, b) => b.closure.length - a.closure.length || a.table.localeCompare(b.table));
}
