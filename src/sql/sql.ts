/**
 * The SQL layer: a template tag and a handful of chunk types that render
 * themselves into `{ sql, params }`.
 *
 * D1 only speaks positional `?` parameters, so a query is fully described by a
 * string and a flat parameter list. Everything in orm-d1 compiles down to this.
 */

import { CompileError } from '../errors.js';
import { isForeignSQL, render } from './drizzle-sql.js';

export { fromDrizzleSQL, isDrizzleSQL, isForeignSQL, render } from './drizzle-sql.js';

/** The value types D1's `.bind()` accepts. */
export type D1Param = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

/**
 * A parameter position in a compiled statement.
 *
 * `const` values are captured when the query is built; `ph` and `fn` slots are
 * filled at execution time, which is what lets a compiled query be hoisted to
 * module scope and reused across requests with fresh values.
 */
export type ParamSlot =
	| { readonly k: 'const'; readonly v: D1Param }
	| { readonly k: 'ph'; readonly name: string; readonly encode?: (value: unknown) => D1Param }
	| { readonly k: 'fn'; readonly fn: () => unknown; readonly encode?: (value: unknown) => D1Param };

/** A SQL fragment: text plus the parameter slots that fill its placeholders. */
export interface Query {
	readonly sql: string;
	readonly params: readonly ParamSlot[];
}

/**
 * Options that a few chunks need while rendering — notably `inArray`, which
 * switches to `json_each` rather than blow D1's bound-parameter budget.
 */
export interface RenderContext {
	readonly maxParams: number;
	/** Array length at or above which `inArray` collapses to a single JSON param. */
	readonly jsonEachThreshold: number;
	/**
	 * Render columns without their table qualifier. DDL contexts (checks,
	 * generated columns, partial-index predicates) cannot qualify names.
	 */
	readonly bareColumns?: boolean;
	/**
	 * Text emitted in place of a bound value. Defaults to `?`. DDL rendering
	 * overrides it with a sentinel, so a literal `?` inside a `sql.raw(…)`
	 * fragment cannot be mistaken for a parameter slot when the values are
	 * inlined.
	 */
	readonly paramToken?: string;
	/**
	 * Called when an empty array is interpolated into a DDL predicate (a
	 * `check()` or a partial index's `where()`), which renders `in ()` / `not in
	 * ()` — SQLite accepts it, but it is unconditionally false/true, so the
	 * constraint or partial index goes permanently inert. This module ships to
	 * the Worker and must not decide what to do about that; `src/ddl.ts`
	 * supplies this hook only while generating DDL and throws from it.
	 */
	readonly onEmptyArrayPredicate?: () => void;
	/**
	 * Called with a foreign (Drizzle) `SQL` fragment's own `queryChunks` when
	 * one is rendered under `bareColumns`, so the tree walk that looks for an
	 * interpolated empty array nested inside it (`and`/`eq`/`inArray` built
	 * with Drizzle's own `sql` tag) can live in `src/ddl.ts` — Node, DDL-only —
	 * instead of the core runtime bundle. A no-op when absent, so production
	 * pays nothing beyond the field check itself.
	 */
	readonly onForeignFragment?: (queryChunks: readonly unknown[]) => void;
}

export const defaultRenderContext: RenderContext = {
	maxParams: 100,
	jsonEachThreshold: 30,
};

/**
 * Resolve the two budget options together, because they are not independent.
 *
 * `jsonEachThreshold` is the length at which `inArray` stops binding one
 * parameter per value and starts binding one JSON parameter. Above `maxParams`
 * it leaves a band of array lengths too short to collapse and too long to
 * bind, which overflows the budget for values that had a perfectly good
 * `json_each` spelling.
 *
 * Lowering `maxParams` alone is the common case — it is how you ask for
 * smaller chunks — and the default threshold is not a choice the caller made,
 * so it is clamped rather than rejected. Setting both, in conflict, is a bug
 * worth naming.
 */
export const resolveParamBudget = (
	maxParams: number | undefined,
	jsonEachThreshold: number | undefined,
): { maxParams: number; jsonEachThreshold: number } => {
	const max = maxParams ?? defaultRenderContext.maxParams;
	if (!Number.isInteger(max) || max < 1) {
		throw new CompileError(`maxParams must be a positive integer; received ${JSON.stringify(maxParams)}.`);
	}

	if (jsonEachThreshold === undefined) {
		return { maxParams: max, jsonEachThreshold: Math.min(defaultRenderContext.jsonEachThreshold, max) };
	}
	if (!Number.isInteger(jsonEachThreshold) || jsonEachThreshold < 1) {
		throw new CompileError(
			`jsonEachThreshold must be a positive integer; received ${JSON.stringify(jsonEachThreshold)}.`,
		);
	}
	if (jsonEachThreshold > max) {
		throw new CompileError(
			`jsonEachThreshold (${jsonEachThreshold}) exceeds maxParams (${max}); arrays between the two would `
				+ 'bind one parameter per value and overflow the budget. Set it at or below maxParams.',
		);
	}
	return { maxParams: max, jsonEachThreshold };
};

const paramToken = (ctx: RenderContext | undefined): string => ctx?.paramToken ?? '?';

/** A node that knows how to render itself into a {@link Query}. */
export interface SQLChunk<T = unknown> {
	toQuery(ctx?: RenderContext): Query;
	/** Phantom: the TypeScript type this fragment produces when selected. */
	readonly $type?: T;
}

/**
 * True for anything that can render as SQL — including a Drizzle fragment,
 * which has no `toQuery` of our shape. Rendering always goes through
 * {@link render}, never `chunk.toQuery` directly, so the two stay in step.
 */
export const isSQLChunk = (value: unknown): value is SQLChunk =>
	typeof value === 'object' && value !== null
	&& (typeof (value as SQLChunk).toQuery === 'function' || isForeignSQL(value));

/** A bare identifier (table or column name) that must be quoted, not bound. */
export class Identifier implements SQLChunk {
	constructor(readonly name: string) {}

	toQuery(): Query {
		return { sql: quoteIdentifier(this.name), params: [] };
	}
}

/** SQLite quotes identifiers with double quotes; `"` is escaped by doubling. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Raw, un-escaped SQL. Never build this from user input. */
export class Raw implements SQLChunk {
	constructor(readonly value: string) {}

	toQuery(): Query {
		return { sql: this.value, params: [] };
	}
}

/** A named value supplied at execution time rather than at build time. */
export class Placeholder<T = unknown> implements SQLChunk<T> {
	declare readonly $type?: T;

	constructor(readonly name: string, private readonly encode?: (value: unknown) => D1Param) {}

	/** @internal Re-tag with the encoder of the column it is compared against. */
	withEncoder(encode: ((value: unknown) => D1Param) | undefined): Placeholder<T> {
		return this.encode || !encode ? this : new Placeholder<T>(this.name, encode);
	}

	toQuery(ctx?: RenderContext): Query {
		return {
			sql: paramToken(ctx),
			params: [this.encode ? { k: 'ph', name: this.name, encode: this.encode } : { k: 'ph', name: this.name }],
		};
	}
}

/** Declare a named placeholder: `where(eq(users.id, ph('id')))`. */
export const ph = <T = unknown>(name: string): Placeholder<T> => new Placeholder<T>(name);

export const isPlaceholder = (value: unknown): value is Placeholder => value instanceof Placeholder;

/** A single bound value, already encoded for the driver. */
export class Param implements SQLChunk {
	constructor(readonly slot: ParamSlot) {}

	toQuery(ctx?: RenderContext): Query {
		return { sql: paramToken(ctx), params: [this.slot] };
	}
}

/** A value produced fresh on every execution (`$defaultFn`, `$onUpdate`). */
export const paramFn = (fn: () => unknown, encode?: (value: unknown) => D1Param): Param =>
	new Param(encode ? { k: 'fn', fn, encode } : { k: 'fn', fn });

export const param = (value: D1Param): Param => new Param({ k: 'const', v: value });

class SQL<T = unknown> implements SQLChunk<T> {
	declare readonly $type?: T;

	constructor(
		private readonly strings: readonly string[],
		private readonly values: readonly unknown[],
	) {}

	toQuery(ctx: RenderContext = defaultRenderContext): Query {
		let text = '';
		const params: ParamSlot[] = [];

		const emit = (value: unknown): void => {
			if (value === undefined) return;
			if (isSQLChunk(value)) {
				const nested = render(value, ctx);
				text += nested.sql;
				params.push(...nested.params);
			} else if (Array.isArray(value)) {
				// An empty array renders `()`, matching `drizzle-orm` exactly (see
				// `docs/04`'s reverse-alias invariant — diverging here would break
				// it). In a DDL predicate that is not safe the way it is at
				// runtime: `x not in ()` is unconditionally true and `x in ()` is
				// unconditionally false, so a CHECK or partial-index `where` built
				// from an empty array goes permanently inert instead of failing
				// loudly. `orm-d1-kit generate` is where that can actually be
				// refused (`src/ddl.ts`, Node, free to throw); this module ships to
				// the Worker and stays silent — `ctx.onEmptyArrayPredicate` is an
				// optional structural hook the DDL path supplies, a no-op call when
				// absent, so production pays nothing.
				if (value.length === 0 && ctx.bareColumns) ctx.onEmptyArrayPredicate?.();
				text += '(';
				for (const [j, item] of value.entries()) {
					if (j > 0) text += ', ';
					emit(item);
				}
				text += ')';
			} else {
				text += paramToken(ctx);
				params.push({ k: 'const', v: value as D1Param });
			}
		};

		for (let i = 0; i < this.strings.length; i++) {
			text += this.strings[i]!;
			if (i >= this.values.length) continue;
			emit(this.values[i]);
		}

		return { sql: text, params };
	}
}

export interface SQLTag {
	<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SQLChunk<T>;
	identifier(name: string): Identifier;
	raw(value: string): Raw;
	join(chunks: readonly SQLChunk[], separator?: string | SQLChunk): SQLChunk;
	empty(): SQLChunk;
	placeholder<T = unknown>(name: string): Placeholder<T>;
}

/**
 * Template tag for composing SQL. Interpolated values become bound `?`
 * parameters unless they are themselves SQL chunks, which are inlined.
 *
 * ```ts
 * sql`select * from ${users} where ${users.id} = ${42}`
 * ```
 */
export const sql: SQLTag = Object.assign(
	<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SQLChunk<T> =>
		new SQL<T>(strings as unknown as readonly string[], values),
	{
		identifier: (name: string): Identifier => new Identifier(name),
		raw: (value: string): Raw => new Raw(value),
		placeholder: <T = unknown>(name: string): Placeholder<T> => new Placeholder<T>(name),
		empty: (): SQLChunk => new Raw(''),
		/** Join chunks with a separator. */
		join: (chunks: readonly SQLChunk[], separator?: string | SQLChunk): SQLChunk => {
			const sep = typeof separator === 'string' ? separator : undefined;
			if (sep !== undefined) {
				const strings = ['', ...chunks.slice(1).map(() => sep), ''];
				return new SQL(strings, chunks);
			}
			const interleaved: unknown[] = [];
			for (const [i, chunk] of chunks.entries()) {
				if (i > 0) interleaved.push(separator);
				interleaved.push(chunk);
			}
			return new SQL(['', ...interleaved.map(() => '')], interleaved);
		},
	},
);
