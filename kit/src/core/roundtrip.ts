/**
 * A draft for the change `generate` just refused.
 *
 * D1 will not let a table with children be rebuilt in one migration, and the
 * refusal is correct — but it leaves the person holding a change they still
 * have to make, and the way through it is a sequence nothing writes down.
 *
 * The naive version of that sequence does not work, which is the whole reason
 * this file is longer than it looks like it should be. "Drop the foreign keys
 * pointing at the target" is itself a rebuild of each child — and a child that
 * has children of its own is refused for exactly the same reason the target
 * was. Detaching therefore has to take out **every** reference edge inside the
 * closure at once, not just the edges into the target.
 *
 * Putting them back has the mirror problem, and it does not collapse the same
 * way. Restoring a table's foreign key means rebuilding that table, so nothing
 * may reference it at the time — which means a table has to be restored
 * *before* the tables that point at it. That is one migration per level of the
 * reference graph, deepest last, and it is what `docs/39` means by
 * 「1 段ずつ戻す」.
 *
 * Every leg is a diff between two schemas, so none of the SQL is written by
 * hand here: the intermediate schemas are synthesised and handed to
 * `diffSnapshots`, the same function that produces every other migration.
 *
 * **The draft is not a migration.** Between the detach and the last restore
 * the database runs with those foreign keys absent, so anything writing during
 * that window can insert a row the restored constraint would have rejected —
 * and the restore then fails on it. That is a judgement about a live system,
 * and nothing here can make it. The file is written outside the journal for
 * that reason: `migrate` reads the journal, so a draft is never applied by
 * accident.
 *
 * A reference cycle inside the closure has no such ordering at all. It is
 * reported rather than papered over: breaking it means choosing which
 * constraint to leave off, and that is a decision, not a default.
 */
import type { Snapshot, TableSnapshot } from './snapshot.js';
import { carryForwardCollations, diffSnapshots } from './diff.js';
import type { Statement } from './diff.js';
import { impactOf } from './impact.js';

export interface RoundtripLeg {
	readonly title: string;
	readonly note: string;
	readonly statements: readonly Statement[];
	readonly errors: readonly string[];
}

export interface RoundtripPlan {
	readonly table: string;
	/** Tables whose foreign keys have to come off and go back. */
	readonly closure: readonly string[];
	readonly legs: readonly RoundtripLeg[];
	/** True when some leg still could not be expressed. */
	readonly incomplete: boolean;
}

/** A copy of `snapshot` with every foreign key pointing into `targets` removed. */
const withoutReferencesTo = (snapshot: Snapshot, targets: ReadonlySet<string>): Snapshot => {
	const tables: Record<string, TableSnapshot> = {};
	for (const [name, table] of Object.entries(snapshot.tables)) {
		const foreignKeys = Object.fromEntries(
			Object.entries(table.foreignKeys).filter(([, fk]) => !targets.has(fk.tableTo)),
		);
		const columns = Object.fromEntries(
			Object.entries(table.columns).map(([columnName, column]) => {
				if (!column.references || !targets.has(column.references.tableTo)) return [columnName, column];
				const { references: _dropped, ...rest } = column;
				return [columnName, rest];
			}),
		);
		tables[name] = { ...table, columns, foreignKeys } as TableSnapshot;
	}
	return { ...snapshot, tables };
};

/**
 * Levels of the closure by distance from the target, longest path first.
 *
 * A table has to be restored before anything that references it, so a table
 * reachable by several paths belongs at its *longest* distance. Returns
 * `undefined` when a cycle makes the layering impossible.
 */
const levelsFrom = (
	snapshot: Snapshot,
	table: string,
	closure: readonly string[],
): string[][] | undefined => {
	const inScope = new Set([table, ...closure]);
	// child -> parents it references, restricted to the closure.
	const parents = new Map<string, Set<string>>();
	for (const name of inScope) {
		const t = snapshot.tables[name]!;
		const targets = new Set<string>();
		for (const fk of Object.values(t.foreignKeys)) {
			if (fk.tableTo !== name && inScope.has(fk.tableTo)) targets.add(fk.tableTo);
		}
		for (const column of Object.values(t.columns)) {
			const to = column.references?.tableTo;
			if (to && to !== name && inScope.has(to)) targets.add(to);
		}
		parents.set(name, targets);
	}

	const level = new Map<string, number>([[table, 0]]);
	// Longest-path layering: repeat until stable, bailing if it cannot settle.
	for (let pass = 0; pass <= inScope.size; pass++) {
		let changed = false;
		for (const name of closure) {
			let best = -1;
			for (const parent of parents.get(name) ?? []) {
				const parentLevel = level.get(parent);
				if (parentLevel === undefined) continue;
				best = Math.max(best, parentLevel + 1);
			}
			if (best < 0) continue;
			if (level.get(name) !== best) {
				level.set(name, best);
				changed = true;
			}
		}
		if (!changed) {
			const layered: string[][] = [];
			for (const name of closure) {
				const depth = level.get(name);
				if (depth === undefined) return undefined;
				(layered[depth - 1] ??= []).push(name);
			}
			return layered.map((names) => names.sort());
		}
	}
	return undefined;
};

/**
 * The passes, as separate migrations.
 *
 * `before` is the live schema, `after` the one the schema files now describe,
 * and `table` the one whose rebuild was refused.
 */
export function roundtripPlan(before: Snapshot, after: Snapshot, table: string): RoundtripPlan {
	const closure = impactOf(before, table).closure;
	if (closure.length === 0) {
		throw new Error(
			`roundtrip: nothing references "${table}", so it can be rebuilt in one migration. `
				+ 'This plan is only for the case `generate` refuses.',
		);
	}

	const scope = new Set([table, ...closure]);
	const legs: RoundtripLeg[] = [];

	// 1. Every reference edge inside the closure comes off at once. Taking off
	//    only the edges into the target would leave each child un-rebuildable,
	//    blocked by its own children.
	const detachedBefore = withoutReferencesTo(before, scope);
	const detachedAfter = withoutReferencesTo(after, scope);

	const detach = diffSnapshots(before, detachedBefore, {});
	legs.push({
		title: `1. Detach every foreign key inside the closure of "${table}"`,
		note: `Rebuilds ${closure.length} table(s) with their references removed. From here until the `
			+ 'last pass the database does not enforce any of them.',
		statements: detach.statements,
		errors: detach.errors,
	});

	// 2. The target, now that nothing points at it.
	const rebuild = diffSnapshots(detachedBefore, detachedAfter, {});
	legs.push({
		title: `2. Rebuild "${table}"`,
		note: 'Nothing references it now, so this is an ordinary rebuild.',
		statements: rebuild.statements,
		errors: rebuild.errors,
	});

	// 3..N. Restore one level at a time, a table before the tables that
	//       reference it. Restoring the whole closure at once fails for the
	//       same reason detaching one level at a time does.
	const levels = levelsFrom(after, table, closure) ?? [[...closure]];

	let current = detachedAfter;
	levels.forEach((names, index) => {
		const restored = new Set(names);
		// Put back only the edges *out of* this level, leaving deeper levels
		// detached so these tables can still be rebuilt.
		const merged: Snapshot = {
			...current,
			tables: Object.fromEntries(
				Object.entries(current.tables).map(([name, t]) => [
					name,
					restored.has(name) ? after.tables[name]! : t,
				]),
			),
		};
		// `after.tables[name]` is schema-derived and structurally cannot state a
		// `collate` ([F-107]), so a table restored straight from it renders its
		// columns BINARY here even when the live column (`before`) carries a
		// collation — legs 1 and 2 do not have this problem because they diff
		// against `detachedBefore`/`detachedAfter`, which still carry it. Folding
		// `before`'s collations onto the merged snapshot before diffing closes
		// the gap the same way `generate` closes it for the persisted baseline.
		//
		// Scoped to `restored` — only those tables were just replaced with the
		// schema-derived `after` in `merged` above. Every other table in `merged`
		// still came from `current`/`detachedAfter`, which already carries
		// whatever collation it had; folding `before`'s collation onto those too
		// invents a difference (`undefined` vs `'nocase'`) that
		// `columnDifference`'s same-value exemption does not catch, forcing an
		// unrelated table — one with no path to the table being restored — into
		// the plan as a spurious (and sometimes destructive) recreate.
		const scopedBefore: Snapshot = {
			...before,
			tables: Object.fromEntries(
				Object.entries(before.tables).filter(([name]) => restored.has(name)),
			),
		};
		const next = carryForwardCollations(scopedBefore, merged, {});
		const leg = diffSnapshots(current, next, {});
		legs.push({
			title: `${index + 3}. Restore the foreign keys of ${names.map((n) => `"${n}"`).join(', ')}`,
			note: index === levels.length - 1
				? 'The last pass. Fails if anything written during the window violates a restored key.'
				: 'These reference tables that are already restored; the deeper levels stay detached '
					+ 'so this rebuild is not blocked.',
			statements: leg.statements,
			errors: leg.errors,
		});
		current = next;
	});

	// Anything still detached. In the ordinary case this is empty — but when the
	// *target* references something inside its own closure, pass 1 took that
	// edge off too and no level restores it, because the levels only cover the
	// closure. Diffing what is left against `after` both puts it back and
	// proves the plan actually lands on the schema it claims to.
	const remainder = diffSnapshots(current, after, {});
	if (remainder.statements.length > 0 || remainder.errors.length > 0) {
		legs.push({
			title: `${legs.length + 1}. Restore what is left`,
			note: `"${table}" references a table inside its own closure, so its own foreign key came off `
				+ 'in pass 1 as well.',
			statements: remainder.statements,
			errors: remainder.errors.length > 0
				? [
					...remainder.errors,
					`This is a reference cycle: "${table}" and its closure point at each other, so there is `
						+ 'no order in which every foreign key can be restored — each table has to be rebuilt '
						+ 'at a moment when nothing references it, and in a cycle no such moment exists. '
						+ 'Breaking it means leaving one constraint off permanently, or merging the tables.',
				]
				: [],
		});
	}

	return {
		table,
		closure,
		legs,
		incomplete: legs.some((leg) => leg.errors.length > 0),
	};
}

/** The plan as a file: SQL, but annotated and deliberately not a migration. */
export function renderRoundtrip(plan: RoundtripPlan): string {
	const lines: string[] = [
		`-- DRAFT — not a migration. Review, split, and record each pass yourself.`,
		`--`,
		`-- Rebuilding "${plan.table}" is refused in one step because ${plan.closure.length} table(s)`,
		`-- reference it, and D1 cannot disable foreign keys inside a migration. The three`,
		`-- passes below are the way through. They are NOT safe to paste as one file:`,
		`--`,
		`--   * Each pass has to be its own migration, applied and verified in order.`,
		`--   * Between pass 1 and pass 3 the foreign keys are absent. Anything writing in`,
		`--     that window can create a row that pass 3 then refuses. Check for orphans`,
		`--     before pass 3, and prefer a maintenance window.`,
		`--   * Statements marked DESTRUCTIVE need --accept-data-loss and a reason to.`,
		`--`,
		`-- Tables in the closure: ${plan.closure.join(', ')}`,
		'',
	];

	if (plan.incomplete) {
		lines.push(
			'-- !! This draft is INCOMPLETE: at least one pass could not be expressed.',
			'-- !! See the errors below; the rest of the plan is still worth reading.',
			'',
		);
	}

	for (const leg of plan.legs) {
		lines.push(`-- ${'='.repeat(72)}`, `-- ${leg.title}`, `-- ${leg.note}`, `-- ${'='.repeat(72)}`, '');
		for (const error of leg.errors) lines.push(`-- !! ${error}`, '');
		for (const statement of leg.statements) {
			if (statement.destructive) {
				lines.push(`-- DESTRUCTIVE: ${statement.reason ?? 'may lose data'}`);
			}
			lines.push(`${statement.sql};`, '');
		}
		if (leg.statements.length === 0 && leg.errors.length === 0) {
			lines.push('-- (nothing to do in this pass)', '');
		}
	}

	return lines.join('\n');
}
