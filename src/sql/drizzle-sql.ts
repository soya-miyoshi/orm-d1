/**
 * The bridge that lets a Drizzle `SQL` fragment render inside an orm-d1 query.
 *
 * Nothing here imports `drizzle-orm`. Drizzle's entity system is built on
 * `Symbol.for('drizzle:entityKind')` statics walked up the constructor chain,
 * so a fragment can be recognised — and rendered — with no dependency at all.
 * That matters because `drizzle-orm` is an *optional* peer here: a project that
 * never touches an adapter must not pay for one.
 *
 * Why this is needed: Pothos' drizzle plugin builds its batching predicate with
 * Drizzle's own `inArray`/`sql` over our columns and hands us the result as
 * `where: { RAW: (table) => … }`. Our columns already satisfy `is(col, Column)`,
 * so building the fragment works; what did not work before this module is
 * rendering it, because a Drizzle `SQL` wants a `BuildQueryConfig` and ours
 * wants a `RenderContext`.
 */
import type { D1Param, ParamSlot, Query, RenderContext, SQLChunk } from './sql.js';

const entityKind = Symbol.for('drizzle:entityKind');

/**
 * Drizzle's `is()`, without importing it: walk the constructor chain looking
 * for a static `entityKind` equal to `kind`.
 */
const hasEntityKind = (value: object, kind: string): boolean => {
	let cls: unknown = Object.getPrototypeOf(value)?.constructor;
	while (cls) {
		if ((cls as Record<symbol, unknown>)[entityKind] === kind) return true;
		cls = Object.getPrototypeOf(cls);
	}
	return false;
};

/** A Drizzle `SQL` fragment. */
export const isDrizzleSQL = (value: unknown): boolean =>
	typeof value === 'object' && value !== null && hasEntityKind(value, 'SQL');

/**
 * A Drizzle `StringChunk` — a literal fragment of SQL text, as opposed to a
 * bound value or a nested `SQL`. Exported for `src/ddl.ts`'s DDL-only
 * empty-array detection: Drizzle's `inArray`/`notInArray` helpers
 * short-circuit an empty array to `sql\`true\`` / `sql\`false\`` *before*
 * building any array chunk, which renders as a whole fragment whose
 * `queryChunks` is exactly one `StringChunk(["true"])` / `StringChunk(["false"])`
 * — structurally different from (and not caught by) a scan for a bare `[]`.
 */
export const isStringChunk = (value: unknown): value is { readonly value: readonly string[] } =>
	typeof value === 'object' && value !== null && hasEntityKind(value, 'StringChunk');

/** The text a Drizzle `StringChunk` carries — its `value` array, joined. */
export const stringChunkText = (chunk: { readonly value: readonly string[] }): string => chunk.value.join('');

/**
 * Anything Drizzle can turn into a fragment: a `SQL`, or a `SQLWrapper` such as
 * a Drizzle column, table or aggregate.
 *
 * Our own chunks are excluded by the `toQuery` test — an orm-d1 `Column` also has
 * `getSQL()` (it is a `SQLWrapper` on purpose), and it must keep rendering
 * through our own path.
 */
export const isForeignSQL = (value: unknown): boolean => {
	if (typeof value !== 'object' || value === null) return false;
	if (isDrizzleSQL(value)) return true;
	const candidate = value as { getSQL?: unknown; toQuery?: unknown };
	return typeof candidate.getSQL === 'function' && typeof candidate.toQuery !== 'function';
};

/**
 * A parameter slot as Drizzle hands it back.
 *
 * `SQL.toQuery` does not return plain values in every position: a bound
 * placeholder comes back as the `Placeholder` (or the `Param` wrapping one)
 * rather than a value, because the value is not known yet. Those become our
 * `ph` slots, which is exactly the same deferral.
 */
/**
 * An orm-d1 `Placeholder` that has been interpolated into a Drizzle fragment.
 *
 * Drizzle does not recognise it, so it wraps it as a plain bound value and it
 * would reach `.bind()` as an object — `D1_TYPE_ERROR: Type 'object' not
 * supported`, from a line that looks fine. Mixing the two spellings is an easy
 * thing to do once both are in scope, so it is honoured rather than punished.
 *
 * Tested structurally rather than with `isPlaceholder`, because importing that
 * would close a runtime cycle back into `sql.ts`; only our `Placeholder` has
 * both a string `name` and a `toQuery`.
 */
const isOurPlaceholder = (value: object): value is { name: string } =>
	typeof (value as { name?: unknown }).name === 'string'
	&& typeof (value as { toQuery?: unknown }).toQuery === 'function';

const toSlot = (param: unknown): ParamSlot => {
	if (typeof param === 'object' && param !== null) {
		if (hasEntityKind(param, 'Placeholder') || isOurPlaceholder(param)) {
			return { k: 'ph', name: (param as { name: string }).name };
		}
		if (hasEntityKind(param, 'Param')) {
			const { value, encoder } = param as { value: unknown; encoder?: { mapToDriverValue?: (v: unknown) => unknown } };
			if (typeof value === 'object' && value !== null && hasEntityKind(value, 'Placeholder')) {
				const name = (value as { name: string }).name;
				const map = encoder?.mapToDriverValue;
				return map
					? { k: 'ph', name, encode: (v: unknown): D1Param => map.call(encoder, v) as D1Param }
					: { k: 'ph', name };
			}
			return { k: 'const', v: value as D1Param };
		}
	}
	return { k: 'const', v: param as D1Param };
};

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Render a Drizzle fragment into our `{ sql, params }`.
 *
 * `casing` is not read by every Drizzle version but is cheap to supply, and
 * omitting it on a version that does read it fails with an unhelpful
 * `Cannot read properties of undefined (reading 'getColumnCasing')`. Our
 * `Column.name` getter has already applied the configured casing, so mapping
 * `getColumnCasing` onto it keeps a `snake_case` project rendering foreign
 * fragments the same way it renders its own.
 */
export const fromDrizzleSQL = (value: unknown, ctx?: RenderContext): Query => {
	const fragment = isDrizzleSQL(value)
		? value as { toQuery: (config: unknown) => { sql: string; params: unknown[] } }
		: (value as { getSQL: () => { toQuery: (config: unknown) => { sql: string; params: unknown[] } } }).getSQL();

	// Whether one of this fragment's own `queryChunks` is a bare `[]` — the
	// empty-array-predicate hazard `src/sql/sql.ts`'s own `toQuery` refuses via
	// `ctx.onEmptyArrayPredicate` for our own template tag — is DDL-only
	// detection logic. Scanning `queryChunks` here would ship a Drizzle-specific
	// tree walk in the core runtime bundle for a check that can only ever fire
	// under `ctx.bareColumns` (set only by `src/ddl.ts`, which never reaches a
	// deployed Worker). So this only hands the fragment's own chunk list to
	// whatever the caller supplied; the walk itself lives in `src/ddl.ts`.
	if (ctx?.bareColumns && isDrizzleSQL(fragment)) {
		ctx.onForeignFragment?.((fragment as unknown as { queryChunks: readonly unknown[] }).queryChunks);
	}

	const token = ctx?.paramToken ?? '?';
	const { sql, params } = fragment.toQuery({
		escapeName: quote,
		escapeParam: (): string => token,
		escapeString: (str: string): string => `'${str.replaceAll("'", "''")}'`,
		casing: { getColumnCasing: (column: { name: string }): string => column.name },
		inlineParams: false,
		// `check('c', drizzleSql\`${col} > 0\`)` must not render "t"."c" > 0 —
		// a table-qualified column is fine in a CHECK constraint on D1 (`check
		// ("t"."c" <> 'bad')` and `where "t"."c" = 'x'` are both accepted); the
		// real restriction is narrower and applies only to a *generated*
		// column's expression, where the `.` operator is rejected outright
		// (`the "." operator prohibited in generated columns`). Bare-columns
		// rendering here still strips the qualifier regardless — it reads more
		// naturally and avoids relying on a table alias the DDL context never
		// declares — it just is not a correctness requirement for `check`/
		// `where`. Drizzle itself special-cases this: `SQL.toQuery`
		// (drizzle-orm/sql/sql.js) checks `_config.invokeSource === 'indexes'`
		// at the `Column` chunk and, if so, renders just `escapeName(columnName)`
		// with no table qualifier — the flag propagates through nested
		// fragments automatically. Asking for it structurally here means only
		// actual column-reference nodes are affected; text inside string
		// literals (e.g. a JSON path like '$."a"."b"') is untouched, unlike a
		// text-level regex over the rendered SQL. See [F-067].
		...(ctx?.bareColumns ? { invokeSource: 'indexes' } : {}),
	});

	return { sql, params: params.map(toSlot) };
};

/**
 * Render any chunk — ours or Drizzle's. The single place `toQuery` is called on
 * a value whose origin is not known, so a foreign fragment cannot slip through
 * the duck-type and die on the wrong config shape.
 */
export const render = (chunk: SQLChunk, ctx?: RenderContext): Query =>
	isForeignSQL(chunk) ? fromDrizzleSQL(chunk, ctx) : chunk.toQuery(ctx);
