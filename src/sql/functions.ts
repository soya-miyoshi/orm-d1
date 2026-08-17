import { CompileError } from '../errors.js';
import { MAX_FUNCTION_ARGS } from '../limits.js';
import type { Column } from '../schema/columns.js';
import { isColumn } from '../schema/columns.js';
import type { Query, RenderContext, SQLChunk } from './sql.js';
import { render, sql } from './sql.js';

/**
 * A fragment that also knows how to decode its own result. The row mapper
 * looks for `decode`; expressions without one are passed through untouched.
 */
export interface DecodedChunk<T> extends SQLChunk<T> {
	readonly decode: (value: unknown) => unknown;
}

export const withDecode = <T>(chunk: SQLChunk, decode: (value: unknown) => unknown): DecodedChunk<T> => ({
	toQuery: (ctx?: RenderContext): Query => render(chunk, ctx),
	decode,
});

export const hasDecode = (value: unknown): value is DecodedChunk<unknown> =>
	typeof (value as DecodedChunk<unknown>)?.decode === 'function';

const passthroughDecoder = (operand: unknown): ((value: unknown) => unknown) | undefined =>
	isColumn(operand) ? operand.config.decode : undefined;

const nullable = (decode: ((value: unknown) => unknown) | undefined) => (value: unknown) =>
	value === null || value === undefined ? null : decode ? decode(value) : value;

export const count = (operand?: Column<any> | SQLChunk): DecodedChunk<number> =>
	withDecode<number>(operand ? sql`count(${operand})` : sql`count(*)`, Number);

export const countDistinct = (operand: Column<any> | SQLChunk): DecodedChunk<number> =>
	withDecode<number>(sql`count(distinct ${operand})`, Number);

// Drizzle deliberately decodes `sum`/`avg` to `string` in every dialect
// (`drizzle-orm/sql/functions/aggregate.js`, `.mapWith(String)`): a 64-bit sum
// does not survive an IEEE double. See `[F-009]` in `AUDIT.md`.
export const sum = (operand: Column<any> | SQLChunk): DecodedChunk<string | null> =>
	withDecode<string | null>(sql`sum(${operand})`, nullable(String));

export const avg = (operand: Column<any> | SQLChunk): DecodedChunk<string | null> =>
	withDecode<string | null>(sql`avg(${operand})`, nullable(String));

// Real drizzle-orm: `.mapWith(is(expression, Column) ? expression : String)`
// (`drizzle-orm/sql/functions/aggregate.js`) — a Column operand decodes
// through its own column type, but anything else (a raw `sql<number>`
// expression, say) decodes through `String`, same as `sum`/`avg` always do.
// `passthroughDecoder` returning `undefined` for a non-Column operand used
// to leave the driver value untouched instead, so `min(sql<number>\`…\`)`
// disagreed with Drizzle's `SQL<string | null>` both in the decoded value
// and in the type.
// A Column operand may have no `decode` configured at all — that still has
// to stay passthrough (identity), not fall back to `String`; only a
// *non*-Column operand decodes through `String`. So this can't reuse
// `passthroughDecoder`'s `undefined` as the "use String" signal — that
// `undefined` is ambiguous between "not a Column" and "a Column with no
// decode".
const minMaxDecoder = (operand: Column<any> | SQLChunk) =>
	isColumn(operand) ? passthroughDecoder(operand) : String;

// Matches Drizzle's own signature
// (`min<T extends SQLWrapper>(e: T): SQL<(T extends AnyColumn ? T['_']['data'] : string) | null>`,
// `drizzle-orm/sql/functions/aggregate.d.ts`): a single generic with a
// DISTRIBUTIVE conditional — a naked `T` in a conditional distributes over
// unions, so a `Column | SQLChunk` operand types as `data | string`, not
// just `string`. An overload pair does NOT distribute: a union operand isn't
// assignable to `C extends Column<any>`, so it falls through to the
// `SQLChunk` overload and the column branch is silently dropped from the
// type — exactly the bug this signature fixes.
export const min = <T extends Column<any> | SQLChunk>(
	operand: T,
): DecodedChunk<(T extends Column<any> ? T['_']['data'] : string) | null> =>
	withDecode(sql`min(${operand})`, nullable(minMaxDecoder(operand)));

export const max = <T extends Column<any> | SQLChunk>(
	operand: T,
): DecodedChunk<(T extends Column<any> ? T['_']['data'] : string) | null> =>
	withDecode(sql`max(${operand})`, nullable(minMaxDecoder(operand)));

export const coalesce = <T>(...operands: (Column<any> | SQLChunk<T> | T)[]): SQLChunk<T> => {
	// D1 caps any single SQL function at 32 arguments. `coalesce` is the only
	// variadic one orm-d1 builds, and this fires at the call site rather than
	// as a bare "too many arguments on function coalesce" from SQLite.
	if (operands.length > MAX_FUNCTION_ARGS) {
		throw new CompileError(
			`coalesce() was given ${operands.length} arguments, which exceeds D1's limit of `
				+ `${MAX_FUNCTION_ARGS} per SQL function. Nest the calls — coalesce(a, …, coalesce(…)) — `
				+ 'or reduce the list.',
		);
	}
	return sql<T>`coalesce(${sql.join(operands as SQLChunk[], ', ')})`;
};

export const lower = (operand: Column<any> | SQLChunk): SQLChunk<string> => sql<string>`lower(${operand})`;
export const upper = (operand: Column<any> | SQLChunk): SQLChunk<string> => sql<string>`upper(${operand})`;
export const length = (operand: Column<any> | SQLChunk): DecodedChunk<number> =>
	withDecode<number>(sql`length(${operand})`, Number);
