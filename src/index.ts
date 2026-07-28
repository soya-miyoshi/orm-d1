/**
 * d1zzle — a type-safe query builder built exclusively for Cloudflare D1.
 *
 * ```ts
 * import { drizzle } from 'd1zzle';
 * const db = drizzle(env.DB, { schema });
 * ```
 *
 * Everything the lean `d1zzle/core` entry exports is re-exported here. The one
 * difference is `d1zzle()` / `drizzle()`: passing `schema` attaches `db.query`
 * and the `db._` metadata that Drizzle's ecosystem reads, which means this
 * entry does reach `relations/`. `d1zzle/core` is the byte-counting path.
 */
export * from './core.js';

export * from './relations/index.js';

import type { RelationsConfig } from './relations/index.js';
import type { QueryAPI, RelationalMeta } from './relations/index.js';
import { withRelations } from './relations/index.js';
import type { RelationalStrategy } from './relations/index.js';
import type { D1zzleOptions } from './runtime/database.js';
import { D1zzleDatabase, d1zzle as createDatabase } from './runtime/database.js';

export type D1zzleDatabaseWithRelations<TRelations> =
	& D1zzleDatabase
	& { query: QueryAPI<TRelations>; _: RelationalMeta<TRelations> };

/** Options plus the binding, as v1's single-argument form takes them. */
export interface D1zzleConfig<TRelations> extends D1zzleOptions {
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
export function d1zzle<TRelations extends RelationsConfig>(
	config: D1zzleConfig<TRelations> & { relations: TRelations },
): D1zzleDatabaseWithRelations<TRelations>;
export function d1zzle(config: D1zzleConfig<never>): D1zzleDatabase;
export function d1zzle<TRelations extends RelationsConfig>(
	binding: D1Database,
	options: D1zzleOptions & { relations: TRelations },
): D1zzleDatabaseWithRelations<TRelations>;
export function d1zzle(binding: D1Database, options?: D1zzleOptions): D1zzleDatabase;
export function d1zzle(
	bindingOrConfig: D1Database | D1zzleConfig<RelationsConfig>,
	options: D1zzleOptions = {},
): D1zzleDatabase {
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
	const config = isConfig ? bindingOrConfig as D1zzleConfig<RelationsConfig> : options;
	const binding = isConfig ? (bindingOrConfig as D1zzleConfig<RelationsConfig>).client : bindingOrConfig as D1Database;

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
export const drizzle: typeof d1zzle = d1zzle;
