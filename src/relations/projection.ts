/**
 * Projection helpers shared by both relational plans.
 *
 * A leaf module on purpose: `query.ts` imports `joined.ts` for its builder, so
 * anything `joined.ts` needed back from `query.ts` as a *value* would be a
 * cycle. These two were copied into both instead, which is the version of that
 * problem that only shows up when one copy is fixed.
 */
import type { Column } from '../schema/columns.js';

/** Which columns a level projects: explicit `true`s win, else all but `false`. */
export const pickColumns = (
	all: Record<string, Column<any>>,
	selection: Record<string, boolean | undefined> | undefined,
): string[] => {
	const keys = Object.keys(all);
	if (!selection) return keys;
	const included = keys.filter((key) => selection[key] === true);
	if (included.length > 0) return included;
	return keys.filter((key) => selection[key] !== false);
};

/**
 * The column key a `Column` is filed under in a table config.
 *
 * Relations carry column objects; the projection is keyed by TypeScript name,
 * and the two differ whenever a column was declared with an explicit SQL name.
 */
export const fieldNameOf = (columns: Record<string, Column<any>>, column: Column<any>): string => {
	for (const [key, candidate] of Object.entries(columns)) {
		if (candidate.name === column.name) return key;
	}
	return column.name;
};
