/**
 * orm-d1 — a type-safe query builder built exclusively for Cloudflare D1.
 *
 * ```ts
 * import { drizzle } from 'orm-d1';
 * const db = drizzle(env.DB, { schema });
 * ```
 *
 * Everything the lean `orm-d1/core` entry exports is re-exported here. The one
 * difference is `orm-d1()` / `drizzle()`: passing `schema` attaches `db.query`
 * and the `db._` metadata that Drizzle's ecosystem reads, which means this
 * entry does reach `relations/`. `orm-d1/core` is the byte-counting path.
 */
export * from './core.js';

export * from './relations/index.js';

import type { RelationsConfig } from './relations/index.js';
import type { QueryAPI, RelationalMeta } from './relations/index.js';
import { withRelations } from './relations/index.js';
import type { RelationalStrategy } from './relations/index.js';
import type { OrmD1Options } from './runtime/database.js';
import { OrmD1Database, ormD1 as createDatabase } from './runtime/database.js';

export type OrmD1DatabaseWithRelations<TRelations> =
	& OrmD1Database
	& { query: QueryAPI<TRelations>; _: RelationalMeta<TRelations> };

/** Options plus the binding, as v1's single-argument form takes them. */
export interface OrmD1Config<TRelations> extends OrmD1Options {
	client: D1Database;
	relations?: TRelations;
}

/**
 * Open a database.
 *
 * The options object is the primary form, matching v1:
 *
 * ```ts
 * const db = drizzle({ client: env.DB, relations });
 * ```
 *
 * The binding-first overload is kept because on Workers the binding is the
 * natural first argument, and it costs one signature:
 *
 * ```ts
 * const db = drizzle(env.DB, { relations });
 * ```
 */
export function ormD1<TRelations extends RelationsConfig>(
	config: OrmD1Config<TRelations> & { relations: TRelations },
): OrmD1DatabaseWithRelations<TRelations>;
export function ormD1(config: OrmD1Config<never>): OrmD1Database;
export function ormD1<TRelations extends RelationsConfig>(
	binding: D1Database,
	options: OrmD1Options & { relations: TRelations },
): OrmD1DatabaseWithRelations<TRelations>;
export function ormD1(binding: D1Database, options?: OrmD1Options): OrmD1Database;
export function ormD1(
	bindingOrConfig: D1Database | OrmD1Config<RelationsConfig>,
	options: OrmD1Options = {},
): OrmD1Database {
	// Guarded before the probe below, which would otherwise throw a bare
	// `Cannot read properties of undefined (reading 'prepare')`. A typo'd
	// binding name is the most common way to arrive here, and `drizzle(env.DB)`
	// with no `DB` in wrangler.jsonc is exactly that.
	if (bindingOrConfig == null) {
		throw new Error(
			'drizzle() was given no binding. Pass the D1 binding — `drizzle(env.DB)` — and check that the '
				+ 'name matches a d1_databases entry in your wrangler config.',
		);
	}

	// A binding has `prepare`; a config object does not. Nothing else
	// distinguishes them, and `client` may legitimately be absent from neither.
	const isConfig = typeof (bindingOrConfig as D1Database).prepare !== 'function';
	const config = isConfig ? bindingOrConfig as OrmD1Config<RelationsConfig> : options;
	const binding = isConfig ? (bindingOrConfig as OrmD1Config<RelationsConfig>).client : bindingOrConfig as D1Database;

	if (!binding) {
		throw new Error('drizzle({ … }) needs a `client`: the D1 binding to run against, e.g. `env.DB`.');
	}

	const db = createDatabase(binding, config);
	const relations = (config as { relations?: RelationsConfig }).relations;
	const strategy = (config as { relationalStrategy?: RelationalStrategy }).relationalStrategy;
	return relations ? withRelations(db, relations, strategy) : db;
}

/**
 * Drizzle-compatible entry point. The signature matches `drizzle-orm/d1`, so
 * migrating a project is a one-line import change.
 */
export const drizzle: typeof ormD1 = ormD1;
