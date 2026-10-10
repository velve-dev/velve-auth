import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";

/**
 * Every derivation that writes a new PHC string goes through `createArgon2idHash`; verification
 * does not. Recording its calls in one list with the moment the caller holds its answer is what
 * puts the two in an order a test can read without a clock.
 */
const recorded = vi.hoisted(() => ({
	events: [] as string[],
	failNextDerivation: false,
}));

vi.mock("../src/core/password/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/password/argon2.js")>();
	return {
		...original,
		createArgon2idHash: (...parameters: Parameters<typeof original.createArgon2idHash>) => {
			recorded.events.push("derivation started");
			if (recorded.failNextDerivation) {
				recorded.failNextDerivation = false;
				return Promise.reject(new Error("planted derivation failure"));
			}
			return original.createArgon2idHash(...parameters);
		},
	};
});

const { createVelveAuth } = await import("../src/index.js");
const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { rootKeyProvider } = await import("../src/core/keys/index.js");
const { createArgon2idHash } = await import("../src/core/password/argon2.js");
const { createPasswordCredentialRepository } = await import("../src/core/password/credential.js");
const { configFor, TEST_ORIGIN } = await import("./auth-fixtures.js");
const { actorOfTestUser, dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { resealDirectly } = await import("./security-state-fixtures.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const { drawTestPassword, storedHashesFor } = await import("./password-fixtures.js");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Auth = ReturnType<typeof createVelveAuth<"email">>;

const PASSWORD = drawTestPassword();
const FLOOR_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const REHASH_SETTLE_LIMIT_MS = 20_000;

const firstRootKey = generateRootKey();
const staleKeys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: firstRootKey } });
const currentKeys = rootKeyProvider({
	currentVersion: 2,
	keysByVersion: { 1: firstRootKey, 2: generateRootKey() },
});

let migrated: Migrated;
let auth: Auth;
let handler: (request: Request) => Promise<Response>;
let stalePhc: string;
let accounts = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("rehashafter");
	auth = createVelveAuth(
		configFor({
			database: migrated.connection,
			schema: migrated.schema,
			keys: currentKeys,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
	stalePhc = await createArgon2idHash(new TextEncoder().encode(PASSWORD), FLOOR_ARGON2ID);
}, 120_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

beforeEach(() => {
	recorded.events.length = 0;
	recorded.failNextDerivation = false;
});

/** An account whose credential is current in every respect but the key version it is sealed under. */
async function accountBehindTheKeyRing(): Promise<{ email: string; userId: string }> {
	accounts += 1;
	const email = `stale${accounts}@example.com`;
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	const userId = (row as { id: string }).id;
	await createPasswordCredentialRepository({
		driver: migrated.connection,
		keys: staleKeys,
		schema: migrated.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	}).write({
		actor: actorOfTestUser(userId),
		phc: stalePhc,
		scheme: "argon2id",
		setBySessionId: null,
	});
	await resealDirectly(migrated.connection, migrated.schema, currentKeys, userId);
	return { email, userId };
}

async function keyVersionOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ key_version: number }>(
		`SELECT key_version FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return (row as { key_version: number }).key_version;
}

async function rehashLands(userId: string): Promise<boolean> {
	const deadline = Date.now() + REHASH_SETTLE_LIMIT_MS;
	while (Date.now() < deadline) {
		if ((await keyVersionOf(userId)) === 2) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

async function derivationsSettle(): Promise<void> {
	const deadline = Date.now() + REHASH_SETTLE_LIMIT_MS;
	while (Date.now() < deadline && !recorded.events.includes("derivation started")) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("S-TIM-5 — the rehash starts only once the sign-in has been answered", () => {
	it("answers a mounted sign-in before the rehash derives anything", async () => {
		const account = await accountBehindTheKeyRing();

		const answer = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		recorded.events.push("answered");

		expect(answer.status).toBe(200);
		expect(await rehashLands(account.userId)).toBe(true);
		expect(recorded.events).toEqual(["answered", "derivation started"]);
	}, 60_000);

	it("answers a direct server call before the rehash derives anything, and still runs it", async () => {
		const account = await accountBehindTheKeyRing();

		const result = await auth.signIn.password({
			email: account.email,
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		recorded.events.push("answered");

		expect(result.status).toBe("signed_in");
		expect(await rehashLands(account.userId)).toBe(true);
		expect(recorded.events).toEqual(["answered", "derivation started"]);
	}, 60_000);

	it("keeps a failed rehash from the caller and leaves the credential for the next sign-in", async () => {
		const account = await accountBehindTheKeyRing();
		recorded.failNextDerivation = true;

		const answer = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		recorded.events.push("answered");
		await derivationsSettle();

		expect(answer.status).toBe(200);
		expect(recorded.events).toEqual(["answered", "derivation started"]);
		expect(await keyVersionOf(account.userId)).toBe(1);

		recorded.events.length = 0;
		const retried = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		expect(retried.status).toBe(200);
		expect(await rehashLands(account.userId)).toBe(true);
	}, 60_000);
});

async function schemeOf(userId: string): Promise<string> {
	const [row] = await migrated.connection.query<{ scheme: string }>(
		`SELECT scheme FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return (row as { scheme: string }).scheme;
}

async function argon2idLands(userId: string): Promise<boolean> {
	const deadline = Date.now() + REHASH_SETTLE_LIMIT_MS;
	while (Date.now() < deadline) {
		if ((await schemeOf(userId)) === "argon2id") {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

/** T-TIM-5 names an outdated bcrypt hash; the timing case uses a key version instead (E-2152). */
async function accountWithBcrypt(): Promise<{ email: string; userId: string }> {
	accounts += 1;
	const email = `bcrypt${accounts}@example.com`;
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	const userId = (row as { id: string }).id;
	await createPasswordCredentialRepository({
		driver: migrated.connection,
		keys: currentKeys,
		schema: migrated.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	}).write({
		actor: actorOfTestUser(userId),
		phc: (await storedHashesFor(PASSWORD)).byScheme.bcrypt,
		scheme: "bcrypt",
		setBySessionId: null,
	});
	await resealDirectly(migrated.connection, migrated.schema, currentKeys, userId);
	return { email, userId };
}

describe("S-TIM-5 — the deferral holds beyond the stale key version", () => {
	it("answers a sign-in against an outdated bcrypt hash before the rehash derives anything", async () => {
		const account = await accountWithBcrypt();

		const answer = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		recorded.events.push("answered");

		expect(answer.status).toBe(200);
		expect(await argon2idLands(account.userId)).toBe(true);
		expect(recorded.events).toEqual(["answered", "derivation started"]);
	}, 60_000);

	it("answers a disabled account with the right password before its rehash, like a wrong password", async () => {
		const disabled = await accountBehindTheKeyRing();
		await auth.user.disable({ userId: disabled.userId, reason: "a test" });
		const other = await accountBehindTheKeyRing();

		const refused = await handler(
			postTo("/sign-in/password", { email: disabled.email, password: PASSWORD }),
		);
		recorded.events.push("answered");
		const wrong = await handler(
			postTo("/sign-in/password", { email: other.email, password: `${PASSWORD}x` }),
		);

		expect(refused.status).toBe(401);
		expect(await refused.text()).toBe(await wrong.text());
		expect(await rehashLands(disabled.userId)).toBe(true);
		expect(recorded.events).toEqual(["answered", "derivation started"]);
		expect(await keyVersionOf(other.userId)).toBe(1);
	}, 60_000);

	it("runs each request's rehash exactly once when sign-ins overlap, and none for a current credential", async () => {
		const stale = [await accountBehindTheKeyRing(), await accountBehindTheKeyRing()];
		const current = await accountBehindTheKeyRing();
		await handler(postTo("/sign-in/password", { email: current.email, password: PASSWORD }));
		expect(await rehashLands(current.userId)).toBe(true);
		recorded.events.length = 0;

		const answers = await Promise.all([
			...stale.map((account) =>
				handler(postTo("/sign-in/password", { email: account.email, password: PASSWORD })),
			),
			handler(postTo("/sign-in/password", { email: current.email, password: PASSWORD })),
		]);

		expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
		for (const account of stale) {
			expect(await rehashLands(account.userId)).toBe(true);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		// One request's rehash may start while another is still in flight, so only the count is read.
		expect(recorded.events).toEqual(["derivation started", "derivation started"]);
	}, 60_000);
});
