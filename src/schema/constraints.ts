import type { SQLChunk } from '../sql/sql.js';
import type { Column, ReferentialAction } from './columns.js';

/**
 * Table-level constraints. These are inert metadata in the core bundle — only
 * `orm-d1/ddl` and the CLI ever read them.
 *
 * Each is a small immutable builder wrapping a `meta` record, so that chained
 * methods (`.where()`, `.onDelete()`) can coexist with fields of the same name.
 */

export interface IndexMeta {
	readonly name: string | undefined;
	readonly unique: boolean;
	readonly columns: readonly (Column<any> | SQLChunk)[];
	readonly where: SQLChunk | undefined;
}

export interface PrimaryKeyMeta {
	readonly name: string | undefined;
	readonly columns: readonly Column<any>[];
}

export interface ForeignKeyMeta {
	readonly name: string | undefined;
	readonly columns: readonly Column<any>[];
	readonly foreignColumns: readonly Column<any>[];
	readonly onDelete: ReferentialAction | undefined;
	readonly onUpdate: ReferentialAction | undefined;
}

export interface UniqueMeta {
	readonly name: string | undefined;
	readonly columns: readonly Column<any>[];
}

export interface CheckMeta {
	readonly name: string;
	readonly value: SQLChunk;
}

export class IndexConstraint {
	readonly kind = 'index' as const;
	constructor(readonly meta: IndexMeta) {}

	on(...columns: (Column<any> | SQLChunk)[]): IndexConstraint {
		return new IndexConstraint({ ...this.meta, columns });
	}

	/** Drizzle's expression form; treated identically here. */
	onOnly(...columns: (Column<any> | SQLChunk)[]): IndexConstraint {
		return this.on(...columns);
	}

	where(condition: SQLChunk): IndexConstraint {
		return new IndexConstraint({ ...this.meta, where: condition });
	}
}

export class PrimaryKeyConstraint {
	readonly kind = 'primaryKey' as const;
	constructor(readonly meta: PrimaryKeyMeta) {}
}

export class ForeignKeyConstraint {
	readonly kind = 'foreignKey' as const;
	constructor(readonly meta: ForeignKeyMeta) {}

	onDelete(action: ReferentialAction): ForeignKeyConstraint {
		return new ForeignKeyConstraint({ ...this.meta, onDelete: action });
	}

	onUpdate(action: ReferentialAction): ForeignKeyConstraint {
		return new ForeignKeyConstraint({ ...this.meta, onUpdate: action });
	}
}

export class UniqueConstraint {
	readonly kind = 'unique' as const;
	constructor(readonly meta: UniqueMeta) {}

	on(...columns: Column<any>[]): UniqueConstraint {
		return new UniqueConstraint({ ...this.meta, columns });
	}
}

export class CheckConstraint {
	readonly kind = 'check' as const;
	constructor(readonly meta: CheckMeta) {}
}

export type TableExtra =
	| IndexConstraint
	| PrimaryKeyConstraint
	| ForeignKeyConstraint
	| UniqueConstraint
	| CheckConstraint;

export const index = (name?: string): IndexConstraint =>
	new IndexConstraint({ name, unique: false, columns: [], where: undefined });

export const uniqueIndex = (name?: string): IndexConstraint =>
	new IndexConstraint({ name, unique: true, columns: [], where: undefined });

export function primaryKey(
	config: { columns: readonly Column<any>[]; name?: string } | Column<any>,
	...rest: Column<any>[]
): PrimaryKeyConstraint {
	if (Array.isArray((config as { columns?: unknown }).columns)) {
		const c = config as { columns: readonly Column<any>[]; name?: string };
		return new PrimaryKeyConstraint({ name: c.name, columns: c.columns });
	}
	// Legacy positional form: primaryKey(t.a, t.b)
	return new PrimaryKeyConstraint({ name: undefined, columns: [config as Column<any>, ...rest] });
}

export const foreignKey = (config: {
	columns: readonly Column<any>[];
	foreignColumns: readonly Column<any>[];
	name?: string;
}): ForeignKeyConstraint =>
	new ForeignKeyConstraint({
		name: config.name,
		columns: config.columns,
		foreignColumns: config.foreignColumns,
		onDelete: undefined,
		onUpdate: undefined,
	});

export const unique = (name?: string): UniqueConstraint =>
	new UniqueConstraint({ name, columns: [] });

export const check = (name: string, value: SQLChunk): CheckConstraint =>
	new CheckConstraint({ name, value });

/**
 * Derived constraint names.
 *
 * Drizzle names an unnamed constraint after its table and columns, and so does
 * our DDL. Both `orm-d1/ddl` and `getTableConfig` need the same answer — a
 * `getTableConfig` that reported a different index name from the one the
 * migration created would make the kit's diff see a rename on every run — so
 * the rules live here rather than in either caller.
 */
export const indexName = (meta: IndexMeta, tableName: string): string =>
	meta.name
	?? `${tableName}_${meta.columns.map((c) => (isColumnLike(c) ? c.name : 'expr')).join('_')}_${
		meta.unique ? 'unique' : 'index'
	}`;

export const primaryKeyName = (meta: PrimaryKeyMeta, tableName: string): string =>
	meta.name ?? `${tableName}_pk`;

export const uniqueConstraintName = (meta: UniqueMeta, tableName: string): string =>
	meta.name ?? `${tableName}_${meta.columns.map((c) => c.name).join('_')}_unique`;

// The columns are part of the name for the same reason they are everywhere
// else: snapshots key foreign keys by it, so two unnamed table-level keys on
// one table collided and the second silently overwrote the first — a
// referential constraint dropped from the generated migration with no error.
// This is also the shape introspection already emits (`${table}_${cols}_fk`),
// so the two sides of a diff now agree on an unnamed key's name.
export const foreignKeyName = (meta: ForeignKeyMeta, tableName: string): string =>
	meta.name ?? `${tableName}_${meta.columns.map((c) => c.name).join('_')}_fk`;

/**
 * A structural test rather than `isColumn`, because `columns.ts` imports this
 * module for its `ReferentialAction` and the reverse import would close a
 * cycle. An index entry is either a column or a SQL expression, and only a
 * column carries a string `name`.
 */
const isColumnLike = (value: unknown): value is { name: string } =>
	typeof (value as { name?: unknown })?.name === 'string';

const kinds = new Set(['index', 'primaryKey', 'foreignKey', 'unique', 'check']);

export const isTableExtra = (value: unknown): value is TableExtra =>
	typeof value === 'object' && value !== null && kinds.has((value as TableExtra).kind);
