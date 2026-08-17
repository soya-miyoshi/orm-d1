/**
 * `assertSameDrizzle` — see `[F-095]` in `AUDIT.md`.
 *
 * The negative direction (two actually-different `drizzle-orm` copies) cannot
 * be hosted in this repo without installing two copies of the package; this
 * only proves the positive path — the recipe passes under a single resolved
 * copy — which is what actually ships to an adopter's test suite.
 */
import { Many } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assertSameDrizzle } from '../../src/drizzle.js';

describe('assertSameDrizzle', () => {
	it('does not throw when the caller resolved the same drizzle-orm copy', () => {
		expect(() => assertSameDrizzle({ Many })).not.toThrow();
	});

	it('throws when the passed Many does not match the one orm-d1 resolved', () => {
		class FakeMany {}
		expect(() => assertSameDrizzle({ Many: FakeMany })).toThrow(/different `drizzle-orm` copy/);
	});
});
