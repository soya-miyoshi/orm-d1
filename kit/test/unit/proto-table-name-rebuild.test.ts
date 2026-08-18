/**
 * [Finding 2] `driftBetween` (`check`/`push`/`verify`) used to throw
 * `TypeError: value.replace is not a function` for a live table whose name is
 * a JS `Object.prototype` member (`constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__`) when that table needs a rebuild.
 * `diffSnapshots`'s `liveTableNames` was a plain `{}`; `liveTableNames[name]
 * ?? name` on a table named e.g. `constructor` resolved the inherited
 * `Object` function (truthy, so `??` never fired), and that non-string value
 * reached `lookupCaseInsensitive` -> `foldAsciiCase`, which calls
 * `.replace` on it.
 */
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable, text } from 'orm-d1';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import type { Snapshot } from '../../src/core/snapshot.js';

const prototypeNames = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('diffSnapshots does not throw for a prototype-named table forced through a rebuild', () => {
	for (const name of prototypeNames) {
		it(`handles a live table named "${name}" needing a v text -> v integer rebuild`, () => {
			const before = sqliteTable(name, { id: integer('id').primaryKey(), v: text('v') });
			const after = sqliteTable(name, { id: integer('id').primaryKey(), v: integer('v') });

			const liveBefore: Snapshot = { ...snapshotFromSchema([before]), origin: 'introspection' };
			const schemaAfter = snapshotFromSchema([after]);

			expect(() => diffSnapshots(liveBefore, schemaAfter, { foreignTriggers: {} })).not.toThrow();
			const { errors } = diffSnapshots(liveBefore, schemaAfter, { foreignTriggers: {} });
			expect(errors).toEqual([]);
		});
	}
});
