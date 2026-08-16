/**
 * The same vocabulary, spelled two different ways in two tables.
 *
 * A value set written as `check ("method" in ('card', 'cash'))` is per table,
 * and nothing compares one table's copy to another's. So when a vocabulary is
 * widened — a payment method added, a status added — it gets widened at the
 * call sites someone remembered, and the one they missed is a CHECK that now
 * rejects a value its siblings accept. Nothing fails at generate time. It
 * fails much later, at an INSERT, on the one path that writes the new value.
 *
 * What makes that detectable without guessing is the *shape* of the mistake:
 * the forgotten set is a **proper subset** of the others. Two tables that
 * legitimately share a column name with unrelated vocabularies — `status` on
 * an expense and `status` on an event — have sets that overlap partially or
 * not at all, and are left alone. Only a strict subset is reported, because
 * only a strict subset says "these were meant to be the same list, and one of
 * them was not updated".
 *
 * **It matches on the column name**, which is the one thing tying two
 * constraints together in a snapshot — a schema's own notion of "the same
 * vocabulary" (a shared constant, a shared factory) has been erased by the
 * time it gets here. So a copy of the list under a differently named column
 * is not compared. Measured against a 58-table schema that had exactly this
 * bug: four tables shared the vocabulary, three of them under `method` and
 * one under `selected_payment_method`, and the three were reported. Catching
 * the divergence at all is what matters; catching every pair of it is not
 * worth the false positives that a looser match would bring.
 */
import type { Snapshot } from './snapshot.js';

export interface VocabularyDivergence {
	/** The column name the two constraints agree on. */
	readonly column: string;
	readonly narrower: { readonly table: string; readonly constraint: string; readonly values: readonly string[] };
	readonly wider: { readonly table: string; readonly constraint: string; readonly values: readonly string[] };
	/** Values the wider set allows that the narrower one rejects. */
	readonly missing: readonly string[];
}

interface EnumCheck {
	readonly table: string;
	readonly constraint: string;
	readonly column: string;
	readonly values: readonly string[];
}

const parseEnumCheck = (text: string): { column: string; values: string[] } | undefined => {
	// Tolerate a wrapping pair of parentheses, which SQLite keeps verbatim.
	let body = text.trim();
	while (body.startsWith('(') && body.endsWith(')') && balanced(body.slice(1, -1))) {
		body = body.slice(1, -1).trim();
	}

	const nullable = /^(?:"([^"]+)"|(\w+))\s+is\s+null\s+or\s+(.*)$/is.exec(body);
	const rest = nullable ? nullable[3]!.trim() : body;

	const match = /^(?:"([^"]+)"|(\w+))\s+in\s*\(([^()]*)\)$/is.exec(rest);
	if (!match) return undefined;
	const column = match[1] ?? match[2]!;
	if (nullable && (nullable[1] ?? nullable[2]) !== column) return undefined;

	const values: string[] = [];
	for (const raw of match[3]!.split(',')) {
		const token = raw.trim();
		// Only string literals. A list of column references or numbers is not a
		// vocabulary in the sense this looks for.
		if (!token.startsWith("'") || !token.endsWith("'") || token.length < 2) return undefined;
		values.push(token.slice(1, -1).replaceAll("''", "'"));
	}
	return values.length > 0 ? { column, values } : undefined;
};

const balanced = (text: string): boolean => {
	let depth = 0;
	for (const ch of text) {
		if (ch === '(') depth++;
		else if (ch === ')' && --depth < 0) return false;
	}
	return depth === 0;
};

/**
 * Every pair of same-named columns whose allowed value sets are in a strict
 * subset relation, narrower side first.
 */
export function vocabularyDivergences(snapshot: Snapshot): VocabularyDivergence[] {
	const byColumn = new Map<string, EnumCheck[]>();
	for (const [tableName, table] of Object.entries(snapshot.tables)) {
		for (const check of Object.values(table.checkConstraints)) {
			const parsed = parseEnumCheck(check.value);
			if (!parsed) continue;
			// Only a column the table actually has: a check may name a column of
			// another table in a subquery, which is not this table's vocabulary.
			if (!table.columns[parsed.column]) continue;
			const list = byColumn.get(parsed.column) ?? [];
			list.push({ table: tableName, constraint: check.name, column: parsed.column, values: parsed.values });
			byColumn.set(parsed.column, list);
		}
	}

	const found: VocabularyDivergence[] = [];
	for (const [column, checks] of byColumn) {
		if (checks.length < 2) continue;
		for (let i = 0; i < checks.length; i++) {
			for (let j = 0; j < checks.length; j++) {
				if (i === j) continue;
				const a = checks[i]!;
				const b = checks[j]!;
				const wide = new Set(b.values);
				const missing = b.values.filter((v) => !a.values.includes(v));
				// Proper subset: everything `a` allows is allowed by `b`, and `b`
				// allows something more.
				if (missing.length === 0) continue;
				if (!a.values.every((v) => wide.has(v))) continue;
				found.push({
					column,
					narrower: { table: a.table, constraint: a.constraint, values: a.values },
					wider: { table: b.table, constraint: b.constraint, values: b.values },
					missing,
				});
			}
		}
	}
	return found.sort((x, y) =>
		x.column.localeCompare(y.column) || x.narrower.table.localeCompare(y.narrower.table)
	);
}

/** The divergences as the lines `generate` prints. */
export const vocabularyWarnings = (snapshot: Snapshot): string[] =>
	vocabularyDivergences(snapshot).map((d) =>
		`"${d.narrower.table}"."${d.column}" allows ${d.narrower.values.length} value(s) but `
		+ `"${d.wider.table}"."${d.column}" allows ${d.wider.values.length}, and the smaller set is `
		+ `contained in the larger — so this looks like one vocabulary that was widened in one place `
		+ `and not the other. "${d.narrower.table}" rejects: ${d.missing.map((v) => `'${v}'`).join(', ')}. `
		+ `If the two are meant to differ, rename one of the columns or the constraint so they stop `
		+ `looking like the same list.`
	);
