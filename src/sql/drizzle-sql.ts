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
 * Strip a `"table".` qualifier from in front of every quoted identifier.
 *
 * Drizzle's own `SQL.toQuery` always renders a `Column` chunk as
 * `escapeName(table) + "." + escapeName(column)` (`drizzle-orm/sql/sql.js`) —
 * there is no config knob to ask it for the bare column, unlike our own
 * `Column.toQuery`, which honours `ctx.bareColumns` directly. Every identifier
 * `escapeName` produces here is double-quoted (see `quote` above), so
 * `"x"."y"` unambiguously means "y qualified by x" and is safe to collapse to
 * `"y"` wherever it appears in the rendered text.
 */
const stripQualifiers = (sql: string): string => sql.replace(/"(?:[^"]|"")*"\.(?="(?:[^"]|"")*")/g, '');

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

	const token = ctx?.paramToken ?? '?';
	const { sql, params } = fragment.toQuery({
		escapeName: quote,
		escapeParam: (): string => token,
		escapeString: (str: string): string => `'${str.replaceAll("'", "''")}'`,
		casing: { getColumnCasing: (column: { name: string }): string => column.name },
		inlineParams: false,
	});

	// `check('c', drizzleSql\`${col} > 0\`)` must not render "t"."c" > 0 — SQLite
	// rejects a table-qualified column inside a CHECK constraint. See [F-067].
	return { sql: ctx?.bareColumns ? stripQualifiers(sql) : sql, params: params.map(toSlot) };
};

/**
 * Render any chunk — ours or Drizzle's. The single place `toQuery` is called on
 * a value whose origin is not known, so a foreign fragment cannot slip through
 * the duck-type and die on the wrong config shape.
 */
export const render = (chunk: SQLChunk, ctx?: RenderContext): Query =>
	isForeignSQL(chunk) ? fromDrizzleSQL(chunk, ctx) : chunk.toQuery(ctx);
