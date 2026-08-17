/**
 * `defineRelations` — Drizzle v1's relation API.
 *
 * The v0 `relations()` API is gone, not deprecated. It stated the join on
 * whichever side happened to carry `fields`/`references` and matched the two
 * halves up by table, which is ambiguous the moment two relations point at the
 * same table; v1 states the join once, explicitly, on either side.
 *
 * ```ts
 * const relations = defineRelations({ users, posts }, (r) => ({
 *   users: { posts: r.many.posts() },
 *   posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
 * }));
 * ```
 *
 * The output is a plain object — `{ [tsName]: { table, name, relations } }` —
 * structurally identical to Drizzle's and produced with no import of
 * `drizzle-orm`. That is what makes v1 relations interop free at runtime: an
 * adapter reading `db._.relations` cannot tell the difference. The relation
 * values additionally carry Drizzle's `entityKind` statics, so an adapter that
 * does check `is(rel, Relation)` is satisfied too.
 */
import type { Column } from '../schema/columns.js';
import { entityKind } from '../schema/drizzle-entity.js';
import type { Table } from '../schema/table.js';
import { getTableColumns, getTableName, isTable } from '../schema/table.js';
import type { RelationsFilter } from './filter.js';

export type RelationType = 'one' | 'many';

/**
 * Which junction columns a `through` relation hops via.
 *
 * Holds `ColumnRef`s, not raw `Column`s — matching `drizzle-orm/relations.js`,
 * which builds `through.source`/`through.target` as `config.from.map((c) =>
 * c._.through)` (the value passed to `.through(column)`, itself a column
 * reference). An adapter that re-prototypes onto Drizzle's `Relation` and
 * reads `relation.through.source[0]._.column` needs this shape. See `[F-016]`
 * in `AUDIT.md`.
 */
export interface ThroughColumns {
	readonly source: readonly ColumnRef[];
	readonly target: readonly ColumnRef[];
}

export class Relation {
	static readonly [entityKind]: string = 'RelationV2';

	/** `'one'` or `'many'`; narrowed by each subclass. */
	declare readonly relationType: RelationType;

	/** The key this relation is declared under; assigned during processing. */
	fieldName = '';
	sourceTable!: Table;
	sourceColumns: readonly Column<any>[] | undefined;
	targetColumns: readonly Column<any>[] | undefined;
	through: ThroughColumns | undefined;
	throughTable: Table | undefined;
	/**
	 * True when the join was recovered from the relation on the other side
	 * rather than declared here. Only diagnostics read it.
	 */
	isReversed = false;

	constructor(
		readonly targetTable: Table,
		readonly targetTableName: string,
		readonly alias: string | undefined,
		public where: RelationsFilter | undefined,
	) {}

	get referencedTableName(): string {
		return getTableName(this.targetTable);
	}
}

export class One<TTarget extends Table = Table, TOptional extends boolean = boolean> extends Relation {
	static override readonly [entityKind]: string = 'OneV2';
	override readonly relationType = 'one' as const;
	/** Phantom: the table this points at, and whether the row may be missing. */
	declare readonly $target?: TTarget;
	declare readonly $optional?: TOptional;
	/** `T | null` rather than `T`. Defaults to true, as in Drizzle. */
	readonly optional: boolean;

	constructor(
		tables: Record<string, Table>,
		targetTable: Table,
		targetTableName: string,
		config: OneConfig | undefined,
	) {
		super(targetTable, targetTableName, config?.alias, config?.where);
		applyColumns(this, config, tables);
		this.optional = config?.optional ?? true;
	}
}

export class Many<TTarget extends Table = Table> extends Relation {
	static override readonly [entityKind]: string = 'ManyV2';
	override readonly relationType = 'many' as const;
	/** Phantom: the table this points at. */
	declare readonly $target?: TTarget;

	constructor(
		tables: Record<string, Table>,
		targetTable: Table,
		targetTableName: string,
		config: ManyConfig | undefined,
	) {
		super(targetTable, targetTableName, config?.alias, config?.where);
		applyColumns(this, config, tables);
	}
}

export const isRelation = (value: unknown): value is Relation => value instanceof Relation;

// --------------------------------------------------------------- the builder

/**
 * A reference to one column, as the builder hands it out.
 *
 * `_` mirrors Drizzle's internal shape, so the same object reads correctly from
 * code written against either. `.through(column)` names the junction column
 * this side of a many-to-many hops via.
 */
export class ColumnRef {
	constructor(
		readonly _: {
			readonly column: Column<any>;
			readonly tableName: string;
			readonly through: ColumnRef | undefined;
		},
	) {}

	through(junction: ColumnRef): ColumnRef {
		return new ColumnRef({ ...this._, through: junction });
	}
}

const toRefs = (value: ColumnRef | readonly ColumnRef[] | undefined): readonly ColumnRef[] =>
	value === undefined ? [] : Array.isArray(value) ? value as readonly ColumnRef[] : [value as ColumnRef];

export interface RelationBaseConfig {
	from?: ColumnRef | readonly ColumnRef[];
	to?: ColumnRef | readonly ColumnRef[];
	/** Extra predicate applied to the target rows whenever this is traversed. */
	where?: RelationsFilter;
	/** Pairs this relation with its reverse when two tables are joined twice. */
	alias?: string;
}

export interface OneConfig extends RelationBaseConfig {
	/** `false` promises the row is always there, dropping `| null`. */
	optional?: boolean;
}

export type ManyConfig = RelationBaseConfig;

/** `{ table, name, relations }` — one entry per table, as Drizzle produces. */
export interface TableRelationalConfig {
	readonly table: Table;
	readonly name: string;
	readonly relations: Record<string, Relation>;
	/**
	 * The table's columns by TypeScript name. Not part of Drizzle's shape; the
	 * query executor reads it at every level and re-deriving it each time is
	 * needless work.
	 */
	readonly columns: Record<string, Column<any>>;
}

export type RelationsConfig = Record<string, TableRelationalConfig>;

/**
 * The `r` handed to the callback.
 *
 * Indexing it by a table's TypeScript name yields that table's columns as
 * {@link ColumnRef}s; `r.one` and `r.many` yield the relation constructors. A
 * table named `one` or `many` is therefore unreachable through `r` — the same
 * limitation Drizzle has, and the reason those two names are worth avoiding.
 */
export type RelationsBuilder<TSchema> =
	& {
		[K in keyof TSchema as TSchema[K] extends Table ? K : never]: TSchema[K] extends Table<infer C>
			? { [Col in keyof C]: ColumnRef }
			: never;
	}
	& {
		one: {
			[K in keyof TSchema as TSchema[K] extends Table ? K : never]: <TConfig extends OneConfig>(
				config?: TConfig,
			) => One<
				TSchema[K] extends Table ? TSchema[K] : Table,
				TConfig extends { optional: false } ? false : true
			>;
		};
		many: {
			[K in keyof TSchema as TSchema[K] extends Table ? K : never]: (
				config?: ManyConfig,
			) => Many<TSchema[K] extends Table ? TSchema[K] : Table>;
		};
	};

/** The relation record a callback may return for each table. */
export type RelationsDeclaration<TSchema> = {
	[K in keyof TSchema as TSchema[K] extends Table ? K : never]?: Record<string, Relation>;
};

const buildColumnRefs = (tsName: string, table: Table): Record<string, ColumnRef> => {
	const refs: Record<string, ColumnRef> = {};
	for (const [key, column] of Object.entries(getTableColumns(table))) {
		refs[key] = new ColumnRef({ column: column as Column<any>, tableName: tsName, through: undefined });
	}
	return refs;
};

const buildBuilder = (tables: Record<string, Table>): RelationsBuilder<Record<string, Table>> => {
	const refs: Record<string, Record<string, ColumnRef>> = {};
	for (const [tsName, table] of Object.entries(tables)) refs[tsName] = buildColumnRefs(tsName, table);

	const constructors = (make: (table: Table, tsName: string, config: never) => Relation) =>
		Object.fromEntries(
			Object.entries(tables).map(([tsName, table]) => [tsName, (config?: never) => make(table, tsName, config!)]),
		);

	return {
		...refs,
		one: constructors((table, tsName, config) => new One(tables, table, tsName, config)),
		many: constructors((table, tsName, config) => new Many(tables, table, tsName, config)),
	} as unknown as RelationsBuilder<Record<string, Table>>;
};

/**
 * Read `from`/`to` off a config onto the relation.
 *
 * The junction table of a many-to-many is discovered here rather than declared
 * separately: a column reference carrying `.through(…)` names it.
 */
const applyColumns = (
	relation: Relation,
	config: RelationBaseConfig | undefined,
	tables: Record<string, Table>,
): void => {
	const from = toRefs(config?.from);
	const to = toRefs(config?.to);
	if (config?.from !== undefined) relation.sourceColumns = from.map((ref) => ref._.column);
	if (config?.to !== undefined) relation.targetColumns = to.map((ref) => ref._.column);

	const junction = [...from, ...to].find((ref) => ref._.through !== undefined)?._.through;
	if (!junction) return;

	relation.throughTable = tables[junction._.tableName];
	relation.through = {
		source: from.map((ref) => ref._.through).filter((c): c is ColumnRef => c !== undefined),
		target: to.map((ref) => ref._.through).filter((c): c is ColumnRef => c !== undefined),
	};
};

const describe = (tsName: string, fieldName: string, relation: Relation): string =>
	`relations -> ${tsName}: { ${fieldName}: r.${relation.relationType}.${relation.targetTableName}(…) }`;

/**
 * Fill in what each relation did not state, and refuse what cannot be resolved.
 *
 * A relation may omit `from`/`to` entirely, in which case the join is taken
 * from the relation pointing the other way — the usual spelling for the `many`
 * side. That is unambiguous only when exactly one such relation exists, so two
 * relations between the same pair of tables must be paired up by giving both
 * the same `alias`.
 */
const processRelations = (config: RelationsConfig): RelationsConfig => {
	for (const table of Object.values(config)) {
		for (const [fieldName, relation] of Object.entries(table.relations)) {
			relation.sourceTable = table.table;
			relation.fieldName = fieldName;
		}
	}

	for (const [sourceTsName, table] of Object.entries(config)) {
		for (const [fieldName, relation] of Object.entries(table.relations)) {
			const where = describe(sourceTsName, fieldName, relation);

			if (fieldName in table.columns) {
				throw new Error(`${where}: the relation name collides with the column "${fieldName}" on "${sourceTsName}".`);
			}
			if (relation.alias === '') {
				throw new Error(`${where}: "alias" cannot be an empty string — omit it if you do not need one.`);
			}
			if (relation.sourceColumns?.length === 0) throw new Error(`${where}: "from" cannot be empty.`);
			if (relation.targetColumns?.length === 0) throw new Error(`${where}: "to" cannot be empty.`);

			if (relation.sourceColumns && relation.targetColumns) {
				validateDeclared(relation, where, sourceTsName);
				continue;
			}
			if (relation.sourceColumns || relation.targetColumns) {
				throw new Error(`${where}: declare both "from" and "to", or neither.`);
			}

			adoptReverse(config, relation, where, sourceTsName);
		}
	}

	return config;
};

const validateDeclared = (relation: Relation, where: string, sourceTsName: string): void => {
	const from = relation.sourceColumns!;
	const to = relation.targetColumns!;

	if (from.length !== to.length && !relation.throughTable) {
		throw new Error(`${where}: "from" and "to" must name the same number of columns unless they go ".through(…)".`);
	}
	for (const column of from) {
		if (column.tableName !== getTableName(relation.sourceTable)) {
			throw new Error(`${where}: every "from" column must belong to "${sourceTsName}", but "${column.name}" does not.`);
		}
	}
	for (const column of to) {
		if (column.tableName !== getTableName(relation.targetTable)) {
			throw new Error(
				`${where}: every "to" column must belong to "${relation.targetTableName}", but "${column.name}" does not.`,
			);
		}
	}
	if (relation.through) {
		if (relation.through.source.length !== from.length || relation.through.target.length !== to.length) {
			throw new Error(`${where}: use ".through(column)" on every column of "from" and "to", or on none of them.`);
		}
		const junction = getTableName(relation.throughTable!);
		for (const ref of [...relation.through.source, ...relation.through.target]) {
			if (ref._.column.tableName !== junction) {
				throw new Error(`${where}: every ".through(column)" must belong to the same table, "${junction}".`);
			}
		}
	}
};

const adoptReverse = (config: RelationsConfig, relation: Relation, where: string, sourceTsName: string): void => {
	const target = config[relation.targetTableName];
	if (!target) {
		throw new Error(
			`${where}: no "from"/"to" given, and "${relation.targetTableName}" declares no relations to take them from.`,
		);
	}

	const candidates = Object.values(target.relations).filter((candidate) =>
		candidate !== relation
		&& (relation.alias
			? candidate.alias === relation.alias
			: candidate.targetTable === relation.sourceTable && !candidate.alias)
	);

	if (candidates.length > 1) {
		throw new Error(
			`${where}: no "from"/"to" given, and "${relation.targetTableName}" has more than one relation back to `
				+ `"${sourceTsName}" (${candidates.map((c) => `"${c.fieldName}"`).join(', ')}). `
				+ 'Give the two that belong together the same "alias", or state "from"/"to" here.',
		);
	}

	const reverse = candidates[0];
	if (!reverse) {
		throw new Error(
			`${where}: no "from"/"to" given, and "${relation.targetTableName}" has no relation back to "${sourceTsName}"`
				+ (relation.alias ? ` with alias "${relation.alias}".` : '.'),
		);
	}
	if (!reverse.sourceColumns || !reverse.targetColumns) {
		throw new Error(
			`${where}: no "from"/"to" given, and the matching relation `
				+ `"${relation.targetTableName}.${reverse.fieldName}" does not state them either. One side must.`,
		);
	}

	// Seen from here, the other side's `to` is our `from`.
	relation.sourceColumns = reverse.targetColumns;
	relation.targetColumns = reverse.sourceColumns;
	relation.through = reverse.through
		? { source: reverse.through.target, target: reverse.through.source }
		: undefined;
	relation.throughTable = reverse.throughTable;
	// A `where` stated on this side names this side's own target columns, not
	// the source it's being reversed onto, so it is not treated as "reversed"
	// for the purposes of where-compilation (drizzle-orm/relations.js:60).
	const thatWhere = relation.where;
	relation.isReversed = !thatWhere;
	// A `where` stated on this side wins; otherwise the other side's applies.
	relation.where = relation.where ?? reverse.where;
};

/**
 * Declare the relations for a schema.
 *
 * Every table in `schema` gets an entry whether or not the callback named it,
 * so `db.query.<table>` exists for all of them.
 */
export function defineRelations<TSchema extends Record<string, unknown>, TConfig extends RelationsDeclaration<TSchema>>(
	schema: TSchema,
	builder: (r: RelationsBuilder<TSchema>) => TConfig,
): DefinedRelations<TSchema, TConfig> {
	const tables: Record<string, Table> = {};
	for (const [tsName, value] of Object.entries(schema)) {
		if (isTable(value)) tables[tsName] = value;
	}

	const declared = builder(buildBuilder(tables) as unknown as RelationsBuilder<TSchema>) as Record<
		string,
		Record<string, Relation> | undefined
	>;

	for (const tsName of Object.keys(declared)) {
		if (!tables[tsName]) {
			throw new Error(
				`defineRelations: "${tsName}" is not a table in the schema passed as the first argument. `
					+ `Known tables: ${Object.keys(tables).join(', ') || '(none)'}.`,
			);
		}
	}

	const config: RelationsConfig = {};
	for (const [tsName, table] of Object.entries(tables)) {
		config[tsName] = {
			table,
			name: tsName,
			relations: { ...declared[tsName] },
			columns: getTableColumns(table) as Record<string, Column<any>>,
		};
	}

	return processRelations(config) as DefinedRelations<TSchema, TConfig>;
}

/**
 * Phantom keys carrying the schema and the declared relations at the type
 * level, so `db.query` can be inferred from the `defineRelations` result alone.
 *
 * Symbols rather than `$schema`/`$config` string keys: the runtime value is a
 * plain record that adapters iterate with `Object.values`, and a string-keyed
 * phantom would widen the element type of that iteration to include a value
 * that is never actually there.
 */
export declare const RelationsSchema: unique symbol;
export declare const RelationsShape: unique symbol;

/** The runtime value, plus the two phantoms. */
export type DefinedRelations<TSchema, TConfig> = RelationsConfig & {
	readonly [RelationsSchema]?: TSchema;
	readonly [RelationsShape]?: TConfig;
};

/** Database name → TypeScript name, which is how a relation names its target. */
export const tableNamesMapOf = (config: RelationsConfig): Record<string, string> => {
	const map: Record<string, string> = {};
	for (const [tsName, table] of Object.entries(config)) map[getTableName(table.table)] = tsName;
	return map;
};
