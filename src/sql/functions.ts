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

export const sum = (operand: Column<any> | SQLChunk): DecodedChunk<number | null> =>
	withDecode<number | null>(sql`sum(${operand})`, nullable(Number));

export const avg = (operand: Column<any> | SQLChunk): DecodedChunk<number | null> =>
	withDecode<number | null>(sql`avg(${operand})`, nullable(Number));

export const min = <T>(operand: Column<any> | SQLChunk<T>): DecodedChunk<T | null> =>
	withDecode<T | null>(sql`min(${operand})`, nullable(passthroughDecoder(operand)));

export const max = <T>(operand: Column<any> | SQLChunk<T>): DecodedChunk<T | null> =>
	withDecode<T | null>(sql`max(${operand})`, nullable(passthroughDecoder(operand)));

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
