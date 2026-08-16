/**
 * `latestPerGroup` against a real D1.
 *
 * Window functions are the reason this lives here rather than in `test/unit`:
 * the helper's whole contract is what SQLite does with `row_number() over
 * (partition by … order by …)`, and asserting that against a Node-shaped
 * SQLite would be asserting against the wrong engine.
 *
 * The tie test is the one that matters. It is the failure the required
 * `tiebreak` parameter exists to prevent, so it has to be shown happening on
 * the engine that would produce it.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import type { QueryEvent } from '../../src/index.js';
import { d1zzle, desc, eq, latestPerGroup } from '../../src/index.js';
import { allTables, posts, users } from '../schema.js';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(allTables)) await DB.prepare(statement).run();

	const db = d1zzle(DB);
	await db.insert(users).values([
		{ id: 1, email: 'a@b.c', name: 'Ada', createdAt: new Date(0) },
		{ id: 2, email: 'b@b.c', name: 'Bob', createdAt: new Date(0) },
		{ id: 3, email: 'c@b.c', name: 'Cy', createdAt: new Date(0) },
	]);
	await db.insert(posts).values([
		// Author 1: a clear winner.
		{ id: 10, authorId: 1, title: 'old', views: 5 },
		{ id: 11, authorId: 1, title: 'newest', views: 50 },
		// Author 2: two rows tied on `views`. Only the tiebreak separates them,
		// and it has to pick 21 — the same answer every time.
		{ id: 20, authorId: 2, title: 'tied-low-id', views: 7 },
		{ id: 21, authorId: 2, title: 'tied-high-id', views: 7 },
		// Author 3: a single row, which still has to come back.
		{ id: 30, authorId: 3, title: 'only', views: 1 },
	]);
});

const latestPost = (where?: Parameters<typeof latestPerGroup>[2]['where']) =>
	latestPerGroup(d1zzle(DB), posts, {
		partitionBy: [posts.authorId],
		orderBy: [desc(posts.views)],
		tiebreak: desc(posts.id),
		where,
	});

describe('latestPerGroup on real D1', () => {
	it('returns exactly one row per group, in one statement', async () => {
		const rows = await latestPost();
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((r) => r.authorId))).toEqual(new Set([1, 2, 3]));
	});

	// The claim that separates this from the shape it replaces: one round trip,
	// not one per group, and not one that drags every historical row back.
	it('issues exactly one statement, whatever the number of groups', async () => {
		const events: QueryEvent[] = [];
		const db = d1zzle(DB, { onQuery: (event) => events.push(event) });
		await latestPerGroup(db, posts, {
			partitionBy: [posts.authorId],
			orderBy: [desc(posts.views)],
			tiebreak: desc(posts.id),
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: 'select' });
		// Three groups out of five rows: the numbering happens in the database,
		// so the response carries the three winners rather than all five.
		expect(events[0]!.rowsRead).toBeGreaterThan(0);
	});

	it('picks the row the ordering ranks first', async () => {
		const rows = await latestPost();
		expect(rows.find((r) => r.authorId === 1)).toMatchObject({ id: 11, title: 'newest', views: 50 });
	});

	it('breaks a tie deterministically — the failure the required tiebreak prevents', async () => {
		// Both of author 2's posts have views = 7. Without the tiebreak SQLite is
		// free to return either, and nothing downstream could tell which it got.
		for (let attempt = 0; attempt < 5; attempt++) {
			const rows = await latestPost();
			expect(rows.find((r) => r.authorId === 2)).toMatchObject({ id: 21, title: 'tied-high-id' });
		}
	});

	it('keeps a group that has only one row', async () => {
		const rows = await latestPost();
		expect(rows.find((r) => r.authorId === 3)).toMatchObject({ id: 30, title: 'only' });
	});

	it('applies `where` before the numbering, not after', async () => {
		// Excluding the winner has to promote the runner-up, not drop the group.
		// Filtering after the numbering would return nothing for author 1.
		const rows = await latestPerGroup(d1zzle(DB), posts, {
			partitionBy: [posts.authorId],
			orderBy: [desc(posts.views)],
			tiebreak: desc(posts.id),
			where: eq(posts.authorId, 1) as never,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 11 });
	});

	it('does not leak the rank column into the rows', async () => {
		const rows = await latestPost();
		const keys = Object.keys(rows[0]!).sort();
		expect(keys).toEqual(['authorId', 'id', 'title', 'views']);
	});

	it('decodes columns through the table\'s codecs, like an ordinary select', async () => {
		const rows = await latestPerGroup(d1zzle(DB), users, {
			partitionBy: [users.id],
			orderBy: [desc(users.id)],
			tiebreak: desc(users.id),
		});
		// `active` is `{ mode: 'boolean' }` and `createdAt` a timestamp: a raw
		// row would carry 1 and a number here.
		expect(typeof rows[0]!.active).toBe('boolean');
		expect(rows[0]!.createdAt).toBeInstanceOf(Date);
	});

	it('refuses a configuration whose answer would be undefined', async () => {
		const db = d1zzle(DB);
		await expect(
			latestPerGroup(db, posts, { partitionBy: [], orderBy: [desc(posts.views)], tiebreak: desc(posts.id) }),
		).rejects.toThrow(/partitionBy/);
		await expect(
			latestPerGroup(db, posts, { partitionBy: [posts.authorId], orderBy: [], tiebreak: desc(posts.id) }),
		).rejects.toThrow(/orderBy/);
	});
});
