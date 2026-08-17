/**
 * Snapshot → SQL.
 *
 * SQLite supports only `ADD COLUMN`, `DROP COLUMN`, `RENAME COLUMN` and
 * `RENAME TO`. Everything else — a type change, a new `NOT NULL`, a changed
 * default, any constraint change — requires rebuilding the table. Getting that
 * wrong is the main way a migration tool destroys data, so the recreation path
 * is explicit, and the column list in its `INSERT … SELECT` is always computed
 * from the intersection of old and new columns. `SELECT *` is the classic
 * corruption bug and never appears here.
 */
import {
	appendOnlyColumns,
	appendOnlyKey,
	appendOnlyTrigger,
	appendOnlyTriggerName,
	dropAppendOnlyTrigger,
} from 'orm-d1/ddl';
import type { ColumnSnapshot, ForeignKeySnapshot, IndexSnapshot, Snapshot, TableSnapshot } from './snapshot.js';
import {
	canonicalTable,
	columnDifference,
	createIndexFromSnapshot,
	createTableFromSnapshot,
	normalizeIndexColumn,
	normalizeUniqueColumn,
	sameUniqueMembers,
	sameUniques,
} from './snapshot.js';
import { foldAsciiCase, lookupCaseInsensitive } from './sql.js';

export interface Statement {
	readonly sql: string;
	/** True when the statement can lose data. */
	readonly destructive: boolean;
	/** Human-readable reason, used by `--accept-data-loss` prompts and logs. */
	readonly reason?: string;
}

export interface DiffResult {
	readonly statements: readonly Statement[];
	/** Anything that cannot be expressed safely; `generate` refuses to emit. */
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

export interface DiffOptions {
	/** `{ 'old_table': 'new_table' }` — resolved interactively by the CLI. */
	readonly renamedTables?: Record<string, string>;
	/** `{ 'table.old_column': 'new_column' }`. */
	readonly renamedColumns?: Record<string, string>;
	/**
	 * Triggers found on the *live* table (keyed by table name) that orm-d1 did
	 * not author — everything except the append-only guard. Not part of
	 * `TableSnapshot`: that shape is schema-facing and exported, so this rides
	 * alongside it instead. See `introspect`'s `foreignTriggers` out-param.
	 */
	readonly foreignTriggers?: Record<string, readonly string[]>;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const columnDefinition = (column: ColumnSnapshot): string => {
	let ddl = `${quote(column.name)} ${column.declaredType ?? column.type}`;
	if (column.collate) ddl += ` collate ${column.collate}`;
	if (column.notNull) ddl += ' not null';
	if (column.unique) ddl += ' unique';
	if (column.generated) ddl += ` generated always as (${column.generated.as}) ${column.generated.mode}`;
	if (column.default !== undefined) ddl += ` default ${column.default}`;
	if (column.references) {
		ddl += ` references ${quote(column.references.tableTo)}(${quote(column.references.columnsTo[0] ?? '')})`;
		if (column.references.onDelete) ddl += ` on delete ${column.references.onDelete}`;
		if (column.references.onUpdate) ddl += ` on update ${column.references.onUpdate}`;
	}
	return ddl;
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The columns an `appendOnlyKey` covers, resolving `'*'` against the table. */
const guardedColumns = (key: string, all: readonly string[]): string[] =>
	key === '' ? [] : key === '*' ? [...all] : key.split(',');

/**
 * Columns the old guard protected that the new one does not.
 *
 * Empty when the guard only widens, which is what separates "this narrows a
 * protection, say so" from "this adds one, no comment needed".
 */
const guardedColumnsLost = (before: string, after: string, all: readonly string[]): string[] => {
	const kept = new Set(guardedColumns(after, all));
	return guardedColumns(before, all).filter((c) => !kept.has(c));
};

/** Can this column be appended with `ALTER TABLE … ADD COLUMN`? */
const isAddable = (column: ColumnSnapshot): string | undefined => {
	if (column.primaryKey) return 'it is a primary key';
	if (column.unique) return 'it is unique';
	if (column.notNull && column.default === undefined && !column.generated) {
		return 'it is NOT NULL with no default, so existing rows cannot be backfilled';
	}
	if (column.generated?.mode === 'stored') return 'stored generated columns cannot be added';
	// SQLite requires an ADD COLUMN default to be a constant: it has to be
	// materialisable for every existing row without evaluating anything.
	if (column.default !== undefined && !isConstantDefault(column.default)) {
		return 'its default is not a constant, which ALTER TABLE … ADD COLUMN does not accept';
	}
	return undefined;
};

/**
 * `default (unixepoch())`, `CURRENT_TIMESTAMP` and friends are rejected by
 * ADD COLUMN even though they are perfectly valid in a CREATE TABLE, so a
 * column with one has to go through the recreate path instead.
 */
const isConstantDefault = (value: unknown): boolean => {
	const text = String(value).trim();
	if (/^current_(timestamp|date|time)$/i.test(text)) return false;
	// Anything parenthesised is an expression; only a bare literal is constant.
	if (text.startsWith('(')) return false;
	return true;
};

/**
 * Whether anything still in `table` names `column` — and what, so the reason
 * can say. Matched on a word boundary, since `"email"` must not be found
 * inside `"email_verified"`.
 */
const survivingReferenceTo = (table: TableSnapshot, column: string): string | undefined => {
	const mentions = (text: string | undefined): boolean =>
		text !== undefined && new RegExp(`\\b${escapeRegExp(column)}\\b`).test(withoutLiterals(text));

	for (const index of Object.values(table.indexes)) {
		const columns = index.columns.map(normalizeIndexColumn);
		if (columns.some((c) => !c.isExpression && c.expression === column)) return `index "${index.name}"`;
		if (columns.some((c) => c.isExpression && mentions(c.expression))) return `index "${index.name}"`;
		if (mentions(index.where)) return `the predicate of index "${index.name}"`;
	}
	for (const check of Object.values(table.checkConstraints)) {
		if (mentions(check.value)) return `check constraint "${check.name}"`;
	}
	for (const other of Object.values(table.columns)) {
		if (mentions(other.generated?.as)) return `the generated expression of column "${other.name}"`;
	}
	return undefined;
};

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blank out single-quoted string literals before looking for a column name.
 *
 * `check ("keep" <> 'gone')` does not refer to a column called `gone`, and
 * treating it as though it did forced an unnecessary destructive rebuild —
 * or, on a table with children, a hard refusal. Doubled quotes are SQL's
 * escape, so `'it''s'` stays one literal.
 */
const withoutLiterals = (text: string): string => text.replaceAll(/'(?:[^']|'')*'/g, "''");

/** Everything about a table that a plain ALTER cannot change. */
const requiresRecreate = (
	before: TableSnapshot,
	after: TableSnapshot,
	columnRenames: Record<string, string>,
	afterIsSchemaDerived: boolean,
): string | undefined => {
	// Canonical, not raw: an introspected snapshot spells the same constraints
	// differently to a schema-derived one, and comparing raw shapes reported
	// permanent false drift. See `canonicalTable`.
	const a = canonicalTable(before);
	const b = canonicalTable(after);

	for (const [name, column] of Object.entries(a.columns)) {
		const target = b.columns[columnRenames[name] ?? name];
		if (target === undefined) {
			// The column is going away. DROP COLUMN re-validates every surviving
			// index, check and generated expression against the new shape, so if
			// any of them still names this column the ALTER fails outright and
			// the table has to be rebuilt instead. Primary keys, uniques and
			// foreign keys are already covered: `canonicalTable` lifts those to
			// the table level, where their loss shows up as a constraint change.
			const referent = survivingReferenceTo(after, name);
			if (referent) return `column "${name}" is dropped but ${referent} still refers to it`;
			continue;
		}
		const difference = columnDifference(column, target, afterIsSchemaDerived);
		if (difference) return `column "${name}" ${difference}`;
	}
	// Positional, not a multiset match (`sameUniques`'s reason for one does not
	// apply — a table has at most one primary key, nothing to disambiguate
	// against), and exempts an unstated member `collate` on a schema-derived
	// `b` the same way `sameUniqueMembers` already does for a unique
	// constraint's own members: the schema DSL cannot author one (`docs/04`),
	// so its absence there is not "changed to binary".
	if (!sameUniqueMembers(a.primaryKey, b.primaryKey, afterIsSchemaDerived)) return 'the primary key changes';
	if (!sameJson(a.foreignKeys, b.foreignKeys)) return 'a foreign key changes';
	if (!sameUniques(a.uniques, b.uniques, afterIsSchemaDerived)) return 'a unique constraint changes';
	if (!sameJson(a.checks, b.checks)) return 'a check constraint changes';
	// `STRICT` and `WITHOUT ROWID` are part of the `CREATE TABLE` statement, not
	// constraints, and SQLite has no ALTER for either — so changing one is a
	// rebuild like any other. `appendOnly` is deliberately NOT here: it is a
	// separate trigger object, added and dropped in place below.
	if (a.strict !== b.strict) return `the table ${b.strict ? 'becomes' : 'stops being'} STRICT`;
	if (a.withoutRowid !== b.withoutRowid) {
		return `the table ${b.withoutRowid ? 'becomes' : 'stops being'} WITHOUT ROWID`;
	}
	return undefined;
};

/**
 * Why a table with *any* dependent cannot be rebuilt on D1.
 *
 * The rebuild drops the old table and renames the new one into its place, and
 * `DROP TABLE` runs an implicit `DELETE FROM` first. What that does to a child
 * depends on its referential action, and both outcomes are wrong:
 *
 * - `ON DELETE CASCADE` (or `SET NULL`/`SET DEFAULT`): the action *fires*.
 *   The batch succeeds and the child table is silently emptied. Cloudflare
 *   documents that `PRAGMA defer_foreign_keys` "does not prevent ON DELETE
 *   CASCADE actions from being executed" — deferring holds back checks, not
 *   actions.
 * - `NO ACTION` (the default): the implicit delete increments the deferred
 *   violation counter once per child row. The rename restores the schema but
 *   never decrements it, so the commit fails with `FOREIGN KEY constraint
 *   failed` — and only when the child holds rows, which is why an empty
 *   fixture never caught it.
 *
 * SQLite's own 12-step recipe avoids all of this by turning `foreign_keys`
 * off, which D1 will not allow: every query runs in an implicit transaction,
 * and that pragma cannot be changed inside one. So there is no way to make it
 * safe, and refusing is the honest move. It is a real restriction — a table
 * with children cannot have a column's type changed — but it is D1's.
 *
 * @param tables the *post-migration* tables. A child this migration drops, or
 * one whose foreign key this migration removes, is not a dependent by the time
 * the rebuild runs — reading the before side refused migrations that apply
 * cleanly, including the very fix the error message recommends.
 */
const dependentTables = (
	tables: Record<string, TableSnapshot>,
	target: string,
): string[] => {
	const found: string[] = [];

	for (const table of Object.values(tables)) {
		const keys = [
			...Object.values(table.foreignKeys),
			...Object.values(table.columns).map((c) => c.references).filter((r) => r !== undefined),
		];
		for (const key of keys) {
			if (key.tableTo !== target) continue;
			const action = (key.onDelete ?? 'no action').toLowerCase();
			// A self-reference is included: the same implicit delete applies.
			found.push(`"${table.name}"."${key.columns[0] ?? '?'}" (on delete ${action})`);
		}
	}

	return found;
};

/**
 * Carry a `before` column's stated `collate` onto the matching `after`
 * column wherever `after` does not state one — the schema DSL has no
 * `.collate()` spelling (`docs/04`), so an `after` column can never state a
 * collation on its own; without this, any recreation of the schema-derived
 * snapshot loses the live collation the moment nothing else about the
 * column changes it. Returns `afterColumns` unchanged (same reference) when
 * there is nothing to carry, so callers can cheaply detect "no-op".
 */
const carryForwardCollation = (
	beforeColumns: Record<string, ColumnSnapshot>,
	afterColumns: Record<string, ColumnSnapshot>,
	columnRenames: Record<string, string>,
): Record<string, ColumnSnapshot> => {
	let result = afterColumns;
	for (const [beforeName, beforeColumn] of Object.entries(beforeColumns)) {
		if (!beforeColumn.collate) continue;
		const target = columnRenames[beforeName] ?? beforeName;
		const afterColumn = result[target];
		// `[F-115]`: an explicit statement — including an explicit "none" via the
		// `tableOptions()` sidecar's `collate` map — ends the carry-forward for
		// this column. Without this check a deliberately-removed collation could
		// never leave `meta/`: the very next `generate` would just re-carry it.
		if (afterColumn && !afterColumn.collate && !afterColumn.collateStated) {
			if (result === afterColumns) result = { ...afterColumns };
			result[target] = { ...afterColumn, collate: beforeColumn.collate };
		}
	}
	return result;
};

/**
 * Carry a `before` unique constraint member's stated `collate` onto the
 * matching `after` member wherever `after` does not state one — the same
 * exemption `sameUniques` applies when *comparing* the two (a schema-derived
 * `after` cannot author a member `collate` at all, see `docs/04`), but doing
 * that comparison alone is not enough: a rebuild forced for an unrelated
 * reason (say, an added column) still renders `after`'s constraint as-is,
 * which has no `collate` on it, silently dropping the live one. Matched by
 * member name (post-rename), the same way `carryForwardCollation` matches
 * columns — a unique constraint's *name* is not comparable (introspection
 * invents one), so its member list is the only stable identity.
 *
 * `used` tracks which `after` entries have already absorbed a `before`'s
 * collations, the same discipline `matchUniqueClause` (`introspect.ts`)
 * applies when it matches a parsed clause to an automatic index — without it,
 * two distinct `before` constraints that happen to share the same ordered
 * column list (e.g. two single-member `unique(a)` clauses, or `unique(a,b)`
 * declared twice with different per-member collations) both matched the
 * *first* `after` entry with that column list: the second `before`'s
 * collations were deposited on top of the first's, fabricating a merged
 * constraint neither live table actually had, and the `after` entry that
 * should have received the second `before`'s own collation was left
 * untouched instead.
 */
const carryForwardUniqueCollation = (
	beforeConstraints: TableSnapshot['uniqueConstraints'],
	afterConstraints: TableSnapshot['uniqueConstraints'],
	columnRenames: Record<string, string>,
): TableSnapshot['uniqueConstraints'] => {
	let result = afterConstraints;
	const used = new Set<string>();
	for (const before of Object.values(beforeConstraints)) {
		const beforeMembers = before.columns.map(normalizeUniqueColumn);
		if (!beforeMembers.some((m) => m.collate)) continue;
		const renamedNames = beforeMembers.map((m) => columnRenames[m.name] ?? m.name);

		for (const [key, after] of Object.entries(result)) {
			if (used.has(key)) continue;
			const afterMembers = after.columns.map(normalizeUniqueColumn);
			if (afterMembers.length !== renamedNames.length) continue;
			if (!afterMembers.every((m, i) => m.name === renamedNames[i])) continue;

			used.add(key);
			const merged = afterMembers.map((m, i) => {
				const carried = beforeMembers[i]?.collate;
				return carried && !m.collate ? { name: m.name, collate: carried } : m;
			});
			if (merged.some((m, i) => m !== afterMembers[i])) {
				if (result === afterConstraints) result = { ...afterConstraints };
				result[key] = { ...after, columns: merged };
			}
			break;
		}
	}
	return result;
};

/**
 * Same carry-forward as `carryForwardUniqueCollation`, for a composite
 * primary key member's own `collate` — the schema DSL cannot state one on a
 * `primaryKey({ columns: [...] })` member any more than it can on a
 * `unique()` member (`docs/04`), so an `after.compositePrimaryKeys` entry can
 * never carry a member `collate` on its own, and without this an unrelated
 * rebuild silently replaces the live PK's collation (worst case: with a
 * *different* collation inherited from the column's own definition, not just
 * dropped — see the `[a b] text collate rtrim` / `primary key ("a""b", "a b"
 * collate NOCASE desc)` case the reviewer flagged).
 *
 * A table has at most one primary key, so there is nothing to disambiguate
 * across multiple `before`/`after` candidates the way `matchUniqueClause`
 * (`introspect.ts`) or `carryForwardUniqueCollation`'s own `used` set does —
 * but the same member-list match (rather than trusting the entry's key,
 * which introspection invents) keeps this sound if that ever changes.
 */
const carryForwardPrimaryKeyCollation = (
	beforePk: TableSnapshot['compositePrimaryKeys'],
	afterPk: TableSnapshot['compositePrimaryKeys'],
	columnRenames: Record<string, string>,
): TableSnapshot['compositePrimaryKeys'] => {
	let result = afterPk;
	const used = new Set<string>();
	for (const before of Object.values(beforePk)) {
		const beforeMembers = before.columns.map(normalizeUniqueColumn);
		if (!beforeMembers.some((m) => m.collate)) continue;
		const renamedNames = beforeMembers.map((m) => columnRenames[m.name] ?? m.name);

		for (const [key, after] of Object.entries(result)) {
			if (used.has(key)) continue;
			const afterMembers = after.columns.map(normalizeUniqueColumn);
			if (afterMembers.length !== renamedNames.length) continue;
			if (!afterMembers.every((m, i) => m.name === renamedNames[i])) continue;

			used.add(key);
			const merged = afterMembers.map((m, i) => {
				const carried = beforeMembers[i]?.collate;
				return carried && !m.collate ? { name: m.name, collate: carried } : m;
			});
			if (merged.some((m, i) => m !== afterMembers[i])) {
				if (result === afterPk) result = { ...afterPk };
				result[key] = { ...after, columns: merged };
			}
			break;
		}
	}
	return result;
};

/**
 * [F-107]: `recreateTable` carries a live `collate` into the *rebuilt table
 * body* it renders, but `generate` persists the schema-derived `after`
 * snapshot as-is as the new baseline (`meta/<n>_snapshot.json`) — which
 * structurally has no `collate` on any column, regardless of whether this
 * diff even touched the table. The very next `generate`, seeing that
 * baseline, believes the column was always BINARY and silently drops the
 * live collation with zero drift reported. Apply the same carry-forward to
 * the whole snapshot the caller is about to persist, not just to tables a
 * recreate happens to rebuild.
 *
 * [F-115]: the same loss applies to a unique constraint member's own
 * `collate` (`[F-111]`) — `carryForwardUniqueCollation` above only ran
 * inside `recreateTable`'s rendered rebuild, never against the snapshot
 * `generate` persists as its new baseline. The first `generate` after a pull
 * still has the live member collation available in `before` (the persisted
 * baseline predates this fix), so it happened to round-trip once by luck;
 * the *second* `generate` reads a baseline that never recorded it and
 * silently re-renders the constraint without it — zero statements, zero
 * errors, a real downgrade of the constraint's semantics.
 */
export const carryForwardCollations = (before: Snapshot, after: Snapshot, options: DiffOptions = {}): Snapshot => {
	const renamedTables = options.renamedTables ?? {};
	const renamedColumns = options.renamedColumns ?? {};
	let tables = after.tables;

	for (const [beforeName, beforeTable] of Object.entries(before.tables)) {
		const targetName = renamedTables[beforeName] ?? beforeName;
		const afterTable = tables[targetName];
		if (!afterTable) continue;

		const columnRenames: Record<string, string> = {};
		for (const [key, value] of Object.entries(renamedColumns)) {
			const [table, column] = key.split('.');
			if (table === targetName && column) columnRenames[column] = value;
		}

		let nextAfterTable = afterTable;

		const columns = carryForwardCollation(beforeTable.columns, nextAfterTable.columns, columnRenames);
		if (columns !== nextAfterTable.columns) nextAfterTable = { ...nextAfterTable, columns };

		const uniqueConstraints = carryForwardUniqueCollation(
			beforeTable.uniqueConstraints,
			nextAfterTable.uniqueConstraints,
			columnRenames,
		);
		if (uniqueConstraints !== nextAfterTable.uniqueConstraints) {
			nextAfterTable = { ...nextAfterTable, uniqueConstraints };
		}

		const compositePrimaryKeys = carryForwardPrimaryKeyCollation(
			beforeTable.compositePrimaryKeys,
			nextAfterTable.compositePrimaryKeys,
			columnRenames,
		);
		if (compositePrimaryKeys !== nextAfterTable.compositePrimaryKeys) {
			nextAfterTable = { ...nextAfterTable, compositePrimaryKeys };
		}

		if (nextAfterTable !== afterTable) {
			if (tables === after.tables) tables = { ...after.tables };
			tables[targetName] = nextAfterTable;
		}
	}

	return tables === after.tables ? after : { ...after, tables };
};

/**
 * Whether creating a trigger named `guardName` would collide with a live
 * foreign trigger `options.foreignTriggers` knows about — but only counting a
 * collider that actually **survives this diff**. `options.foreignTriggers` is
 * a pre-diff snapshot (populated by `introspect()` before any of this diff's
 * own statements exist), so a naive scan over it refuses migrations that are
 * themselves the fix: dropping the table the collider lives on, in the same
 * diff, removes the collider before the create ever runs.
 *
 * @param droppedTables Tables this diff drops outright (`diffSnapshots`'s
 * `dropped`). A collider on one of these only stops colliding once its
 * `drop table` statement has actually been emitted into `statementsSoFar` —
 * membership in this list alone does not mean the drop has run yet at the
 * call site currently checking (see the emission-order check below).
 * @param statementsSoFar Everything this diff has decided to emit before the
 * check point. A `drop trigger if exists "<name>"` in here (from `dropped
 * AppendOnlyTrigger`, via a rename or an in-place `appendOnly` transition
 * elsewhere in this same diff) also removes a collider under that literal
 * name, independent of which table it lived on.
 */
const tableGuardCollides = (
	guardName: string,
	foreignTriggers: Record<string, readonly string[]> | undefined,
	droppedTables: readonly string[],
	statementsSoFar: readonly Statement[],
): boolean => {
	if (!foreignTriggers) return false;
	const lowerGuard = foldAsciiCase(guardName);

	const droppedTriggerNames = new Set(
		statementsSoFar
			.map((s) => /^drop\s+trigger\s+(?:if\s+exists\s+)?"((?:[^"]|"")+)"/i.exec(s.sql)?.[1])
			.filter((n): n is string => n !== undefined)
			.map((n) => foldAsciiCase(n.replaceAll('""', '"'))),
	);
	if (droppedTriggerNames.has(lowerGuard)) return false;

	// `droppedTables` is *membership* — every table this diff will eventually
	// drop — not *order*. `diffSnapshots` emits created tables (step 2, this
	// function's caller for a brand-new append-only table) before dropped
	// tables (step 3): at that call site none of `droppedTables`' `drop table`
	// statements have been emitted yet, so exempting on membership alone waves
	// through a `create trigger` that collides with a live trigger which is
	// still there when the create actually runs. Requiring the `drop table`
	// to already be *in* `statementsSoFar` — the same emission-order test
	// `droppedTriggerNames` above already applies to a dropped trigger — makes
	// the exemption sound at every call site: it is false at step 2 (nothing
	// dropped yet) and true from step 4 onward (step 3 already ran). The
	// in-place-rebuild call site's own premise (recreateTable drops the very
	// table it is rebuilding before creating its own guard) never depended on
	// `droppedTables` at all — that table is excluded via `foreignTriggers`
	// instead, checked separately in `recreateTable`. [Finding 2]
	const droppedTablesLower = new Set(droppedTables.map((t) => foldAsciiCase(t)));
	const alreadyDroppedLower = new Set(
		statementsSoFar
			.map((s) => /^drop\s+table\s+"((?:[^"]|"")+)"/i.exec(s.sql)?.[1])
			.filter((n): n is string => n !== undefined)
			.map((n) => foldAsciiCase(n.replaceAll('""', '"')))
			.filter((n) => droppedTablesLower.has(n)),
	);

	return Object.entries(foreignTriggers).some(([table, triggers]) => {
		if (alreadyDroppedLower.has(foldAsciiCase(table))) return false;
		return triggers.some((t) => foldAsciiCase(t) === lowerGuard);
	});
};

const recreateTable = (
	before: TableSnapshot,
	after: TableSnapshot,
	columnRenames: Record<string, string>,
	reason: string,
	dependents: Record<string, TableSnapshot> = {},
	foreignTriggers: readonly string[] = [],
	/**
	 * Whether `after` is schema-derived — the same reading `columnDifference`
	 * (`snapshot.ts`) already committed to when it exempted an unstated
	 * `after.collate` as "not expressible", not "changed to binary". A rebuild
	 * that renders `after` as-is would then quietly drop a live collation the
	 * guard just asserted was unchanged — the column becomes BINARY the moment
	 * anything else about the table forces a recreate. So when `after` cannot
	 * state a collation at all, a `before` column's stated collation is carried
	 * into the rebuilt table rather than dropped.
	 */
	afterIsSchemaDerived = true,
	/**
	 * Whether re-creating `after`'s append-only guard (if `after.appendOnly`)
	 * would collide with a live foreign trigger sharing its name — precomputed
	 * by the caller with `tableGuardCollides`, which is the only place that
	 * has the full-diff context (every table's foreign triggers, every table
	 * this diff drops) this function does not.
	 */
	guardCollides = false,
): { statements: Statement[]; errors: string[] } => {
	const errors: string[] = [];

	const referencing = dependentTables(dependents, before.name);
	if (referencing.length > 0) {
		errors.push(
			`"${before.name}" has to be recreated because ${reason}, but ${referencing.join(', ')} references `
				+ 'it. Rebuilding drops the table, and D1 cannot disable foreign keys inside a migration: with '
				+ 'a referential action the drop empties the child, and without one the deferred check fails '
				+ 'the whole batch as soon as the child holds any rows. Drop the foreign key, or migrate the '
				+ 'child table in the same migration, or move the data by hand.',
		);
		// No statements alongside the refusal: `generate` will not write them,
		// and emitting SQL that cannot run next to an error saying so is worse
		// than emitting nothing.
		return { statements: [], errors };
	}

	// Same shape as the dependents refusal above: `DROP TABLE` takes every
	// trigger on it with it, and the rebuild only knows how to re-create the
	// one trigger it authors itself (the append-only guard, handled below).
	// Any other trigger found on the live table would simply vanish — no
	// error, no re-creation, just UPDATE (or whatever it guarded) quietly
	// starting to behave differently the moment this migration runs.
	if (foreignTriggers.length > 0) {
		errors.push(
			`"${before.name}" has to be recreated because ${reason}, but it carries trigger(s) `
				+ `${foreignTriggers.map((t) => `"${t}"`).join(', ')} that orm-d1 did not create. Rebuilding drops `
				+ 'the table, which drops those triggers with it, and there is no way to reproduce a trigger '
				+ 'orm-d1 does not know the definition of. Drop the trigger, recreate it by hand after this '
				+ 'migration runs, or bring it into the schema so orm-d1 can carry it across rebuilds.',
		);
		return { statements: [], errors };
	}
	const temporary = `__new_${after.name}`;

	// Explicit, intersected column list — never `SELECT *`.
	//
	// Generated columns are excluded: SQLite computes them, and naming one in
	// the INSERT is an error ("cannot INSERT into generated column"). Since the
	// migration is a single atomic batch, that failure rolled the whole thing
	// back — a generated file that could never apply, the first time the table
	// changed for any reason at all.
	const carried: { from: string; to: string }[] = [];
	for (const name of Object.keys(before.columns)) {
		const target = columnRenames[name] ?? name;
		const column = after.columns[target];
		if (column && !column.generated) carried.push({ from: name, to: target });
	}

	for (const [name, column] of Object.entries(after.columns)) {
		// A generated column is never carried, but it is not new either — it is
		// computed for every row the INSERT writes.
		const isNew = !column.generated && !carried.some((c) => c.to === name);
		if (isNew && column.notNull && column.default === undefined) {
			errors.push(
				`"${after.name}"."${name}" is NOT NULL with no default and did not exist before: `
					+ 'existing rows cannot be backfilled. Give it a default, or make it nullable.',
			);
		}
	}

	// Carry a `before` column's stated collation into the rebuild when `after`
	// does not state one and structurally cannot (schema-derived) — otherwise
	// the rebuild silently makes the column BINARY (see the parameter doc
	// above and `columnDifference` in `snapshot.ts`).
	const rebuiltColumns = afterIsSchemaDerived
		? carryForwardCollation(before.columns, after.columns, columnRenames)
		: after.columns;

	// Same carry-forward, for a unique constraint member's own `collate`
	// (`[F-111]`) — see `carryForwardUniqueCollation`.
	const rebuiltUniqueConstraints = afterIsSchemaDerived
		? carryForwardUniqueCollation(before.uniqueConstraints, after.uniqueConstraints, columnRenames)
		: after.uniqueConstraints;

	// Same carry-forward, for a composite primary key member's own `collate`.
	const rebuiltPrimaryKeys = afterIsSchemaDerived
		? carryForwardPrimaryKeyCollation(before.compositePrimaryKeys, after.compositePrimaryKeys, columnRenames)
		: after.compositePrimaryKeys;

	const body = createTableFromSnapshot({
		...after,
		name: temporary,
		columns: rebuiltColumns,
		uniqueConstraints: rebuiltUniqueConstraints,
		compositePrimaryKeys: rebuiltPrimaryKeys,
	});
	const statements: Statement[] = [
		// Not `foreign_keys = OFF`: D1 runs every query in an implicit
		// transaction and refuses to change that pragma inside one, so the old
		// bookends were inert even before the applier filtered them out.
		// `defer_foreign_keys` is the supported equivalent — it holds the checks
		// until the batch commits, by which point the rename has restored every
		// reference — and it is deliberately left in the applied statements.
		{ sql: 'PRAGMA defer_foreign_keys = ON', destructive: false },
		{ sql: body, destructive: false, reason },
		{
			sql: `insert into ${quote(temporary)} (${carried.map((c) => quote(c.to)).join(', ')}) select ${
				carried.map((c) => quote(c.from)).join(', ')
			} from ${quote(before.name)}`,
			destructive: false,
		},
		{
			sql: `drop table ${quote(before.name)}`,
			destructive: true,
			reason: `recreating "${after.name}" because ${reason}`,
		},
		{ sql: `alter table ${quote(temporary)} rename to ${quote(after.name)}`, destructive: false },
	];

	// Indexes are dropped along with the table, so every one is recreated.
	for (const index of Object.values(after.indexes)) {
		statements.push({ sql: createIndexFromSnapshot(index, after.name), destructive: false });
	}

	// So is the append-only trigger. Leaving it out silently unprotected an
	// append-only table the first time it was rebuilt for any other reason —
	// the failure mode being that nothing fails, and UPDATEs start working.
	if (after.appendOnly && guardCollides) {
		// Matches the in-place transition's refusal below (same name pattern,
		// same reasoning): creating the guard here would fail on apply because
		// a live foreign trigger already has this exact name, and this rebuild's
		// own drop of "before.name" does not remove it — `guardCollides` is
		// already survivor-aware and only true when the collider outlives this
		// diff.
		errors.push(
			`"${after.name}" is becoming append-only, but a trigger named "${appendOnlyTriggerName(after.name)}" `
				+ 'already exists and orm-d1 did not create it. Creating the guard would fail on apply because the '
				+ 'name is taken. Drop or rename that trigger, or bring it into the schema so orm-d1 can carry it '
				+ 'across rebuilds.',
		);
		// Same contract as the two refusals above (`return { statements: [],
		// errors }`): this used to fall through and return the `statements`
		// array already built above — the full destructive rebuild (create
		// "__new_X", the data copy, `drop table`, the rename) — alongside the
		// error, so a rebuild refused for a guard collision still shipped
		// unapplyable SQL. `check`/`push`/`generate` all trust "an error means
		// no statements"; this branch was the one place that trust was wrong.
		// [Finding 6]
		return { statements: [], errors };
	} else if (after.appendOnly) {
		statements.push({
			sql: appendOnlyTrigger(after.name, appendOnlyColumns(after.appendOnly)),
			destructive: false,
		});
	}

	// No closing pragma: it is scoped to this transaction and, per D1's docs,
	// turning it back off at the end is implicit.
	return { statements, errors };
};

/** Diff two snapshots into the statements that turn `before` into `after`. */
export function diffSnapshots(before: Snapshot, after: Snapshot, options: DiffOptions = {}): DiffResult {
	const statements: Statement[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];

	// Declared constraint names only survive in a schema-derived snapshot, so
	// they are only worth comparing when both sides are one.
	const comparableNames = before.origin === 'schema' && after.origin === 'schema';

	const renamedTables = options.renamedTables ?? {};
	const renamedColumns = options.renamedColumns ?? {};

	// Reverse of `renamedTables`: post-rename name -> live (pre-rename) name.
	// `options.foreignTriggers` is populated by `introspect()` keyed by the
	// live `tbl_name`, before any rename in this diff is applied, so a lookup
	// keyed by the post-rename identity misses it entirely.
	const liveTableNames: Record<string, string> = {};
	for (const [before, after] of Object.entries(renamedTables)) liveTableNames[after] = before;

	const beforeNames = Object.keys(before.tables);
	const afterNames = Object.keys(after.tables);

	// 1. Renamed tables first, so later steps see matching names.
	const effectiveBefore: Record<string, TableSnapshot> = {};
	for (const name of beforeNames) {
		const renamed = renamedTables[name];
		const t = before.tables[name]!;
		if (renamed) {
			statements.push({ sql: `alter table ${quote(name)} rename to ${quote(renamed)}`, destructive: false });
			// SQLite keeps a trigger's *name* across RENAME and only repoints its
			// `tbl_name`, so an append-only table drags `<old>_no_update` along.
			// Everything downstream is keyed on the new name, so it would emit
			// `drop trigger "<new>_no_update"` — a no-op leaving UPDATE blocked
			// on a table the schema says is writable, and drift that no
			// generated migration can ever clear. Drop it under the name it
			// actually has, and let the guard be re-created below if it is still
			// wanted (that is what clearing `appendOnly` here arranges).
			if (t.appendOnly) {
				// Re-creating the guard under the new name happens right here, in
				// the same three-statement run as the rename and the drop — not
				// deferred to the later per-table pass, which used to push the
				// `create trigger` far away in the statement list (after every
				// other renamed table's own rename+drop, then every created
				// table's statements). `statementGroups` (`sql.ts`) only recognises
				// the rebuild's `create table "__new_X" … rename … create index`
				// shape as an indivisible run; three statements scattered like that
				// are three ordinary singleton groups a batch boundary can land
				// between. A boundary between the drop and a *distant* re-create
				// left the table genuinely unprotected — UPDATE permitted — for
				// however long batch 2 took to run, and unprotected for good if
				// batch 2 then failed. Keeping the three statements adjacent lets
				// `statementGroups` (extended below) treat them as one unit, the
				// same way it already does for a rebuild's rename-then-restore.
				const staysAppendOnly = Boolean(after.tables[renamed]?.appendOnly);
				statements.push({
					sql: dropAppendOnlyTrigger(name),
					destructive: !staysAppendOnly,
					...(staysAppendOnly ? {} : {
						reason: `"${renamed}" is no longer append-only, so UPDATE is permitted again`,
					}),
				});
				if (staysAppendOnly) {
					statements.push({
						sql: appendOnlyTrigger(renamed, appendOnlyColumns(after.tables[renamed]!.appendOnly)),
						destructive: false,
					});
				}
			}
			// `appendOnly` on the effective (post-rename) entry is set to match
			// `after` already when the guard was just re-created above, so the
			// later per-table pass sees no further change to make for it — it
			// would otherwise treat the freshly-created trigger's presence as
			// drift it still needs to reconcile.
			const carriedAppendOnly = t.appendOnly && after.tables[renamed]?.appendOnly
				? after.tables[renamed]!.appendOnly
				: false;
			effectiveBefore[renamed] = { ...t, name: renamed, appendOnly: carriedAppendOnly };
		} else {
			effectiveBefore[name] = t;
		}
	}

	// 1b. SQLite's `ALTER TABLE … RENAME TO` rewrites every `REFERENCES` clause
	// naming the renamed table (since SQLite 3.25), including a table's own
	// self-references. `effectiveBefore` above only renamed the table's own
	// entry, leaving every *other* table's `ForeignKeySnapshot.tableTo` /
	// `ColumnSnapshot.references.tableTo` pointing at the old name — which
	// makes an otherwise-pure rename look like "a foreign key changes" and
	// forces a destructive rebuild (or an unresolvable refusal for a
	// self-reference) for a schema that the rename alone already satisfies.
	// Repoint them here, across all tables in `effectiveBefore` (the renamed
	// table included), before anything downstream compares foreign keys.
	if (Object.keys(renamedTables).length > 0) {
		const repoint = (tableTo: string): string => renamedTables[tableTo] ?? tableTo;
		for (const name of Object.keys(effectiveBefore)) {
			const t = effectiveBefore[name]!;
			let changed = false;
			const columns: Record<string, ColumnSnapshot> = { ...t.columns };
			for (const [colName, col] of Object.entries(columns)) {
				if (col.references && renamedTables[col.references.tableTo]) {
					columns[colName] = { ...col, references: { ...col.references, tableTo: repoint(col.references.tableTo) } };
					changed = true;
				}
			}
			const foreignKeys: Record<string, ForeignKeySnapshot> = { ...t.foreignKeys };
			for (const [fkName, fk] of Object.entries(foreignKeys)) {
				if (renamedTables[fk.tableTo]) {
					foreignKeys[fkName] = { ...fk, tableTo: repoint(fk.tableTo) };
					changed = true;
				}
			}
			if (changed) effectiveBefore[name] = { ...t, columns, foreignKeys };
		}
	}

	// Dropped tables, computed early (rather than inline in step 3 below, where
	// this used to live) because the guard-collision check in step 2 also
	// needs it: `options.foreignTriggers` is a pre-diff snapshot, so a trigger
	// living on a table *this diff drops* is not a real collision (see
	// `tableGuardCollides`), and step 2 runs before step 3 emits the actual
	// `drop table` statements.
	// A `__new_<table>` leftover from a rebuild that failed to `batch()`
	// atomically (a split migration hitting D1's cross-batch atomicity gap) is
	// never auto-dropped here, even though it looks exactly like an ordinary
	// removed table from this side of the diff. It is very likely the *only*
	// surviving copy of the rebuilt data — the old table is already gone by
	// the time this state is reached — so treating it as ordinary drift and
	// emitting `drop table "__new_<table>"` would destroy the one thing left
	// to recover from. `isInternalTable` is deliberately not widened to cover
	// this: that would also hide a real table someone genuinely named
	// `__new_orders` from `pull`, which is a different, much rarer table.
	const dropped = Object.keys(effectiveBefore).filter((name) => !after.tables[name] && !name.startsWith('__new_'));
	const survivors = Object.fromEntries(
		Object.entries(effectiveBefore).filter(([name]) => !dropped.includes(name)),
	);

	// 2. Created tables, referenced tables first so foreign keys resolve.
	for (const name of orderByDependency(after, afterNames)) {
		if (effectiveBefore[name]) continue;
		const t = after.tables[name]!;
		statements.push({ sql: createTableFromSnapshot(t), destructive: false });
		for (const index of Object.values(t.indexes)) {
			statements.push({ sql: createIndexFromSnapshot(index, name), destructive: false });
		}
		if (t.appendOnly) {
			const guardName = appendOnlyTriggerName(name);
			if (tableGuardCollides(guardName, options.foreignTriggers, dropped, statements)) {
				errors.push(
					`"${name}" is being created append-only, but a trigger named "${guardName}" already exists and `
						+ 'orm-d1 did not create it. Creating the guard would fail on apply because the name is '
						+ 'taken. Drop or rename that trigger, or bring it into the schema so orm-d1 can carry it '
						+ 'across rebuilds.',
				);
			} else {
				statements.push({
					sql: appendOnlyTrigger(name, appendOnlyColumns(t.appendOnly)),
					destructive: false,
				});
			}
		}
	}

	// 3. Dropped tables, children before parents — the reverse of creation
	// order. Dropping a parent first leaves the child's foreign key pointing at
	// a table that no longer exists, which D1 enforces (it cannot be turned off
	// inside a migration) and which fails the whole batch.

	// The `__new_` tables excluded from `dropped` above are silently left
	// alone for the reason stated there — but silent is only safe for the
	// destructive half (never drop the one surviving copy of the rebuilt
	// rows). The leftover itself is a real defect: it does not show up as
	// drift (this diff naturally has nothing to say about a table on the
	// `before` side it is deliberately ignoring), so `check` reports clean
	// with the orphan still sitting there, and the next rebuild of the table
	// it belongs to fails on `create table "__new_<table>" already exists`
	// with nothing in any command's output explaining why. Naming it here, as
	// a warning rather than an error, keeps this diff's own statements
	// unblocked (nothing about applying *this* diff is unsafe) while telling
	// the operator what to do before the next rebuild finds it.
	for (const name of Object.keys(effectiveBefore)) {
		if (!name.startsWith('__new_') || after.tables[name]) continue;
		const original = name.slice('__new_'.length);
		warnings.push(
			`"${name}" looks like a leftover table from an interrupted rebuild of "${original}" (a rebuild whose `
				+ 'temporary copy was committed but never renamed into place). It is left alone because it may be '
				+ `the only surviving copy of that table's rows. Drop it by hand once you've confirmed it isn't `
				+ `needed, or bring it into the schema under its own name — otherwise the next migration that `
				+ `rebuilds "${original}" will fail with \`table "${name}" already exists\`.`,
		);
	}

	for (const name of orderByDependency({ ...before, tables: effectiveBefore }, dropped).reverse()) {
		// Ordering only helps among the tables being dropped together. A table
		// that *survives* and still references this one keeps its foreign key
		// pointing at nothing, and D1 enforces that — the statement fails at
		// apply time and takes the whole atomic migration with it. Refusing
		// beats emitting a migration that cannot run.
		const referrers = referencingTables(survivors, name);
		if (referrers.length > 0) {
			errors.push(
				`"${name}" was removed from the schema, but ${referrers.map((r) => `"${r}"`).join(', ')} still `
					+ 'references it. Drop the foreign key (or those tables) in the same migration: D1 enforces '
					+ 'foreign keys and cannot be told not to, so the drop would fail on apply.',
			);
			continue;
		}

		statements.push({
			sql: `drop table ${quote(name)}`,
			destructive: true,
			reason: `table "${name}" was removed from the schema`,
		});
	}

	// 4. Altered tables, dependents before the tables they depend on: a child
	// being rebuilt to drop its foreign key has to lose it *before* the parent's
	// own rebuild drops the parent.
	//
	// Ordered by the **before** graph, because the edge that decides the order
	// is exactly the one this migration removes — in `after` it is already gone,
	// so `after` has no edges to sort by and the result is just declaration
	// order reversed. That happened to work when the parent was declared first
	// and failed otherwise. The before graph knows the child still references
	// the parent right now, which is what the ordering has to respect. A newly
	// *added* foreign key needs no consideration here: the child references the
	// parent in `after` too, so `dependentTables` refuses that rebuild outright.
	const beforeGraph: Snapshot = { ...before, tables: effectiveBefore };
	for (const name of orderByDependency(beforeGraph, afterNames).reverse()) {
		const previous = effectiveBefore[name];
		const next = after.tables[name]!;
		if (!previous) continue;

		const columnRenames: Record<string, string> = {};
		for (const [key, value] of Object.entries(renamedColumns)) {
			const [table, column] = key.split('.');
			if (table === name && column) columnRenames[column] = value;
		}

		// Constraint names are not comparable (SQLite discards them), so renaming
		// one is not drift and emits nothing. Say so, rather than leaving the
		// author to wonder why `generate` produced an empty migration.
		//
		// Only when both sides are schema-derived. `push` and `check` diff an
		// introspected snapshot against a schema-derived one, where the names
		// never match by construction — warning there would fire on every run
		// and report `sqlite_autoindex_users_1` as the old name.
		const renamedConstraints = comparableNames
			? constraintNames(previous).filter((n) => !constraintNames(next).includes(n))
			: [];
		if (
			renamedConstraints.length > 0
			&& requiresRecreate(previous, next, columnRenames, after.origin === 'schema') === undefined
		) {
			warnings.push(
				`"${name}": constraint ${renamedConstraints.map((n) => `"${n}"`).join(', ')} was renamed, which `
					+ 'needs no migration — SQLite does not store the declared name. The database keeps the old '
					+ 'name until the table is rebuilt for some other reason.',
			);
		}

		const added = Object.entries(next.columns).filter(([columnName]) =>
			!Object.keys(previous.columns).some((n) => (columnRenames[n] ?? n) === columnName)
		);

		/**
		 * Whether to rebuild is decided once, before anything is emitted.
		 *
		 * The recreate drops and re-creates the table, so every ALTER after it
		 * would target a table that no longer exists. Deciding inside the
		 * add-column loop meant a migration that both added an unaddable column
		 * and dropped another emitted the rebuild *and* then
		 * `alter table … drop column`, which fails with "no such column" and
		 * rolls back the whole batch — a generated file that could never apply.
		 *
		 * The same ordering rule is why the rename ALTERs below sit *after* this
		 * decision rather than before it. A rename emitted first renames the
		 * column out from under the rebuild, whose `INSERT … SELECT` still reads
		 * the old name — and D1 has double-quoted-string-literal fallback on, so
		 * the now-unresolvable `"old"` degrades to the *string* `'old'` instead
		 * of erroring. The migration reports success and every value in the
		 * renamed column is replaced by the old column's name. `recreateTable`
		 * carries renames itself (see `carried`), so the rebuild needs no help.
		 */
		const unaddable = added.map(([columnName, column]) => ({ columnName, blocker: isAddable(column) }))
			.find((c) => c.blocker);
		const afterIsSchemaDerived = after.origin === 'schema';
		const reason = requiresRecreate(previous, next, columnRenames, afterIsSchemaDerived)
			?? (unaddable && `column "${unaddable.columnName}" cannot be added in place: ${unaddable.blocker}`);

		if (reason) {
			const foreignTriggersForTable = lookupCaseInsensitive(options.foreignTriggers, liveTableNames[name] ?? name)
				?? [];
			const guardCollides = next.appendOnly
				? tableGuardCollides(appendOnlyTriggerName(next.name), options.foreignTriggers, dropped, statements)
				: false;
			const recreated = recreateTable(
				previous,
				next,
				columnRenames,
				reason,
				after.tables,
				foreignTriggersForTable,
				afterIsSchemaDerived,
				guardCollides,
			);
			statements.push(...recreated.statements);
			errors.push(...recreated.errors);

			// The rebuild's own statements only ever *add back* the append-only
			// guard (when `next.appendOnly`), because `recreateTable` has no
			// other reason to touch it. A table that drops the guard as part of
			// being rebuilt for some other reason therefore lost it silently —
			// nothing failed, UPDATE just started working again — with no
			// `reason` line naming that transition the way the in-place case
			// below does. `dropAppendOnlyTrigger` is `drop trigger if exists`,
			// so re-stating it here (the trigger is already gone with the old
			// table by this point) is inert; it exists only to carry the
			// destructive reason into `--accept-data-loss` prompts and logs.
			//
			// Only when the rebuild actually happened: `recreateTable`'s
			// contract is "no statements alongside a refusal" (the dependents
			// and foreign-trigger checks both return `{ statements: [], errors
			// }` deliberately, see the comment at their `return`), but this
			// block ran unconditionally after it, so a refused rebuild still
			// emitted a lone destructive `drop trigger` — `check` printing a
			// `Drift:` line for a table it was simultaneously reporting as
			// blocked. Skip it whenever the rebuild refused.
			if (recreated.errors.length === 0 && (previous.appendOnly ?? false) && !(next.appendOnly ?? false)) {
				statements.push({
					sql: dropAppendOnlyTrigger(name),
					destructive: true,
					reason: `"${name}" is no longer append-only, so UPDATE is permitted again`,
				});
			}
			continue;
		}

		// Only reached when the table survives in place; a rebuild carries the
		// rename itself. Must precede the index and column ALTERs below, which
		// are expressed against the new names.
		for (const [from, to] of Object.entries(columnRenames)) {
			if (!previous.columns[from] || !next.columns[to]) continue;
			statements.push({
				sql: `alter table ${quote(name)} rename column ${quote(from)} to ${quote(to)}`,
				destructive: false,
			});
		}

		// An index that mentions a column being dropped has to go *first*:
		// SQLite validates every surviving index against the new shape as part
		// of DROP COLUMN, so the reverse order fails with "error in index …
		// after drop column". Creates stay after, where their columns exist.
		const { drops: indexDrops, creates: indexCreates } = diffIndexes(previous, next, name);
		statements.push(...indexDrops);

		// Added columns.
		for (const [, column] of added) {
			statements.push({
				sql: `alter table ${quote(name)} add column ${columnDefinition(column)}`,
				destructive: false,
			});
		}

		// Dropped columns.
		for (const columnName of Object.keys(previous.columns)) {
			const target = columnRenames[columnName] ?? columnName;
			if (next.columns[target]) continue;
			statements.push({
				sql: `alter table ${quote(name)} drop column ${quote(columnName)}`,
				destructive: true,
				reason: `column "${name}"."${columnName}" was removed from the schema`,
			});
		}

		statements.push(...indexCreates);

		// The append-only guard, for a table that survives in place. A trigger is
		// its own object, so unlike STRICT / WITHOUT ROWID this needs no rebuild —
		// and dropping it is destructive only in the sense that it removes a
		// protection, which is worth saying out loud rather than doing quietly.
		const previousGuard = appendOnlyKey(previous.appendOnly);
		const nextGuard = appendOnlyKey(next.appendOnly);
		if (previousGuard !== nextGuard) {
			// A guard that is only being *narrowed* still has to be dropped first:
			// the trigger's name is derived from the table, so `create trigger`
			// would fail on apply with "already exists".
			if (previousGuard && nextGuard) {
				const lost = guardedColumnsLost(previousGuard, nextGuard, Object.keys(next.columns));
				statements.push({
					sql: dropAppendOnlyTrigger(name),
					destructive: lost.length > 0,
					...(lost.length > 0
						? { reason: `"${name}"'s append-only guard no longer covers ${lost.join(', ')}` }
						: {}),
				});
			}
			if (next.appendOnly) {
				// The trigger this would create is named `<table>_no_update`
				// (`appendOnlyTrigger`). If that name is already taken by a trigger
				// the live database has but orm-d1 did not author — the anchoring
				// above is exactly what makes that distinction reliable now — `create
				// trigger` fails on apply with "already exists", and prepending
				// `drop trigger if exists` would silently destroy whatever that
				// foreign trigger does, which is the bug class this guard exists to
				// prevent. Refuse instead, matching the rebuild-path foreign-trigger
				// refusal above.
				const guardName = appendOnlyTriggerName(name);
				// SQLite trigger names are database-global and case-insensitive
				// (verified: a trigger on one table collides with the same name
				// aimed at another), not scoped to the table gaining the guard —
				// so the collision check has to look across every live trigger
				// `options.foreignTriggers` knows about, not just the ones already
				// keyed under this table's own (possibly renamed) live name.
				//
				// But `options.foreignTriggers` is a *pre-diff* snapshot — read by
				// `introspect()` before any statement in this diff has run — so a
				// naive scan over it also flags a collider this very diff is about
				// to remove: dropping the table it lives on (or dropping the
				// trigger itself, e.g. via a rename elsewhere in this diff) takes
				// it out before `create trigger` ever runs. `tableGuardCollides`
				// only counts a collider that survives this diff.
				const collides = tableGuardCollides(guardName, options.foreignTriggers, dropped, statements);
				if (!previousGuard && collides) {
					errors.push(
						`"${name}" is becoming append-only, but a trigger named "${guardName}" already exists and `
							+ 'orm-d1 did not create it. Creating the guard would fail on apply because the name is '
							+ 'taken. Drop or rename that trigger, or bring it into the schema so orm-d1 can carry it '
							+ 'across rebuilds.',
					);
				} else {
					statements.push({
						sql: appendOnlyTrigger(name, appendOnlyColumns(next.appendOnly)),
						destructive: false,
					});
				}
			} else {
				statements.push({
					sql: dropAppendOnlyTrigger(name),
					destructive: true,
					reason: `"${name}" is no longer append-only, so UPDATE is permitted again`,
				});
			}
		}
	}

	return { statements, errors, warnings };
}

/**
 * Topologically order tables so a foreign key's target is created first.
 * SQLite tolerates forward references, but a readable migration should not
 * rely on that — and other tools reading these files may not.
 */
export function orderByDependency(snapshot: Snapshot, names: readonly string[]): string[] {
	const ordered: string[] = [];
	const visiting = new Set<string>();
	const done = new Set<string>();

	const visit = (name: string): void => {
		if (done.has(name) || visiting.has(name)) return;
		visiting.add(name);

		const t = snapshot.tables[name];
		for (const target of dependenciesOf(t)) {
			if (target !== name && names.includes(target)) visit(target);
		}

		visiting.delete(name);
		done.add(name);
		ordered.push(name);
	};

	for (const name of names) visit(name);
	return ordered;
}

/** Tables in `tables` holding a foreign key that points at `target`. */
const referencingTables = (tables: Record<string, TableSnapshot>, target: string): string[] =>
	Object.values(tables)
		.filter((t) => t.name !== target && dependenciesOf(t).includes(target))
		.map((t) => t.name);

/** Declared names of the constraints SQLite does not store. */
const constraintNames = (t: TableSnapshot): string[] => [
	...Object.values(t.uniqueConstraints).map((u) => u.name),
	...Object.values(t.foreignKeys).map((f) => f.name),
	...Object.values(t.checkConstraints).map((c) => c.name),
];

const dependenciesOf = (t: TableSnapshot | undefined): string[] => [
	...Object.values(t?.foreignKeys ?? {}).map((fk) => fk.tableTo),
	...Object.values(t?.columns ?? {}).flatMap((c) => (c.references ? [c.references.tableTo] : [])),
];

/**
 * Indexes compare on content, and the predicate compares on its normalised
 * text — SQLite stores a partial index's `where` as written and hands it back
 * with its own spacing, so a byte comparison reports drift on an index that
 * has not changed. Same rule `canonicalTable` applies to check constraints.
 */
/**
 * Whitespace-normalise an expression for comparison, without touching
 * whitespace inside a string literal (`'a b'` and `'a  b'` are different
 * strings). Collapsing runs to a single space, the way `where` below does,
 * is not enough on its own — `lower( "a" )` (hand-written) and `lower("a")`
 * (schema-generated) already have no *runs* of whitespace to collapse, only
 * single spaces touching the parens, which SQL treats as insignificant
 * everywhere outside a literal. So every non-literal space is dropped
 * entirely, and only literal segments (recovered the same way
 * `blankLiterals` finds them, but kept instead of blanked) survive verbatim.
 */
// Quoted identifiers — `"…"`, `` `…` ``, `[…]` — are protected the same way a
// `'…'` string literal is, not just blanked from consideration but kept
// verbatim: SQLite allows a space inside a quoted identifier (`"a b"` and
// `"ab"` are different columns), and dropping every non-literal space used to
// drop that one too, so `lower("a b")` and `lower("ab")` canonicalised to the
// same string and compared equal — a column-pointing index silently drifted
// to name whichever of the two columns happened to be typed on the schema
// side next, with no diff ever reported (`[F-030]`).
const canonicalizeExpression = (text: string): string =>
	text.replaceAll(
		/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|\s+/g,
		(match) => (/^\s+$/.test(match) ? '' : match),
	);

const canonicalIndex = (index: IndexSnapshot): string =>
	JSON.stringify([
		index.columns.map(normalizeIndexColumn).map((c) => [
			c.isExpression ? canonicalizeExpression(c.expression) : c.expression,
			c.isExpression,
			// A pre-upgrade snapshot has no `desc`/`collate` at all — normalised
			// here to the same "no modifier" value a freshly-introspected
			// unqualified column gets, or the two would diff as different when
			// they describe the identical index.
			c.desc ?? false,
			// D1 preserves a `COLLATE`'s original case verbatim in the DDL text,
			// so `collate NoCase` (from a live DB) and `NOCASE` (from the schema
			// side, via `.collate()`) name the same collation but compare
			// unequal unless folded to a common case first — same for the
			// `binary` guard, which D1 also preserves lowercase.
			c.collate && c.collate.toLowerCase() !== 'binary' ? c.collate.toLowerCase() : undefined,
		]),
		index.isUnique,
		(index.where ?? '').replaceAll(/\s+/g, ' ').trim(),
	]);

/** Returned split, because drops and creates bracket the column changes. */
const diffIndexes = (
	before: TableSnapshot,
	after: TableSnapshot,
	tableName: string,
): { drops: Statement[]; creates: Statement[] } => {
	const drops: Statement[] = [];
	const creates: Statement[] = [];

	for (const [name, index] of Object.entries(before.indexes)) {
		const next = after.indexes[name];
		if (!next || canonicalIndex(index) !== canonicalIndex(next)) {
			drops.push({ sql: `drop index ${quote(name)}`, destructive: false });
		}
	}
	for (const [name, index] of Object.entries(after.indexes)) {
		const previous = before.indexes[name];
		if (!previous || canonicalIndex(previous) !== canonicalIndex(index)) {
			creates.push({ sql: createIndexFromSnapshot(index, tableName), destructive: false });
		}
	}

	return { drops, creates };
};

export const isEmptyDiff = (result: DiffResult): boolean => result.statements.length === 0;

export const renderMigration = (result: DiffResult): string =>
	result.statements
		.map((statement) => (statement.reason ? `-- ${statement.reason}\n${statement.sql};` : `${statement.sql};`))
		.join('\n');
