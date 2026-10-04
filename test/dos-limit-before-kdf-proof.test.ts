import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * T-DOS-5 against the mounted `/sign-in/password` route and the real derivations. Every Argon2
 * call of either engine is counted beneath the library, so a derivation the limiter let through
 * is counted wherever it runs.
 */

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const { accounted } = await import("./kdf-accounting-fixtures.js");
	type Derive = typeof original.argon2idAsync;
	const memoryOf = (...args: Parameters<Derive>) => Number(args[2]?.m ?? 0);
	const wrap = (derive: Derive) =>
		accounted<Parameters<Derive>, Awaited<ReturnType<Derive>>>(derive, memoryOf);
	return {
		...original,
		argon2idAsync: wrap(original.argon2idAsync),
		argon2iAsync: wrap(original.argon2iAsync),
		argon2dAsync: wrap(original.argon2dAsync),
	};
});

vi.mock("hash-wasm", async (importOriginal) => {
	const original = await importOriginal<typeof import("hash-wasm")>();
	const { accounted } = await import("./kdf-accounting-fixtures.js");
	type Options = Parameters<typeof original.argon2id>[0];
	const wrap = (derive: (options: Options) => Promise<unknown>) =>
		accounted<[Options], unknown>(derive, (options) => options.memorySize);
	return {
		argon2id: wrap(original.argon2id),
		argon2i: wrap(original.argon2i),
		argon2d: wrap(original.argon2d),
	};
});

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");
const { openConnectionPool } = await import("./connection-pool-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { kdfAccounting } = await import("./kdf-accounting-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Pool = Awaited<ReturnType<typeof openConnectionPool>>;

const ADDRESS_CAPACITY = 5;
const REQUESTS = 100;
const POOL_SIZE = 8;
const SETTLE_LIMIT_MS = 20_000;
const PASSWORD = drawTestPassword();
const EMAIL = "flooded@example.com";

let migrated: Migrated;
let pool: Pool;

beforeAll(async () => {
	migrated = await openMigratedSchema("doslimitfirst");
	pool = await openConnectionPool(POOL_SIZE);
}, 60_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
	await pool.close();
});

async function mountFrom(address: string, capacity: number) {
	const handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema: migrated.schema,
				rateLimit: {
					perIpAddress: { capacity, refillPerSecond: 0.001 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
		{ connectionAddress: () => address },
	);
	//the dummy credentials the assembly derives eagerly are not the flood's
	const deadline = Date.now() + SETTLE_LIMIT_MS;
	await new Promise((resolve) => setTimeout(resolve, 50));
	while (kdfAccounting.inFlight > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	kdfAccounting.reset();
	return handler;
}

function flood(handler: (request: Request) => Promise<Response>, count: number) {
	return Promise.all(
		Array.from({ length: count }, (_, index) =>
			handler(
				postTo("/sign-in/password", {
					email: index % 2 === 0 ? EMAIL : `nobody${index}@example.com`,
					password: PASSWORD,
				}),
			).then((answer) => answer.status),
		),
	);
}

describe("T-DOS-5 — the address limit runs before the semaphore is asked for a place (S-DOS-5)", () => {
	it("lets at most five of a hundred simultaneous sign-ins from one address reach Argon2", async () => {
		const handler = await mountFrom("203.0.113.5", ADDRESS_CAPACITY);
		await handler(postTo("/sign-up", { email: EMAIL, password: PASSWORD }));
		kdfAccounting.reset();

		const statuses = await flood(handler, REQUESTS);

		expect(statuses.filter((status) => status === 429)).toHaveLength(REQUESTS - ADDRESS_CAPACITY);
		expect(kdfAccounting.calls, "Argon2 derivations for the flood").toBeLessThanOrEqual(
			ADDRESS_CAPACITY,
		);
	}, 60_000);

	it("counts a derivation for every sign-in the limit lets through, so the bound above can fail", async () => {
		const handler = await mountFrom("203.0.113.6", 1_000_000);

		const statuses = await flood(handler, 10);

		expect(statuses.filter((status) => status === 429)).toHaveLength(0);
		expect(kdfAccounting.calls).toBeGreaterThanOrEqual(10);
	}, 60_000);
});
