import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

//a sign-in or a resolution racing session.revokeAll ends with a session that resolves or without one, and raises no alarm (S-INTEG-3, T-INTEG-3, E-3404)

const PAIRS = 50;
const PASSWORD = "a password long enough for the policy 8e1d";

let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let handler: (request: Request) => Promise<Response>;
const alarms: SecurityStateAlarm[] = [];
let accounts = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("revocation_race");
	pool = await openConnectionPool(8, { defaultIsolation: "repeatable read" });
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema: migrated.schema,
				keys: testKeyProvider(),
				securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
			}),
		),
	);
}, 60_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

function sessionIn(answer: Response): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function signedUp(): Promise<{ email: string; session: string }> {
	accounts += 1;
	const email = `race${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	return { email, session: sessionIn(answer) ?? "" };
}

async function resolves(token: string): Promise<boolean> {
	const answer = await handler(
		new Request("https://api.example.com/session", {
			method: "GET",
			headers: { Origin: TEST_ORIGIN, ...withSession(token) },
		}),
	);
	return answer.status === 200 && (await answer.json()) !== null;
}

async function sessionRowsOf(email: string): Promise<number> {
	const [row] = await migrated.connection.query<{ rows: number }>(
		`SELECT count(*)::int AS rows FROM ${migrated.schema}.session s
		 JOIN ${migrated.schema}.user u ON u.id = s.user_id WHERE u.email = $1`,
		[email],
	);
	return row?.rows ?? -1;
}

describe("T-INTEG-3: the library's sign-in and resolution racing session.revokeAll on repeatable-read connections", () => {
	it(`ends each of ${PAIRS} sign-ins with a session that resolves or with the ordinary failure`, async () => {
		alarms.length = 0;
		const outcomes: string[] = [];
		for (let pair = 0; pair < PAIRS; pair += 1) {
			const account = await signedUp();
			const [signIn, revoked] = await Promise.all([
				handler(postTo("/sign-in/password", { email: account.email, password: PASSWORD })),
				handler(postTo("/session/revoke-all", {}, withSession(account.session))),
			]);
			const issued = sessionIn(signIn);
			const body = (await signIn.json()) as { error?: { code?: string } };
			const outcome =
				issued === null
					? `${signIn.status} ${body.error?.code ?? ""}`
					: (await resolves(issued))
						? "resolves"
						: "issued and dead";
			expect(revoked.status).toBe(200);
			expect(await resolves(account.session)).toBe(false);
			expect(await sessionRowsOf(account.email)).toBe(issued === null ? 0 : 1);
			outcomes.push(outcome);
		}

		expect(
			outcomes.filter((outcome) => outcome !== "resolves" && outcome !== "401 invalid_credentials"),
		).toStrictEqual([]);
		expect(alarms).toStrictEqual([]);
	}, 300_000);

	it(`answers each of ${PAIRS} resolutions with the session or as a missing one`, async () => {
		alarms.length = 0;
		const outcomes: string[] = [];
		for (let pair = 0; pair < PAIRS; pair += 1) {
			const account = await signedUp();
			const other = await handler(
				postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
			);
			const otherSession = sessionIn(other) ?? "";
			const [resolution, revoked] = await Promise.all([
				handler(
					new Request("https://api.example.com/session", {
						method: "GET",
						headers: { Origin: TEST_ORIGIN, ...withSession(account.session) },
					}),
				),
				handler(postTo("/session/revoke-all", {}, withSession(otherSession))),
			]);
			const body = (await resolution.json()) as { session?: unknown } | null;
			expect(revoked.status).toBe(200);
			outcomes.push(
				resolution.status !== 200 ? `${resolution.status}` : body === null ? "missing" : "session",
			);
			expect(await resolves(account.session)).toBe(false);
		}

		expect(
			outcomes.filter((outcome) => outcome !== "session" && outcome !== "missing"),
		).toStrictEqual([]);
		expect(alarms).toStrictEqual([]);
	}, 300_000);
});
