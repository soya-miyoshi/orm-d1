/**
 * The Better Auth adapter, against a real D1 binding.
 *
 * Driven through `createAdapterFactory`'s wrapper rather than the raw
 * `CustomAdapter`, because that is the only honest test: the wrapper is what
 * generates ids, applies defaults, maps `image` onto whatever column the
 * project actually stores it in, and converts values on the way in and out.
 * Calling the inner methods directly would test our SQL and skip the contract.
 */
import { env } from 'cloudflare:test';
import type { BetterAuthOptions } from 'better-auth/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1zzleAdapter } from '../../src/better-auth.js';
import { createSchema } from '../../src/ddl.js';
import { d1zzle, integer, sqliteTable, text } from '../../src/index.js';

const DB = (env as { DB: D1Database }).DB;

// ------------------------------------------------------------------ fixture

/**
 * Better Auth's four core models as a d1zzle schema.
 *
 * Deliberately awkward in the two ways a real project is: the table is named
 * `customers` rather than `user`, and `image` is stored on an `avatar_url`
 * column reached through a `fields` override. If either mapping leaked, every
 * assertion below would fail.
 */
const user = sqliteTable('customers', {
	id: text('id').primaryKey(),
	name: text('name'),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	avatarUrl: text('avatar_url'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
	token: text('token').notNull().unique(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
	refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
	// Not a Better Auth core field — declared as an `additionalField` below so
	// `incrementOne` has a counter to guard.
	attempts: integer('attempts').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

const tables = [user, session, account, verification];

const options = {
	user: { fields: { image: 'avatarUrl' } },
	verification: {
		additionalFields: { attempts: { type: 'number', required: false, input: false } },
	},
} satisfies BetterAuthOptions;

const db = d1zzle(DB);

const makeAdapter = () =>
	d1zzleAdapter(db, { schema: { user, session, account, verification } })(options);

const reset = async (): Promise<void> => {
	for (const name of ['verification', 'account', 'session', 'customers']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(tables)) await DB.prepare(statement).run();
};

/** A user row through the adapter, so ids and defaults come from Better Auth. */
const createUser = async (
	adapter: ReturnType<typeof makeAdapter>,
	data: Record<string, unknown>,
): Promise<Record<string, any>> =>
	adapter.create({ model: 'user', data: data as never }) as Promise<Record<string, any>>;

beforeEach(async () => {
	await reset();
});

// -------------------------------------------------------------------- tests

describe('create', () => {
	it('inserts, generates the id, and reads the row back in Better Auth shapes', async () => {
		const adapter = makeAdapter();
		const created = await createUser(adapter, {
			name: 'Ada',
			email: 'ada@example.com',
			emailVerified: true,
			image: 'https://cdn.example.com/ada.png',
		});

		expect(typeof created.id).toBe('string');
		expect(created.id.length).toBeGreaterThan(0);
		expect(created.name).toBe('Ada');
		expect(created.emailVerified).toBe(true);
		// The model field is `image`; the column is `avatar_url`.
		expect(created.image).toBe('https://cdn.example.com/ada.png');
		expect(created.createdAt).toBeInstanceOf(Date);

		const raw = await DB.prepare('select * from "customers"').first<Record<string, unknown>>();
		expect(raw?.avatar_url).toBe('https://cdn.example.com/ada.png');
		expect(raw?.email_verified).toBe(1);
		expect(typeof raw?.created_at).toBe('number');
	});

	/**
	 * A field the *Better Auth schema* knows about but the d1zzle table has no
	 * column for. A field neither of them knows about never reaches the adapter —
	 * the factory drops it during input transform — so this is the only shape of
	 * this mistake we can be asked about, and it is the one a half-finished
	 * `additionalFields` produces.
	 */
	it('names an unbacked field, and the table, rather than failing at D1', async () => {
		const adapter = d1zzleAdapter(db, { schema: { user, session, account, verification } })({
			...options,
			user: {
				fields: { image: 'avatarUrl' },
				additionalFields: { nickname: { type: 'string', required: false } },
			},
		} satisfies BetterAuthOptions);

		await expect(
			adapter.create({ model: 'user', data: { email: 'x@y.z', nickname: 'ada' } as never }),
		).rejects.toThrow(/nickname[\s\S]*customers/);
	});
});

describe('findOne', () => {
	it('matches on a mapped field and returns null when nothing matches', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { email: 'ada@example.com', image: 'a.png' });

		const found = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'image', value: 'a.png' }],
		});
		expect(found?.email).toBe('ada@example.com');

		const missing = await adapter.findOne({
			model: 'user',
			where: [{ field: 'email', value: 'nobody@example.com' }],
		});
		expect(missing).toBeNull();
	});

	it('projects only the selected fields', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { name: 'Ada', email: 'ada@example.com' });

		const found = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'email', value: 'ada@example.com' }],
			select: ['email'],
		});
		expect(Object.keys(found ?? {})).toEqual(['email']);
	});

	it('reads null as `is null` rather than `= null`', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { email: 'ada@example.com', name: null });
		await createUser(adapter, { email: 'bob@example.com', name: 'Bob' });

		const nameless = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', value: null }],
		});
		expect(nameless?.email).toBe('ada@example.com');

		const named = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', operator: 'ne', value: null }],
		});
		expect(named?.email).toBe('bob@example.com');
	});
});

describe('findMany', () => {
	const seed = async (adapter: ReturnType<typeof makeAdapter>): Promise<void> => {
		for (const [i, name] of ['Ada', 'Bob', 'Cleo', 'Dara'].entries()) {
			await createUser(adapter, {
				name,
				email: `${name.toLowerCase()}@example.com`,
				createdAt: new Date(1_700_000_000_000 + i * 1000),
			});
		}
	};

	it('sorts, limits and offsets', async () => {
		const adapter = makeAdapter();
		await seed(adapter);

		const rows = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			sortBy: { field: 'name', direction: 'desc' },
			limit: 2,
			offset: 1,
		});
		expect(rows.map((r) => r.name)).toEqual(['Cleo', 'Bob']);
	});

	it('honours in / not_in / contains / starts_with / ends_with', async () => {
		const adapter = makeAdapter();
		await seed(adapter);

		const inSet = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', operator: 'in', value: ['Ada', 'Cleo'] }],
			limit: 10,
			sortBy: { field: 'name', direction: 'asc' },
		});
		expect(inSet.map((r) => r.name)).toEqual(['Ada', 'Cleo']);

		const notInSet = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', operator: 'not_in', value: ['Ada', 'Cleo'] }],
			limit: 10,
			sortBy: { field: 'name', direction: 'asc' },
		});
		expect(notInSet.map((r) => r.name)).toEqual(['Bob', 'Dara']);

		const contains = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'email', operator: 'contains', value: 'leo@' }],
			limit: 10,
		});
		expect(contains.map((r) => r.name)).toEqual(['Cleo']);

		const starts = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', operator: 'starts_with', value: 'D' }],
			limit: 10,
		});
		expect(starts.map((r) => r.name)).toEqual(['Dara']);

		const ends = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'email', operator: 'ends_with', value: 'example.com' }],
			limit: 10,
		});
		expect(ends).toHaveLength(4);
	});

	it('combines an AND group with an OR group', async () => {
		const adapter = makeAdapter();
		await seed(adapter);

		const rows = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [
				{ field: 'email', operator: 'ends_with', value: 'example.com', connector: 'AND' },
				{ field: 'name', value: 'Ada', connector: 'OR' },
				{ field: 'name', value: 'Bob', connector: 'OR' },
			],
			limit: 10,
			sortBy: { field: 'name', direction: 'asc' },
		});
		expect(rows.map((r) => r.name)).toEqual(['Ada', 'Bob']);
	});

	it('folds case when mode is insensitive, and not otherwise', async () => {
		const adapter = makeAdapter();
		await seed(adapter);

		const sensitive = await adapter.findMany({
			model: 'user',
			where: [{ field: 'name', value: 'ada' }],
			limit: 10,
		});
		expect(sensitive).toHaveLength(0);

		const insensitive = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', value: 'ada', mode: 'insensitive' }],
			limit: 10,
		});
		expect(insensitive.map((r) => r.name)).toEqual(['Ada']);

		const insensitiveIn = await adapter.findMany<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'name', operator: 'in', value: ['ADA', 'bob'], mode: 'insensitive' }],
			limit: 10,
			sortBy: { field: 'name', direction: 'asc' },
		});
		expect(insensitiveIn.map((r) => r.name)).toEqual(['Ada', 'Bob']);
	});
});

describe('count', () => {
	it('counts all rows and a filtered subset', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { email: 'ada@example.com', emailVerified: true });
		await createUser(adapter, { email: 'bob@example.com', emailVerified: false });

		expect(await adapter.count({ model: 'user' })).toBe(2);
		expect(
			await adapter.count({ model: 'user', where: [{ field: 'emailVerified', value: true }] }),
		).toBe(1);
	});
});

describe('update / updateMany', () => {
	it('updates one row and returns it', async () => {
		const adapter = makeAdapter();
		const created = await createUser(adapter, { email: 'ada@example.com', name: 'Ada' });

		const updated = await adapter.update<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'id', value: created.id }],
			update: { name: 'Ada L.' },
		});
		expect(updated?.name).toBe('Ada L.');

		const missed = await adapter.update({
			model: 'user',
			where: [{ field: 'id', value: 'nope' }],
			update: { name: 'x' },
		});
		expect(missed).toBeNull();
	});

	it('refuses a whole-table update through `update`', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { email: 'ada@example.com', name: 'Ada' });

		expect(await adapter.update({ model: 'user', where: [], update: { name: 'x' } })).toBeNull();
		const untouched = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'email', value: 'ada@example.com' }],
		});
		expect(untouched?.name).toBe('Ada');
	});

	it('reports the number of rows updateMany changed', async () => {
		const adapter = makeAdapter();
		await createUser(adapter, { email: 'ada@example.com', emailVerified: false });
		await createUser(adapter, { email: 'bob@example.com', emailVerified: false });
		await createUser(adapter, { email: 'cleo@example.com', emailVerified: true });

		const changed = await adapter.updateMany({
			model: 'user',
			where: [{ field: 'emailVerified', value: false }],
			update: { emailVerified: true },
		});
		expect(changed).toBe(2);
		expect(await adapter.count({ model: 'user', where: [{ field: 'emailVerified', value: true }] }))
			.toBe(3);
	});
});

describe('delete / deleteMany', () => {
	it('deletes matching rows and reports the count', async () => {
		const adapter = makeAdapter();
		const ada = await createUser(adapter, { email: 'ada@example.com', emailVerified: true });
		await createUser(adapter, { email: 'bob@example.com', emailVerified: false });
		await createUser(adapter, { email: 'cleo@example.com', emailVerified: false });

		await adapter.delete({ model: 'user', where: [{ field: 'id', value: ada.id }] });
		expect(await adapter.count({ model: 'user' })).toBe(2);

		const removed = await adapter.deleteMany({
			model: 'user',
			where: [{ field: 'emailVerified', value: false }],
		});
		expect(removed).toBe(2);
		expect(await adapter.count({ model: 'user' })).toBe(0);
	});
});

describe('consumeOne', () => {
	const seedVerifications = async (
		adapter: ReturnType<typeof makeAdapter>,
		count: number,
	): Promise<void> => {
		for (let i = 0; i < count; i++) {
			await adapter.create({
				model: 'verification',
				data: {
					identifier: 'otp',
					value: `code-${i}`,
					expiresAt: new Date(1_700_000_000_000),
				} as never,
			});
		}
	};

	it('deletes exactly one row even when the predicate matches several', async () => {
		const adapter = makeAdapter();
		await seedVerifications(adapter, 3);

		const consumed = await adapter.consumeOne<Record<string, unknown>>({
			model: 'verification',
			where: [{ field: 'identifier', value: 'otp' }],
		});
		expect(consumed?.identifier).toBe('otp');
		expect(await adapter.count({ model: 'verification' })).toBe(2);
	});

	it('hands the row to exactly one of two concurrent callers', async () => {
		const adapter = makeAdapter();
		await seedVerifications(adapter, 1);

		const results = await Promise.all([
			adapter.consumeOne<Record<string, unknown>>({
				model: 'verification',
				where: [{ field: 'value', value: 'code-0' }],
			}),
			adapter.consumeOne<Record<string, unknown>>({
				model: 'verification',
				where: [{ field: 'value', value: 'code-0' }],
			}),
		]);

		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await adapter.count({ model: 'verification' })).toBe(0);
	});

	it('returns null when nothing matches', async () => {
		const adapter = makeAdapter();
		expect(
			await adapter.consumeOne({
				model: 'verification',
				where: [{ field: 'value', value: 'absent' }],
			}),
		).toBeNull();
	});
});

describe('incrementOne', () => {
	const seedVerification = async (
		adapter: ReturnType<typeof makeAdapter>,
		attempts: number,
	): Promise<Record<string, any>> =>
		await adapter.create({
			model: 'verification',
			data: {
				identifier: 'otp',
				value: 'code',
				attempts,
				expiresAt: new Date(1_700_000_000_000),
			} as never,
		}) as Record<string, any>;

	it('applies the delta atomically and returns the updated row', async () => {
		const adapter = makeAdapter();
		await seedVerification(adapter, 5);

		const updated = await adapter.incrementOne<Record<string, unknown>>({
			model: 'verification',
			where: [{ field: 'value', value: 'code' }],
			increment: { attempts: -1 },
		});
		expect(updated?.attempts).toBe(4);
	});

	it('treats the where clause as a guard', async () => {
		const adapter = makeAdapter();
		await seedVerification(adapter, 0);

		const blocked = await adapter.incrementOne({
			model: 'verification',
			where: [
				{ field: 'value', value: 'code' },
				{ field: 'attempts', operator: 'gt', value: 0 },
			],
			increment: { attempts: -1 },
		});
		expect(blocked).toBeNull();

		const row = await adapter.findOne<Record<string, unknown>>({
			model: 'verification',
			where: [{ field: 'value', value: 'code' }],
		});
		expect(row?.attempts).toBe(0);
	});

	it('applies `set` alongside the increment, in one statement', async () => {
		const adapter = makeAdapter();
		await seedVerification(adapter, 1);

		const updated = await adapter.incrementOne<Record<string, unknown>>({
			model: 'verification',
			where: [{ field: 'value', value: 'code' }],
			increment: { attempts: 2 },
			set: { identifier: 'otp-used' },
		});
		expect(updated?.attempts).toBe(3);
		expect(updated?.identifier).toBe('otp-used');
	});

	it('does not lose a concurrent decrement', async () => {
		const adapter = makeAdapter();
		await seedVerification(adapter, 10);

		await Promise.all(
			Array.from({ length: 5 }, () =>
				adapter.incrementOne({
					model: 'verification',
					where: [{ field: 'value', value: 'code' }],
					increment: { attempts: -1 },
				})),
		);

		const row = await adapter.findOne<Record<string, unknown>>({
			model: 'verification',
			where: [{ field: 'value', value: 'code' }],
		});
		expect(row?.attempts).toBe(5);
	});
});

describe('the whole four-model shape', () => {
	it('round-trips a user, an account and a session the way sign-in does', async () => {
		const adapter = makeAdapter();

		const created = await createUser(adapter, {
			name: 'Ada',
			email: 'ada@example.com',
			emailVerified: true,
			image: 'a.png',
		});

		// `session.updatedAt` and `account.updatedAt` are `required` but carry only
		// an `onUpdate` default, so Better Auth's own db layer passes them on
		// create. Doing the same here keeps this a test of the adapter rather than
		// of a payload Better Auth never sends.
		const now = new Date(1_700_000_000_000);

		await adapter.create({
			model: 'account',
			data: {
				userId: created.id,
				accountId: 'google-sub-1',
				providerId: 'google',
				accessTokenExpiresAt: new Date(1_700_000_600_000),
				createdAt: now,
				updatedAt: now,
			} as never,
		});

		await adapter.create({
			model: 'session',
			data: {
				userId: created.id,
				token: 'session-token',
				expiresAt: new Date(1_700_003_600_000),
				ipAddress: '203.0.113.1',
				createdAt: now,
				updatedAt: now,
			} as never,
		});

		const found = await adapter.findOne<Record<string, any>>({
			model: 'session',
			where: [{ field: 'token', value: 'session-token' }],
		});
		expect(found?.userId).toBe(created.id);
		expect(found?.expiresAt).toBeInstanceOf(Date);
		expect(found?.expiresAt.getTime()).toBe(1_700_003_600_000);

		const linked = await adapter.findOne<Record<string, any>>({
			model: 'account',
			where: [
				{ field: 'providerId', value: 'google' },
				{ field: 'accountId', value: 'google-sub-1' },
			],
		});
		expect(linked?.userId).toBe(created.id);
		expect(linked?.accessTokenExpiresAt).toBeInstanceOf(Date);
		// Unset nullable columns stay null rather than becoming an epoch Date.
		expect(linked?.refreshTokenExpiresAt).toBeNull();
	});

	it('names the model when it is missing from `schema`', async () => {
		const adapter = d1zzleAdapter(db, { schema: { user } })(options);
		await expect(adapter.findOne({ model: 'session', where: [] })).rejects.toThrow(/session/);
	});
});
