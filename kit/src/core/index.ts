/**
 * `orm-d1-kit/core` — the pure half: snapshots, diffing, introspection.
 *
 * No Node builtins and no filesystem, so it runs anywhere the schema does —
 * including inside workerd, which is where the migration engine is tested
 * against a real D1 database.
 */
export { applyMigration, applyMigrations, appliedMigrations, ensureMigrationsTable, introspect, MAX_STATEMENTS_PER_BATCH } from './apply.js';
export type { ApplyResult, SqlRunner } from './apply.js';

export { backfill } from './backfill.js';
export type { BackfillResult } from './backfill.js';

export { diffSnapshots, isEmptyDiff, renderMigration } from './diff.js';
export type { DiffOptions, DiffResult, Statement } from './diff.js';

export { impactOf, impactRanking, impactWithRows } from './impact.js';
export type { TableImpact } from './impact.js';

export {
	appendOnlyTriggerGuard,
	hasAutoincrement,
	isAppendOnlyTrigger,
	isInternalTable,
	parseChecks,
	parseGenerated,
	snapshotFromIntrospection,
} from './introspect.js';
export type { IntrospectionInput, MasterRow, TableInfoRow } from './introspect.js';

export { appendEntry, emptyJournal, migrationName, migrationTag, nextIndex, pendingMigrations } from './journal.js';
export type { Journal, JournalEntry } from './journal.js';

export {
	createIndexFromSnapshot,
	createTableFromSnapshot,
	emptySnapshot,
	normalizeIndexColumn,
	snapshotFromSchema,
	SNAPSHOT_VERSION,
} from './snapshot.js';
export type {
	ColumnSnapshot,
	ForeignKeySnapshot,
	IndexColumnSnapshot,
	IndexSnapshot,
	Snapshot,
	TableSnapshot,
} from './snapshot.js';

export { renderRoundtrip, roundtripPlan } from './roundtrip.js';
export type { RoundtripLeg, RoundtripPlan } from './roundtrip.js';

export { applicableStatements, createMigrationsTable, isPragma, MIGRATIONS_TABLE, splitStatements } from './sql.js';

export { vocabularyDivergences, vocabularyWarnings } from './vocabulary.js';
export type { VocabularyDivergence } from './vocabulary.js';
