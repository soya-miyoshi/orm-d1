/**
 * The `__DEV__` flag and the diagnostics behind it.
 *
 * Bundlers replace a bare `__DEV__` with `false` in production builds, so the
 * branches below are dropped along with their message strings. Where no
 * replacement happens, the flag falls back to an explicit opt-in.
 */
declare const __DEV__: boolean | undefined;

let devEnabled = typeof __DEV__ !== 'undefined'
	? Boolean(__DEV__)
	: Boolean((globalThis as { __D1ZZLE_DEV__?: boolean }).__D1ZZLE_DEV__);

export const isDev = (): boolean => devEnabled;

/** Turn diagnostics on or off explicitly (tests, local development). */
export const setDev = (enabled: boolean): void => {
	devEnabled = enabled;
};

export type Warn = (message: string) => void;

let warnFn: Warn = (message) => {
	console.warn(`[d1zzle] ${message}`);
};

export const setWarn = (fn: Warn): void => {
	warnFn = fn;
};

export const warn = (message: string): void => {
	if (devEnabled) warnFn(message);
};

/**
 * Assert that the header D1 returned matches the projection we compiled.
 * Catches aliasing and index drift during development at zero production cost.
 */
export const assertHeader = (expected: readonly string[], actual: readonly string[]): void => {
	if (expected.length !== actual.length || expected.some((name, i) => name !== actual[i])) {
		warn(
			// No "please report it": the project is unmaintained and nobody is
			// reading reports (see CONTRIBUTING.md). Pointing at a channel that
			// does not answer wastes the time of whoever hit this, so the message
			// names the place to look in the fork they are running instead.
			`Projection mismatch: compiled [${expected.join(', ')}] but D1 returned [${actual.join(', ')}]. `
				+ 'This is a d1zzle bug — the projection is built in plan/compile.ts.',
		);
	}
};

/** The cheapest possible missing-index detector. */
export const assertScan = (rowsRead: number, rowsReturned: number, sql: string): void => {
	if (rowsRead > 100 && rowsRead > rowsReturned * 10) {
		warn(
			`Read ${rowsRead} rows to return ${rowsReturned}. This looks like a full scan; `
				+ `consider an index. ${sql}`,
		);
	}
};
