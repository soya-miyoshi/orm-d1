/**
 * `orm-d1/core` — the lean entry point.
 *
 * Identical to the root entry except that `orm-d1()` here does not accept a
 * `schema` option, so nothing reaches `relations/` and the relational query
 * layer never enters the bundle (rule R5). Import from `orm-d1` unless you are
 * counting bytes and never use `db.query`.
 */

// schema
export type {
	BlobConfig,
	ColumnConfig,
	ColumnDefault,
	ColumnMeta,
	ColumnReference,
	CustomTypeParams,
	IntegerConfig,
	ReferentialAction,
	SQLiteType,
	TextConfig,
} from './schema/columns.js';
export {
	blob,
	boolean,
	Column,
	ColumnBuilder,
	configureCasing,
	customType,
	integer,
	isColumn,
	json,
	numeric,
	real,
	text,
} from './schema/columns.js';

export type {
	CheckMeta,
	ForeignKeyMeta,
	IndexMeta,
	PrimaryKeyMeta,
	TableExtra,
	UniqueMeta,
} from './schema/constraints.js';
export { check, foreignKey, index, primaryKey, unique, uniqueIndex } from './schema/constraints.js';

export type { ColumnsMap, NameOf, Subquery, Table, TableConfig } from './schema/table.js';
export {
	alias,
	getTableColumns,
	getTableConfig,
	getTableExtras,
	getTableName,
	getTableOriginalName,
	isTable,
	sqliteTable,
	table,
	TableColumns,
	TableName,
} from './schema/table.js';

export type {
	InferInsert,
	InferInsertModel,
	InferSelect,
	InferSelectModel,
	Simplify,
} from './schema/infer.js';

// sql
export type { D1Param, ParamSlot, Query, RenderContext, SQLChunk } from './sql/sql.js';
export { Identifier, Param, Placeholder, ph, Raw, sql } from './sql/sql.js';
export type { Condition } from './sql/expressions.js';
export {
	add,
	and,
	asc,
	between,
	desc,
	divide,
	eq,
	exists,
	glob,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	multiply,
	ne,
	not,
	notBetween,
	notExists,
	notIlike,
	notInArray,
	notLike,
	or,
	subtract,
} from './sql/expressions.js';
export { avg, coalesce, count, countDistinct, length, lower, max, min, sum, upper } from './sql/functions.js';

// plan
export type { CompiledQuery, CompileOptions } from './plan/compile.js';
export { compilePlan, CompileError } from './plan/compile.js';
export { bindParams, MissingPlaceholderError } from './plan/params.js';
export type { Selection, SelectPlan } from './plan/plan.js';

// builders
export type { BatchResult, Runnable } from './builders/types.js';
export { SelectBuilder } from './builders/select.js';
export { InsertBuilder } from './builders/insert.js';
export { UpdateBuilder } from './builders/update.js';
export { DeleteBuilder } from './builders/delete.js';
export { query } from './builders/root.js';
export type { LatestPerGroupConfig } from './builders/window.js';
export { latestPerGroup } from './builders/window.js';

// runtime
export type { Logger, OrmD1Options, OrmD1Session } from './runtime/database.js';
export { OrmD1Database, ormD1 } from './runtime/database.js';
export type { QueryEvent } from './runtime/result.js';
export { OrmD1QueryError, NoTransactionsError } from './errors.js';
export type { D1Plan, PlanLimits } from './limits.js';
export {
	MAX_COLUMNS_PER_TABLE,
	MAX_FUNCTION_ARGS,
	MAX_PATTERN_BYTES,
	MAX_STATEMENT_BYTES,
	PLAN_LIMITS,
} from './limits.js';
export { isDev, setDev, setWarn } from './dev.js';
