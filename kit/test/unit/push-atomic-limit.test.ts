/**
 * [F-116] `push` used to pack every batch at the hardcoded
 * `MAX_STATEMENTS_PER_BATCH`, never asking the runner it was about to call —
 * unlike `applyMigration` (`apply.ts`), which already asks
 * `runner.atomicLimit?.(statements) ?? MAX_STATEMENTS_PER_BATCH`. A runner
 * whose real ceiling differs from the constant (a stricter `/query` cap, or
 * an effectively unbounded file-import route) either got split when it did
 * not need to, or packed at a limit it could not actually honour.
 *
 * `localRunner` is replaced with a fake here so the test can give it a small,
 * distinctive `atomicLimit` unrelated to `MAX_STATEMENTS_PER_BATCH` (100) and
 * observe how `push` actually chunks its batches.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const schemaImport = (): string => new URL('../../../src/index.ts', import.meta.url).pathname;

const batches: string[][] = [];
const fakeAtomicLimit = 2;

vi.mock('../../src/node/runners.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/node/runners.js')>();
	return {
		...actual,
		localRunner: async () => ({
			all: async () => [],
			batch: async (statements: readonly string[]) => {
				batches.push([...statements]);
			},
			atomicLimit: () => fakeAtomicLimit,
		}),
	};
});

const { push } = await import('../../src/node/commands.js');
type Config = import('../../src/node/config.js').Config;

describe('push', () => {
	afterEach(() => {
		batches.length = 0;
	});

	it('[F-116] packs batches at the runner\'s own atomicLimit, not MAX_STATEMENTS_PER_BATCH', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'orm-d1-push-'));
		// Five plain tables against an empty live database: five `create table`
		// statements, enough to need splitting at a limit of 2 but nowhere near
		// the real constant of 100 — proof either way has to come from the limit
		// actually used, not from whether a split happened at all.
		await writeFile(
			join(cwd, 'schema.ts'),
			[
				`import { sqliteTable, integer } from '${schemaImport()}';`,
				...['a', 'b', 'c', 'd', 'e'].map(
					(t) => `export const ${t} = sqliteTable('${t}', { id: integer('id').primaryKey() });`,
				),
			].join('\n'),
		);

		const config = { schema: './schema.ts', out: join(cwd, 'migrations'), d1: {} } as Config;
		const ctx = { cwd, config, log: () => {}, now: () => 0 };

		await push(ctx);

		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(fakeAtomicLimit);
		// Not the hardcoded constant: at least one batch actually uses the small
		// limit, rather than happening to fit under 100 in one batch.
		expect(batches.some((b) => b.length === fakeAtomicLimit)).toBe(true);
	});
});
