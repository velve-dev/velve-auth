import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { generateRootKey } = await import("./keys-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

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
	}).write({ userId, phc: stalePhc, scheme: "argon2id", setBySessionId: null });
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
