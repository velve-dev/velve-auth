import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { accountBucketKey } from "../src/core/limit/bucket-key.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { median } from "./timing-fixtures.js";

const KNOWN = "known@example.com";
const UNKNOWN = "unknown@example.com";

const ENDPOINTS = [
	{ path: "/password/request-reset", routeName: "password.requestReset" },
	{ path: "/sign-in/magic-link/request", routeName: "signIn.magicLink.request" },
] as const;

interface Call {
	readonly statement: string;
	readonly parameterCount: number;
}

interface Observation {
	readonly status: number;
	readonly body: string;
	readonly calls: readonly Call[];
	readonly sends: readonly EmailMessage["kind"][];
	readonly accountBuckets: number;
	readonly bucketsForTheIdentifier: number;
}

const keys = testKeyProvider();
const calls: Call[] = [];
const sends: EmailMessage["kind"][] = [];
let migrated: MigratedSchema;
let handler: (request: Request) => Promise<Response>;

function recording(inner: Driver): Driver {
	return {
		query: (sql, parameters) => {
			calls.push({ statement: sql.replace(/\s+/g, " ").trim(), parameterCount: parameters.length });
			return inner.query(sql, parameters);
		},
		transaction: (run) => {
			calls.push({ statement: "BEGIN", parameterCount: 0 });
			return inner.transaction((transaction) => run(recording(transaction)));
		},
	};
}

beforeAll(async () => {
	migrated = await openMigratedSchema("timrequest");
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: recording(migrated.connection),
				schema: migrated.schema,
				keys,
				email: {
					send: (message) => {
						sends.push(message.kind);
						return Promise.resolve();
					},
				},
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
	);
	const created = await handler(postTo("/sign-up", { email: KNOWN, password: drawTestPassword() }));
	expect(created.status).toBe(200);
}, 60_000);

afterAll(async () => {
	if (migrated === undefined) {
		return;
	}
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

async function countRows(sql: string, parameters: unknown[]): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(sql, parameters);
	return row?.total ?? -1;
}

async function request(endpoint: (typeof ENDPOINTS)[number], email: string): Promise<Observation> {
	await migrated.connection.query(`DELETE FROM ${migrated.schema}.rate_bucket`, []);
	calls.length = 0;
	sends.length = 0;
	const answer = await handler(postTo(endpoint.path, { email }));
	const body = await answer.text();
	const observed = { calls: [...calls], sends: [...sends] };
	const key = await accountBucketKey(keys, endpoint.routeName, email);
	return {
		status: answer.status,
		body,
		...observed,
		accountBuckets: await countRows(
			`SELECT count(*)::integer AS total FROM ${migrated.schema}.rate_bucket WHERE bucket_key LIKE $1`,
			[`account|${endpoint.routeName}|%`],
		),
		bucketsForTheIdentifier: await countRows(
			`SELECT count(*)::integer AS total FROM ${migrated.schema}.rate_bucket WHERE bucket_key = $1`,
			[key],
		),
	};
}

describe("T-TIM-6 — a request for an unknown address does the work a known one does (S-TIM-6)", () => {
	it.each(ENDPOINTS)(
		"$path runs one statement sequence and one send for both",
		async (endpoint) => {
			const known = await request(endpoint, KNOWN);
			const unknown = await request(endpoint, UNKNOWN);

			expect(known.calls.length).toBeGreaterThan(3);
			expect(unknown.calls).toStrictEqual(known.calls);
			expect([known.status, unknown.status]).toStrictEqual([204, 204]);
			expect(unknown.body).toBe(known.body);
			expect(known.sends).toHaveLength(1);
			expect(unknown.sends).toHaveLength(1);
			expect(
				known.sends[0],
				"the known address is sent the artefact, so the two sends are the two branches",
			).not.toBe(unknown.sends[0]);
			expect(known.bucketsForTheIdentifier).toBe(1);
			expect(unknown.bucketsForTheIdentifier).toBe(1);
			expect([known.accountBuckets, unknown.accountBuckets]).toStrictEqual([1, 1]);
		},
	);
});

/** T-TIM-6's measurement: 200 per case, the medians of the first byte within 5 ms of each other. */
const MEASUREMENTS_PER_CASE = 200;
const WARMUP_REQUESTS = 20;
const MEDIAN_DIFFERENCE_LIMIT_MS = 5;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CASE_TIMEOUT_MS = 600_000;

/**
 * The power guard of `test/password-rehash-timing.test.ts`: a third group requests exactly like the
 * known one and spends the limit itself on the clock, so a run whose medians cannot see 5 ms says
 * so instead of passing (E-2153).
 */
const PLANTED_DELAY_MS = MEDIAN_DIFFERENCE_LIMIT_MS;
const PLANT_RECOVERY_TOLERANCE = 0.5;

type Group = "known" | "unknown" | "planted";

function spinFor(milliseconds: number): void {
	const end = process.hrtime.bigint() + BigInt(milliseconds * NANOSECONDS_PER_MILLISECOND);
	while (process.hrtime.bigint() < end) {
		//the wait is charged inside the measured region
	}
}

function shuffledGroups(): Group[] {
	const order: Group[] = [];
	for (let index = 0; index < MEASUREMENTS_PER_CASE; index += 1) {
		order.push("known", "unknown", "planted");
	}
	for (let index = order.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[order[index], order[swap]] = [order[swap] as Group, order[index] as Group];
	}
	return order;
}

/** Time to the first byte in process: from the call until the handler hands its `Response` back. */
async function timeToAnswer(path: string, group: Group): Promise<number> {
	const started = process.hrtime.bigint();
	const answer = await handler(postTo(path, { email: group === "unknown" ? UNKNOWN : KNOWN }));
	spinFor(group === "planted" ? PLANTED_DELAY_MS : 0);
	const elapsed = Number(process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND;
	if (answer.status !== 204) {
		throw new Error(`${path} answered ${answer.status}`);
	}
	return elapsed;
}

describe("T-TIM-6 under measurement — the first byte does not tell the two branches apart", () => {
	it.skipIf(process.env.VELVE_NIGHTLY !== "1").each(ENDPOINTS)(
		"$path keeps the medians of a known and an unknown address within 5 ms",
		async ({ path }) => {
			for (let index = 0; index < WARMUP_REQUESTS; index += 1) {
				await timeToAnswer(path, index % 2 === 0 ? "known" : "unknown");
			}
			const samples: Record<Group, number[]> = { known: [], unknown: [], planted: [] };
			for (const group of shuffledGroups()) {
				samples[group].push(await timeToAnswer(path, group));
			}

			const known = median(samples.known);
			const unknown = median(samples.unknown);
			const recovered = median(samples.planted) - known;
			const measured = `median ${known.toFixed(2)} ms known, ${unknown.toFixed(2)} ms unknown, ${PLANTED_DELAY_MS} ms planted recovered as ${recovered.toFixed(2)} ms`;

			expect(
				Math.abs(recovered - PLANTED_DELAY_MS) / PLANTED_DELAY_MS,
				`the medians cannot resolve the limit this case decides on: ${measured}`,
			).toBeLessThan(PLANT_RECOVERY_TOLERANCE);
			expect(Math.abs(known - unknown), `T-TIM-6: ${measured}`).toBeLessThan(
				MEDIAN_DIFFERENCE_LIMIT_MS,
			);
		},
		CASE_TIMEOUT_MS,
	);
});
