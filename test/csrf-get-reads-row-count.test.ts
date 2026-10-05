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
 * T-CSRF-4 as the specification words it: call every reading GET route and compare all tables
 * before and afterwards, with `velve.rate_bucket` and `last_used_at` and `idle_expires_at` of the
 * caller's own session excepted. The reading routes are rate limited by address, so the bucket
 * table is the one table they write (E-2734).
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
let sessionId: string;

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
	sessionId = ((await signedUp.json()) as { session: { id: string } }).session.id;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const PERMITTED_SESSION_WRITES = ["last_used_at", "idle_expires_at"];

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

describe("T-CSRF-4 over every table, as the specification states it", () => {
	it("changes no row of any table but rate_bucket and the caller's two session deadlines across all seven reading routes", async () => {
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

		expect([...before.keys()]).toContain("rate_bucket");
		expect(after.get("rate_bucket")).not.toStrictEqual(before.get("rate_bucket"));
		expect((before.get("session") ?? []).some((row) => row.includes(sessionId))).toBe(true);
		expect(withoutPermittedWrites(after)).toStrictEqual(withoutPermittedWrites(before));
	});
});
