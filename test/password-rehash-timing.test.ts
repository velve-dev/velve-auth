import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { createArgon2idHash } from "../src/core/password/argon2.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { median } from "./timing-fixtures.js";

/**
 * T-TIM-5: 200 measurements per group, the difference of the medians under 5 ms, and the rehash
 * visible in the database afterwards. The two groups hold the same Argon2id credential at the
 * production parameters and differ only in the key version it is sealed under, so the rehash is
 * the one thing that separates them; T-TIM-5's bcrypt arm would add bcrypt's own verification cost
 * to the difference it is meant to isolate (E-2152).
 */
const MEASUREMENTS_PER_GROUP = 200;
const WARMUP_SIGN_INS = 20;
const MEDIAN_DIFFERENCE_LIMIT_MS = 5;
const PRODUCTION_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

/**
 * The power guard. A third group signs in exactly like the current one and spends the limit
 * itself on the clock after its answer, so a run whose medians cannot resolve 5 ms says so
 * instead of passing (E-2153).
 */
const PLANTED_DELAY_MS = MEDIAN_DIFFERENCE_LIMIT_MS;
const PLANT_RECOVERY_TOLERANCE = 0.5;

const REHASH_SETTLE_LIMIT_MS = 20_000;
const CASE_TIMEOUT_MS = 900_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const PASSWORD = drawTestPassword();
const STALE_VERSION = 1;
const CURRENT_VERSION = 2;

type Group = "stale" | "current" | "planted";

interface Account {
	readonly email: string;
	readonly userId: string;
}

const firstRootKey = generateRootKey();
const staleKeys = rootKeyProvider({
	currentVersion: STALE_VERSION,
	keysByVersion: { [STALE_VERSION]: firstRootKey },
});
const currentKeys = rootKeyProvider({
	currentVersion: CURRENT_VERSION,
	keysByVersion: { [STALE_VERSION]: firstRootKey, [CURRENT_VERSION]: generateRootKey() },
});

let migrated: MigratedSchema;
let handler: (request: Request) => Promise<Response>;
const accountsOf: Record<Group, Account[]> = { stale: [], current: [], planted: [] };
const warmupAccounts: Account[] = [];

async function createAccounts(prefix: string, sealedUnder: typeof staleKeys, phc: string) {
	const credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys: sealedUnder,
		schema: migrated.schema,
	});
	const accounts: Account[] = [];
	for (let index = 0; index < MEASUREMENTS_PER_GROUP; index += 1) {
		const email = `${prefix}${index}@timing.example`;
		const [row] = await migrated.connection.query<{ id: string }>(
			`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
			[email],
		);
		const userId = (row as { id: string }).id;
		await credentials.write({ userId, phc, scheme: "argon2id", setBySessionId: null });
		accounts.push({ email, userId });
	}
	return accounts;
}

beforeAll(async () => {
	if (process.env.VELVE_NIGHTLY !== "1") {
		return;
	}
	migrated = await openMigratedSchema("rehashtiming");
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: migrated.connection,
				schema: migrated.schema,
				keys: currentKeys,
				password: { argon2id: PRODUCTION_ARGON2ID },
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
	);
	const phc = await createArgon2idHash(new TextEncoder().encode(PASSWORD), PRODUCTION_ARGON2ID);
	accountsOf.stale.push(...(await createAccounts("stale", staleKeys, phc)));
	accountsOf.current.push(...(await createAccounts("current", currentKeys, phc)));
	accountsOf.planted.push(...(await createAccounts("planted", currentKeys, phc)));
	warmupAccounts.push(...accountsOf.current.slice(0, WARMUP_SIGN_INS));
}, 600_000);

afterAll(async () => {
	if (migrated === undefined) {
		return;
	}
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

function spinFor(milliseconds: number): void {
	const end = process.hrtime.bigint() + BigInt(milliseconds * NANOSECONDS_PER_MILLISECOND);
	let now = process.hrtime.bigint();
	while (now < end) {
		now = process.hrtime.bigint();
	}
}

function shuffledGroups(): Group[] {
	const order: Group[] = [];
	for (let index = 0; index < MEASUREMENTS_PER_GROUP; index += 1) {
		order.push("stale", "current", "planted");
	}
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[order[index], order[swap]] = [order[swap] as Group, order[index] as Group];
	}
	return order;
}

async function keyVersionOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ key_version: number }>(
		`SELECT key_version FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return (row as { key_version: number }).key_version;
}

/** The next measurement starts on a quiet loop, and the wait is the case's database check too. */
async function rehashLands(userId: string): Promise<boolean> {
	const deadline = Date.now() + REHASH_SETTLE_LIMIT_MS;
	while (Date.now() < deadline) {
		if ((await keyVersionOf(userId)) === CURRENT_VERSION) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return false;
}

/** Time to the first byte in process: from the call until the handler hands its `Response` back. */
async function timeToAnswer(account: Account, plantedMs: number): Promise<number> {
	const started = process.hrtime.bigint();
	const answer = await handler(
		postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
	);
	spinFor(plantedMs);
	const elapsed = Number(process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND;
	if (answer.status !== 200) {
		throw new Error(`a correct password was answered with ${answer.status}`);
	}
	return elapsed;
}

describe("T-TIM-5 — the rehash does not lengthen the sign-in that triggers it", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"keeps the medians of a stale and a current credential within 5 ms of each other",
		async () => {
			for (const account of warmupAccounts) {
				await timeToAnswer(account, 0);
			}

			const samples: Record<Group, number[]> = { stale: [], current: [], planted: [] };
			const next: Record<Group, number> = { stale: 0, current: 0, planted: 0 };
			const unrehashed: string[] = [];
			for (const group of shuffledGroups()) {
				const account = accountsOf[group][next[group]] as Account;
				next[group] += 1;
				samples[group].push(
					await timeToAnswer(account, group === "planted" ? PLANTED_DELAY_MS : 0),
				);
				if (group === "stale" && !(await rehashLands(account.userId))) {
					unrehashed.push(account.userId);
				}
			}

			const stale = median(samples.stale);
			const current = median(samples.current);
			const planted = median(samples.planted);
			const recovered = planted - current;
			const measured = `median ${stale.toFixed(2)} ms with a rehash due, ${current.toFixed(2)} ms without, ${planted.toFixed(2)} ms with ${PLANTED_DELAY_MS} ms planted`;

			expect(
				Math.abs(recovered - PLANTED_DELAY_MS) / PLANTED_DELAY_MS,
				`the planted ${PLANTED_DELAY_MS} ms came back as ${recovered.toFixed(2)} ms, so the medians cannot resolve the limit this case decides on: ${measured}`,
			).toBeLessThan(PLANT_RECOVERY_TOLERANCE);
			expect(unrehashed, "every stale credential is rewritten after its sign-in").toEqual([]);
			expect(Math.abs(stale - current), `T-TIM-5: ${measured}`).toBeLessThan(
				MEDIAN_DIFFERENCE_LIMIT_MS,
			);
		},
		CASE_TIMEOUT_MS,
	);
});
