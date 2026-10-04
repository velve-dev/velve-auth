import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock } from "../src/testing/index.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	issuedCookieValue,
	mountWidest,
	PROOF_PASSWORD,
	sessionCookieHeader,
	snapshotOfEveryTable,
	type WidestMount,
} from "./proof-fixtures.js";

/**
 * T-CSRF-4 as the specification words it: call every reading GET route and compare the row counts
 * of all tables before and afterwards, with only `last_used_at` and `idle_expires_at` of the
 * caller's own session excepted. Neither language excepts `velve.rate_bucket`, which E-2732 took out
 * of T-CSRF-1 for the limiter's sake and left in here, while `test/csrf-get-reads-proof.test.ts`
 * drops it from its comparison without the specification saying so.
 */

const READING_GET_ROUTES = [
	"/session",
	"/session/list",
	"/username/available",
	"/factor/webauthn/list",
	"/factor/recovery/remaining",
	"/identity/list",
	"/pending",
] as const;

const QUERY_OF: Readonly<Record<string, string>> = { "/username/available": "?username=freename" };

let mounted: WidestMount;
let sessionToken: string;

beforeAll(async () => {
	mounted = await mountWidest("csrfcount", { clock: createTestClock(new Date()) });
	const signedUp = await mounted.handler(
		postTo("/sign-up", {
			email: "counter@example.com",
			username: "counter",
			password: PROOF_PASSWORD,
		}),
	);
	sessionToken = issuedCookieValue(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function rowCountsOf(snapshot: ReadonlyMap<string, readonly string[]>): Record<string, number> {
	return Object.fromEntries([...snapshot].map(([table, rows]) => [table, rows.length]));
}

describe("T-CSRF-4 row counts over every table, as the specification states them", () => {
	it("changes the row count of no table, rate_bucket included, across all seven reading routes", async () => {
		const before = await snapshotOfEveryTable(mounted.connection, mounted.schema);
		for (const path of READING_GET_ROUTES) {
			await mounted.handler(
				new Request(`https://api.example.com${path}${QUERY_OF[path] ?? ""}`, {
					method: "GET",
					headers: { Origin: TEST_ORIGIN, Cookie: sessionCookieHeader(sessionToken) },
				}),
			);
		}
		const after = await snapshotOfEveryTable(mounted.connection, mounted.schema);

		expect(Object.keys(rowCountsOf(before))).toContain("rate_bucket");
		expect(rowCountsOf(after)).toStrictEqual(rowCountsOf(before));
	});
});
