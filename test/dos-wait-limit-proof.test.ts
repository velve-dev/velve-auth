import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * T-DOS-4 over the mounted route at the default wait limit. One semaphore place, a derivation
 * slowed to a fixed time beneath the library, and five hundred sign-ins sent at once: only the
 * first few dozen can be served before the limit comes due, and every other one has to be refused
 * at it rather than queued past it.
 */

const SLOWED_DERIVATION_MS = 50;

const waits = vi.hoisted(() => ({ granted: [] as number[], refused: [] as number[] }));

vi.mock("../src/core/password/semaphore.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/password/semaphore.js")>();
	return {
		...original,
		createKdfSemaphore: (options: Parameters<typeof original.createKdfSemaphore>[0]) => {
			const inner = original.createKdfSemaphore(options);
			return {
				get inFlight() {
					return inner.inFlight;
				},
				get peakInFlight() {
					return inner.peakInFlight;
				},
				get waiting() {
					return inner.waiting;
				},
				run<T>(work: () => Promise<T>): Promise<T> {
					const entered = performance.now();
					let granted = false;
					return inner
						.run(() => {
							granted = true;
							waits.granted.push(performance.now() - entered);
							return work();
						})
						.catch((failure: unknown) => {
							if (!granted) {
								waits.refused.push(performance.now() - entered);
							}
							throw failure;
						});
				},
			};
		},
	};
});

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const slowed =
		<A extends unknown[], R>(derive: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			await new Promise((resolve) => setTimeout(resolve, SLOWED_DERIVATION_MS));
			return derive(...args);
		};
	return {
		...original,
		argon2idAsync: slowed(original.argon2idAsync),
		argon2iAsync: slowed(original.argon2iAsync),
		argon2dAsync: slowed(original.argon2dAsync),
	};
});

vi.mock("hash-wasm", async (importOriginal) => {
	const original = await importOriginal<typeof import("hash-wasm")>();
	type Options = Parameters<typeof original.argon2id>[0];
	const slowed =
		(derive: (options: Options) => Promise<unknown>) =>
		async (options: Options): Promise<unknown> => {
			await new Promise((resolve) => setTimeout(resolve, SLOWED_DERIVATION_MS));
			return derive(options);
		};
	return {
		argon2id: slowed(original.argon2id),
		argon2i: slowed(original.argon2i),
		argon2d: slowed(original.argon2d),
	};
});

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { createKdfSemaphore, DEFAULT_WAIT_LIMIT_IN_MILLISECONDS } = await import(
	"../src/core/password/semaphore.js"
);
const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");
const { openConnectionPool } = await import("./connection-pool-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Pool = Awaited<ReturnType<typeof openConnectionPool>>;

const NIGHTLY = process.env.VELVE_NIGHTLY === "1";
const SIMULTANEOUS_SIGN_INS = 500;
const RESPONSE_TOLERANCE_MS = 500;
const POOL_SIZE = 12;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const PASSWORD = drawTestPassword();
const EMAIL = "waitlimit@example.com";

let migrated: Migrated;
let pool: Pool;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
	if (!NIGHTLY) {
		return;
	}
	migrated = await openMigratedSchema("doswaitlimit");
	pool = await openConnectionPool(POOL_SIZE);
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema: migrated.schema,
				password: { concurrentHashLimit: 1 },
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
	);
	expect((await handler(postTo("/sign-up", { email: EMAIL, password: PASSWORD }))).status).toBe(
		200,
	);
}, 120_000);

afterAll(async () => {
	if (migrated === undefined) {
		return;
	}
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
	await pool.close();
});

interface Timed {
	readonly status: number;
	readonly code: string | null;
	readonly elapsedMs: number;
}

async function timedSignIn(email: string, startedAt: bigint): Promise<Timed> {
	const answer = await handler(postTo("/sign-in/password", { email, password: PASSWORD }));
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
	const body = (await answer.json()) as { error?: { code?: string } };
	return { status: answer.status, code: body.error?.code ?? null, elapsedMs };
}

describe("T-DOS-4 — a sign-in that waits past the limit is refused, not queued (S-DOS-4)", () => {
	it.skipIf(!NIGHTLY)(
		"answers five hundred simultaneous sign-ins within the limit and refuses everything that waited it out",
		async () => {
			const unhandled: unknown[] = [];
			const recordUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", recordUnhandled);
			try {
				waits.granted.length = 0;
				waits.refused.length = 0;
				const startedAt = process.hrtime.bigint();
				const answers = await Promise.all(
					Array.from({ length: SIMULTANEOUS_SIGN_INS }, (_, index) =>
						timedSignIn(index % 2 === 0 ? EMAIL : `missing${index}@example.com`, startedAt),
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				const refused = answers.filter((answer) => answer.status === 429);

				expect(answers).toHaveLength(SIMULTANEOUS_SIGN_INS);
				expect(
					answers.filter((answer) => ![200, 401, 429].includes(answer.status)),
					"a status other than signed in, refused or rate limited",
				).toStrictEqual([]);
				expect(
					Math.max(...answers.map((answer) => answer.elapsedMs)),
					"the slowest answer",
				).toBeLessThanOrEqual(DEFAULT_WAIT_LIMIT_IN_MILLISECONDS + RESPONSE_TOLERANCE_MS);
				expect(waits.refused, "a semaphore place refused per rate-limited answer").toHaveLength(
					refused.length,
				);
				expect(
					waits.granted.filter((waited) => waited > DEFAULT_WAIT_LIMIT_IN_MILLISECONDS),
					"a place granted after waiting out the limit",
				).toStrictEqual([]);
				expect(
					waits.refused.filter((waited) => waited < DEFAULT_WAIT_LIMIT_IN_MILLISECONDS - 1),
					"a place refused before the limit",
				).toStrictEqual([]);
				expect(refused.every((answer) => answer.code === "rate_limited")).toBe(true);
				expect(refused.length, "the limit came due during the flood").toBeGreaterThan(0);
				expect(
					refused.filter((answer) => answer.elapsedMs < DEFAULT_WAIT_LIMIT_IN_MILLISECONDS),
					"a refusal before the limit",
				).toStrictEqual([]);
				expect(unhandled).toStrictEqual([]);
			} finally {
				process.off("unhandledRejection", recordUnhandled);
			}
		},
		120_000,
	);

	//a busy event loop runs the freed place's grant before the due timer that would refuse the waiter
	it("refuses a waiter whose limit passed while the loop was busy instead of granting it the freed place", async () => {
		const waitLimitInMilliseconds = 50;
		const semaphore = createKdfSemaphore({ limit: 1, waitLimitInMilliseconds });
		let releaseHolder = (): void => undefined;
		const holderGate = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holder = semaphore.run(() => holderGate);
		const waiter = semaphore.run(() => Promise.resolve("granted"));

		const busyUntil = performance.now() + 2 * waitLimitInMilliseconds;
		while (performance.now() < busyUntil) {
			//the loop is held so the waiter's timer cannot run before the place is freed
		}
		releaseHolder();
		await holder;

		await expect(waiter).rejects.toMatchObject({ code: "rate_limited" });
	});
});
