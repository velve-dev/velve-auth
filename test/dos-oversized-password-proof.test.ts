import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/core/db/driver.js";

/**
 * T-DOS-2 over the mounted route. Every Argon2 derivation either engine runs is counted beneath the
 * library, every statement the route sends is recorded, and the two groups are timed interleaved
 * with a third that plants the limit itself after its answer as the power guard (E-2153).
 */

const counted = vi.hoisted(() => ({ derivations: 0 }));

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const count =
		<A extends unknown[], R>(derive: (...args: A) => R) =>
		(...args: A): R => {
			counted.derivations += 1;
			return derive(...args);
		};
	return {
		...original,
		argon2idAsync: count(original.argon2idAsync),
		argon2iAsync: count(original.argon2iAsync),
		argon2dAsync: count(original.argon2dAsync),
	};
});

vi.mock("hash-wasm", async (importOriginal) => {
	const original = await importOriginal<typeof import("hash-wasm")>();
	const count =
		<A extends unknown[], R>(derive: (...args: A) => R) =>
		(...args: A): R => {
			counted.derivations += 1;
			return derive(...args);
		};
	return {
		argon2id: count(original.argon2id),
		argon2i: count(original.argon2i),
		argon2d: count(original.argon2d),
	};
});

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");
const { median } = await import("./timing-fixtures.js");

type Migrated = Awaited<ReturnType<typeof openMigratedSchema>>;
type Group = "existing" | "missing" | "planted";

const NIGHTLY = process.env.VELVE_NIGHTLY === "1";
const MEASUREMENTS_PER_GROUP = 200;
const WARMUP_SIGN_INS = 20;
const MEDIAN_DIFFERENCE_LIMIT_MS = 5;
const PLANTED_DELAY_MS = MEDIAN_DIFFERENCE_LIMIT_MS;
const PLANT_RECOVERY_TOLERANCE = 0.5;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CASE_TIMEOUT_MS = 900_000;

const ONE_MEBIBYTE_PASSWORD = "p".repeat(1024 * 1024);
const EXISTING_EMAIL = "oversized@example.com";
const MISSING_EMAIL = "nobody.oversized@example.com";
const ACCOUNT_STATEMENT = /\.(user|password_credential|identity)\b/;

let migrated: Migrated;
let handler: (request: Request) => Promise<Response>;
const statements: string[] = [];

beforeAll(async () => {
	if (!NIGHTLY) {
		return;
	}
	migrated = await openMigratedSchema("dosoversized");
	const connection = migrated.connection;
	const recording = (driver: Driver): Driver => ({
		query: (sql, params) => {
			statements.push(sql);
			return driver.query(sql, params);
		},
		transaction: (work) => driver.transaction((tx) => work(recording(tx))),
	});
	const auth = createVelveAuth(
		configFor({
			database: recording(connection),
			schema: migrated.schema,
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
	const signedUp = await handler(
		postTo("/sign-up", { email: EXISTING_EMAIL, password: drawTestPassword() }),
	);
	expect(signedUp.status).toBe(200);
}, 120_000);

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
		order.push("existing", "missing", "planted");
	}
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[order[index], order[swap]] = [order[swap] as Group, order[index] as Group];
	}
	return order;
}

interface Answer {
	readonly elapsedMs: number;
	readonly status: number;
	readonly headers: string;
	readonly body: Buffer;
	readonly statements: readonly string[];
}

async function signInOversized(email: string, plantedMs: number): Promise<Answer> {
	statements.length = 0;
	const started = process.hrtime.bigint();
	const answer = await handler(
		postTo("/sign-in/password", { email, password: ONE_MEBIBYTE_PASSWORD }),
	);
	spinFor(plantedMs);
	const elapsedMs = Number(process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND;
	return {
		elapsedMs,
		status: answer.status,
		headers: [...answer.headers]
			.filter(([name]) => name !== "date")
			.map(([name, value]) => `${name}: ${value}`)
			.sort()
			.join("\n"),
		body: Buffer.from(await answer.arrayBuffer()),
		statements: [...statements],
	};
}

describe("T-DOS-2 — an oversized password is no enumeration oracle (S-DOS-2)", () => {
	it.skipIf(!NIGHTLY)(
		"answers an existing and a missing identifier alike, without the account, the KDF or a time difference",
		async () => {
			for (let index = 0; index < WARMUP_SIGN_INS; index += 1) {
				await signInOversized(index % 2 === 0 ? EXISTING_EMAIL : MISSING_EMAIL, 0);
			}
			counted.derivations = 0;

			const answers: Record<Group, Answer[]> = { existing: [], missing: [], planted: [] };
			for (const group of shuffledGroups()) {
				answers[group].push(
					await signInOversized(
						group === "existing" ? EXISTING_EMAIL : MISSING_EMAIL,
						group === "planted" ? PLANTED_DELAY_MS : 0,
					),
				);
			}

			const [reference] = answers.existing as [Answer];
			const all = [...answers.existing, ...answers.missing];
			expect(reference.status).toBe(401);
			expect(all.filter((answer) => answer.status !== reference.status)).toHaveLength(0);
			expect(all.filter((answer) => answer.headers !== reference.headers)).toHaveLength(0);
			expect(all.filter((answer) => !answer.body.equals(reference.body))).toHaveLength(0);
			expect(
				all.flatMap((answer) => answer.statements.filter((sql) => ACCOUNT_STATEMENT.test(sql))),
			).toStrictEqual([]);
			expect(
				all.filter((answer) => answer.statements.join("\n") !== reference.statements.join("\n")),
				"the same statements for both identifiers",
			).toHaveLength(0);
			expect(counted.derivations, "Argon2 derivations").toBe(0);

			const existing = median(answers.existing.map((answer) => answer.elapsedMs));
			const missing = median(answers.missing.map((answer) => answer.elapsedMs));
			const planted = median(answers.planted.map((answer) => answer.elapsedMs));
			const recovered = planted - missing;
			const measured = `median ${existing.toFixed(2)} ms for an existing identifier, ${missing.toFixed(2)} ms for a missing one, ${planted.toFixed(2)} ms with ${PLANTED_DELAY_MS} ms planted`;

			expect(
				Math.abs(recovered - PLANTED_DELAY_MS) / PLANTED_DELAY_MS,
				`the planted ${PLANTED_DELAY_MS} ms came back as ${recovered.toFixed(2)} ms, so the medians cannot resolve the limit: ${measured}`,
			).toBeLessThan(PLANT_RECOVERY_TOLERANCE);
			expect(Math.abs(existing - missing), `T-DOS-2: ${measured}`).toBeLessThan(
				MEDIAN_DIFFERENCE_LIMIT_MS,
			);
		},
		CASE_TIMEOUT_MS,
	);

	it.skipIf(!NIGHTLY)(
		"counts a derivation when a password is usable, so the zero above can fail",
		async () => {
			counted.derivations = 0;
			const answer = await signInOversized(MISSING_EMAIL, 0);
			expect(answer.status).toBe(401);
			expect(counted.derivations).toBe(0);

			const usable = await handler(
				postTo("/sign-in/password", { email: MISSING_EMAIL, password: drawTestPassword() }),
			);
			expect(usable.status).toBe(401);
			expect(counted.derivations).toBeGreaterThan(0);
		},
		60_000,
	);
});
