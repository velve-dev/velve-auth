import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	enrolTotp,
	issuedCookieValue,
	mountWidest,
	PROOF_PASSWORD,
	pendingCookieHeader,
	sessionCookieHeader,
	snapshotOfEveryTable,
	type WidestMount,
} from "./proof-fixtures.js";

let mounted: WidestMount;
let clock: TestClock;
let sessionToken: string;
let sessionId: string;
let pendingToken: string;

/** The seven reading routes S-CSRF-4 names, and the one GET that may write because it is protected otherwise. */
const READING_GET_ROUTES = [
	"/session",
	"/session/list",
	"/username/available",
	"/factor/webauthn/list",
	"/factor/recovery/remaining",
	"/identity/list",
	"/pending",
] as const;
const STATE_CHANGING_GET_ROUTE = "/sign-in/oauth/callback/:provider";

const QUERY_OF: Readonly<Record<string, string>> = { "/username/available": "?username=freename" };

beforeAll(async () => {
	clock = createTestClock(new Date());
	mounted = await mountWidest("csrfget", { clock });
	const signedUp = await mounted.handler(
		postTo("/sign-up", {
			email: "reader@example.com",
			username: "reader",
			password: PROOF_PASSWORD,
		}),
	);
	sessionToken = issuedCookieValue(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
	sessionId = ((await signedUp.json()) as { session: { id: string } }).session.id;
	await mounted.handler(
		postTo("/factor/recovery/generate", {}, { Cookie: sessionCookieHeader(sessionToken) }),
	);

	const secondFactorAccount = await mounted.handler(
		postTo("/sign-up", {
			email: "pending@example.com",
			username: "pending",
			password: PROOF_PASSWORD,
		}),
	);
	await enrolTotp(
		mounted.handler,
		clock,
		issuedCookieValue(secondFactorAccount, DEFAULT_COOKIE_NAMES.session) ?? "",
	);
	const firstFactor = await mounted.handler(
		postTo("/sign-in/password", { emailOrUsername: "pending", password: PROOF_PASSWORD }),
	);
	pendingToken = issuedCookieValue(firstFactor, DEFAULT_COOKIE_NAMES.pending) ?? "";
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

//the token mac binds the idle deadline so an extension writes it again (E-3520)
const PERMITTED_SESSION_WRITES = ["last_used_at", "idle_expires_at", "token_mac"];

/**
 * What a reading route may change, taken out of a snapshot: the rate buckets, and the idle
 * deadline of the caller's own session row with its last use and the MAC over it.
 */
function withoutPermittedWrites(
	snapshot: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
	const kept = new Map(snapshot);
	kept.delete("rate_bucket");
	kept.set(
		"session",
		(snapshot.get("session") ?? []).map((row) => {
			const parsed = JSON.parse(row) as Record<string, unknown>;
			if (parsed.id === sessionId) {
				for (const column of PERMITTED_SESSION_WRITES) {
					delete parsed[column];
				}
			}
			return JSON.stringify(parsed);
		}),
	);
	return kept;
}

/** The permitted write happens on every call this way, so the exception is exercised and not only declared. */
async function ageCallersLastUseBeyondTheWriteInterval(): Promise<number> {
	const [row] = await mounted.connection.query<{ aged: number }>(
		`WITH aged AS (
		   UPDATE ${mounted.schema}.session SET last_used_at = last_used_at - interval '2 hours'
		    WHERE id = $1
		   RETURNING 1)
		 SELECT count(*)::int AS aged FROM aged`,
		[sessionId],
	);
	return row?.aged ?? 0;
}

describe("no state-changing operation is reachable through GET (S-CSRF-4, T-CSRF-4)", () => {
	it("serves as GET only the seven reading routes and the OAuth callback", () => {
		const served = mounted.auth.routes
			.filter((route) => route.method === "GET")
			.map((route) => route.path)
			.sort();

		expect(served).toStrictEqual([...READING_GET_ROUTES, STATE_CHANGING_GET_ROUTE].sort());
	});

	it.each(READING_GET_ROUTES)("GET %s answers and writes no row of any table", async (path) => {
		const idleWriteDue = await ageCallersLastUseBeyondTheWriteInterval();
		const before = await snapshotOfEveryTable(mounted.connection, mounted.schema);
		const answer = await mounted.handler(
			new Request(`https://api.example.com${path}${QUERY_OF[path] ?? ""}`, {
				method: "GET",
				headers: {
					Origin: TEST_ORIGIN,
					Cookie: `${sessionCookieHeader(sessionToken)}; ${pendingCookieHeader(pendingToken)}`,
				},
			}),
		);
		const body = await answer.text();
		const after = await snapshotOfEveryTable(mounted.connection, mounted.schema);

		expect(idleWriteDue).toBe(1);
		expect([answer.status, body === "null"]).toStrictEqual([200, false]);
		expect([...before.keys()].length).toBeGreaterThan(10);
		expect(withoutPermittedWrites(after)).toStrictEqual(withoutPermittedWrites(before));
	});

	it("sees a write a reading route would make, so an unchanged snapshot means something", async () => {
		const before = await snapshotOfEveryTable(mounted.connection, mounted.schema);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.pending_authentication SET attempts = attempts + 1`,
			[],
		);
		const after = await snapshotOfEveryTable(mounted.connection, mounted.schema);

		expect(withoutPermittedWrites(after)).not.toStrictEqual(withoutPermittedWrites(before));
	});
});
