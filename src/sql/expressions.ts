import { CompileError } from '../errors.js';
import { exceedsBytes, MAX_PATTERN_BYTES } from '../limits.js';
import type { Column } from '../schema/columns.js';
import { isColumn } from '../schema/columns.js';
import type { D1Param, Query, RenderContext, SQLChunk } from './sql.js';
import { defaultRenderContext, isPlaceholder, isSQLChunk, Param, Placeholder, sql } from './sql.js';

/** A boolean-valued SQL fragment. */
export type Condition = SQLChunk<boolean>;

/** Anything comparable: a column, a nested query, or a raw fragment. */
export type Operand<T = unknown> = Column<any> | SQLChunk<T>;

/** A value on the right-hand side of a comparison. */
export type Value<T> = T | Placeholder<T> | SQLChunk<T> | Column<any>;

/** Values with no faithful JSON spelling, which rules out the `json_each` path. */
const isBinary = (value: unknown): boolean =>
	value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);

const encoderOf = (operand: unknown): ((value: unknown) => D1Param) | undefined =>
	isColumn(operand) ? operand.config.encode : undefined;

/**
 * Whether `inArray(operand, values)` can collapse to a single `json_each`
 * parameter, given a long enough array.
 *
 * `json_each` needs a JSON array, and a blob has no JSON spelling —
 * `JSON.stringify(new Uint8Array([1]))` is `{"0":1}`, which matches nothing.
 * Below the threshold the same values bind correctly as blobs, so the strategy
 * switch would silently change the answer; binary values are bound instead.
 *
 * Exported because "one parameter" versus "one parameter per value" is the
 * difference between needing to chunk and not, and the callers that chunk sit
 * above this module. They must not assume a single-column key is free.
 */
export const collapsesToJsonEach = (operand: unknown, values: readonly unknown[]): boolean => {
	const encode = encoderOf(operand);
	return !values.some((v) => isBinary(v) || (encode ? isBinary(encode(v)) : false));
};

/**
 * Turn the right-hand side of a comparison into a chunk, encoding plain values
 * with the encoder belonging to the left-hand column (rule R6).
 */
export const bindValue = (against: unknown, value: unknown): SQLChunk => {
	const encode = encoderOf(against);
	if (isPlaceholder(value)) return value.withEncoder(encode);
	if (isSQLChunk(value)) return value;
	if (value === null) return new Param({ k: 'const', v: null });
	return new Param({ k: 'const', v: encode ? encode(value) : (value as D1Param) });
};

const binary = (operator: string) => <T>(left: Operand<T>, right: Value<T>): Condition =>
	sql<boolean>`${left} ${sql.raw(operator)} ${bindValue(left, right)}`;

export const eq = binary('=');
export const ne = binary('<>');
export const gt = binary('>');
export const gte = binary('>=');
export const lt = binary('<');
export const lte = binary('<=');
/**
 * `like` and `glob`, whose right-hand side D1 caps at 50 bytes.
 *
 * Only a literal pattern can be checked: a `ph()` placeholder is filled after
 * compilation and a column or fragment is evaluated by SQLite, so those are
 * left to the database. That is the honest limit of a compile-time check, and
 * it still catches the case people actually write — a pattern spelled out at
 * the call site.
 */
const patternBinary = (operator: string) => <T>(left: Operand<T>, right: Value<T>): Condition => {
	if (typeof right === 'string' && exceedsBytes(right, MAX_PATTERN_BYTES)) {
		throw new CompileError(
			`A ${operator.replace('not ', '')} pattern of ${right.length} characters exceeds D1's `
				+ `${MAX_PATTERN_BYTES}-byte limit. Narrow the pattern, or match with a different predicate — `
				+ 'a long literal prefix is usually better expressed as a range on an indexed column.',
		);
	}
	return sql<boolean>`${left} ${sql.raw(operator)} ${bindValue(left, right)}`;
};

export const like = patternBinary('like');
export const notLike = patternBinary('not like');
/** SQLite's `like` is already case-insensitive for ASCII; provided for parity. */
export const ilike = patternBinary('like');
export const notIlike = patternBinary('not like');
export const glob = patternBinary('glob');

export const isNull = (operand: Operand): Condition => sql<boolean>`${operand} is null`;
export const isNotNull = (operand: Operand): Condition => sql<boolean>`${operand} is not null`;

const combine = (keyword: string) =>
(...conditions: (Condition | undefined)[]): Condition | undefined => {
	const present = conditions.filter((c): c is Condition => c !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0]!;
	return sql<boolean>`(${sql.join(present.map((c) => sql`(${c})`), ` ${keyword} `)})`;
};

export const and = combine('and');
export const or = combine('or');

export const not = (condition: Condition): Condition => sql<boolean>`not (${condition})`;

export const between = <T>(operand: Operand<T>, low: Value<T>, high: Value<T>): Condition =>
	sql<boolean>`${operand} between ${bindValue(operand, low)} and ${bindValue(operand, high)}`;

export const notBetween = <T>(operand: Operand<T>, low: Value<T>, high: Value<T>): Condition =>
	sql<boolean>`${operand} not between ${bindValue(operand, low)} and ${bindValue(operand, high)}`;

export const exists = (subquery: SQLChunk): Condition => sql<boolean>`exists (${subquery})`;
export const notExists = (subquery: SQLChunk): Condition => sql<boolean>`not exists (${subquery})`;

/**
 * `in (…)`.
 *
 * A long list would blow D1's ~100 bound-parameter budget, so above a
 * threshold this renders as `json_each` over a single JSON parameter. The SQL
 * text stays stable regardless of array length, so it still memoizes.
 */
class InArray implements SQLChunk<boolean> {
	constructor(
		private readonly operand: Operand,
		private readonly values: readonly unknown[] | SQLChunk,
		private readonly negated: boolean,
	) {}

	toQuery(ctx: RenderContext = defaultRenderContext): Query {
		const keyword = this.negated ? 'not in' : 'in';

		if (isSQLChunk(this.values)) {
			return sql<boolean>`${this.operand} ${sql.raw(keyword)} (${this.values})`.toQuery(ctx);
		}

		if (this.values.length === 0) {
			// `x in ()` is a syntax error; an empty set is simply never/always true
			// for an ordinary query, so this still short-circuits for correctness
			// and performance there. Under DDL rendering (`ctx.bareColumns`) that
			// same rewrite would make a check()/partial-index predicate
			// permanently inert, so it goes through the same refusal hook
			// `src/sql/sql.ts`'s own empty-array handling uses instead of
			// returning a bare literal that the DDL scan can never see —
			// `src/ddl.ts` supplies the hook only while generating DDL and
			// throws from it; this module ships to the Worker and stays a
			// no-op call in production.
			if (ctx.bareColumns) ctx.onEmptyArrayPredicate?.();
			return { sql: this.negated ? '1 = 1' : '1 = 0', params: [] };
		}

		const encode = encoderOf(this.operand);
		const jsonable = collapsesToJsonEach(this.operand, this.values);

		if (this.values.length >= ctx.jsonEachThreshold && jsonable) {
			const payload = JSON.stringify(this.values.map((v) => (encode ? encode(v) : v)));
			return sql<boolean>`${this.operand} ${sql.raw(keyword)} (select "value" from json_each(${payload}))`
				.toQuery(ctx);
		}

		// Every value binds. `inArray` cannot chunk itself — it is one condition
		// inside somebody else's statement — so the only honest thing left is to
		// name the budget, the way `compileInsert` does for a too-wide row.
		// Otherwise this surfaces as a bare `too many SQL variables` from SQLite,
		// which does not say which call produced it.
		if (this.values.length > ctx.maxParams) {
			throw new CompileError(
				`${keyword === 'in' ? 'inArray' : 'notInArray'}() was given ${this.values.length} values, which `
					+ `exceeds the bound-parameter limit of ${ctx.maxParams}`
					+ (jsonable
						? `. They would normally collapse to a single json_each parameter, but the array is `
							+ `shorter than jsonEachThreshold (${ctx.jsonEachThreshold}).`
						: ', and binary values have no json_each spelling to collapse into. '
							+ 'Split the call, or match against a subquery instead of a literal array.'),
			);
		}

		const chunks = this.values.map((v) => bindValue(this.operand, v));
		return sql<boolean>`${this.operand} ${sql.raw(keyword)} (${sql.join(chunks, ', ')})`.toQuery(ctx);
	}
}

export const inArray = <T>(operand: Operand<T>, values: readonly T[] | SQLChunk): Condition =>
	new InArray(operand, values as readonly unknown[] | SQLChunk, false);

export const notInArray = <T>(operand: Operand<T>, values: readonly T[] | SQLChunk): Condition =>
	new InArray(operand, values as readonly unknown[] | SQLChunk, true);

// ---------------------------------------------------------------- ordering

export const asc = (operand: Operand): SQLChunk => sql`${operand} asc`;
export const desc = (operand: Operand): SQLChunk => sql`${operand} desc`;

// ------------------------------------------------------------- arithmetic

export const add = <T>(left: Operand<T>, right: Value<T>): SQLChunk<number> =>
	sql<number>`(${left} + ${bindValue(left, right)})`;
export const subtract = <T>(left: Operand<T>, right: Value<T>): SQLChunk<number> =>
	sql<number>`(${left} - ${bindValue(left, right)})`;
export const multiply = <T>(left: Operand<T>, right: Value<T>): SQLChunk<number> =>
	sql<number>`(${left} * ${bindValue(left, right)})`;
export const divide = <T>(left: Operand<T>, right: Value<T>): SQLChunk<number> =>
	sql<number>`(${left} / ${bindValue(left, right)})`;
