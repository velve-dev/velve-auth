import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	enrolTotp,
	issuedCookieValue,
	PROOF_PASSWORD,
	pendingCookieHeader,
	setCookieNamed,
	totpCodeNow,
	UNLIMITED_RATES,
} from "./proof-fixtures.js";

let mounted: MountedAuth;
let clock: TestClock;

beforeAll(async () => {
	clock = createTestClock(new Date());
	mounted = await mountAuth("pendingexpiry", { clock, rateLimit: UNLIMITED_RATES });
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const PENDING_LIFETIME_IN_SECONDS = 300;

function withoutMaximumAge(attributes: readonly string[]): readonly string[] {
	return attributes.filter((attribute) => !attribute.startsWith("Max-Age="));
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${mounted.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.count ?? -1;
}

/** The pending row is read against the database's clock (3.6), so the row is aged rather than the test's clock. */
async function agePendingStateBy(userId: string, seconds: number): Promise<number> {
	const [row] = await mounted.connection.query<{ aged: number }>(
		`WITH aged AS (
		   UPDATE ${mounted.schema}.pending_authentication
		      SET expires_at = expires_at - make_interval(secs => $2::double precision)
		    WHERE user_id = $1
		   RETURNING 1)
		 SELECT count(*)::int AS aged FROM aged`,
		[userId, seconds],
	);
	return row?.aged ?? 0;
}

describe("the pending-state cookie (S-COOKIE-3, T-COOKIE-3)", () => {
	it("is named __Host-velve_pending, lives 300 s, carries the session cookie's attributes and dies after", async () => {
		const signedUp = await mounted.handler(
			postTo("/sign-up", { email: "pending-expiry@example.com", password: PROOF_PASSWORD }),
		);
		const sessionCookie = setCookieNamed(signedUp, DEFAULT_COOKIE_NAMES.session);
		const { user } = (await signedUp.json()) as { user: { id: string } };
		const secretBase32 = await enrolTotp(mounted.handler, clock, sessionCookie?.value ?? "");

		const firstFactor = await mounted.handler(
			postTo("/sign-in/password", {
				email: "pending-expiry@example.com",
				password: PROOF_PASSWORD,
			}),
		);
		const pendingCookie = setCookieNamed(firstFactor, DEFAULT_COOKIE_NAMES.pending);
		const pendingToken = issuedCookieValue(firstFactor, DEFAULT_COOKIE_NAMES.pending) ?? "";

		expect(pendingCookie?.name).toBe("__Host-velve_pending");
		expect(pendingCookie?.attributes.filter((a) => a.startsWith("Max-Age="))).toStrictEqual([
			`Max-Age=${PENDING_LIFETIME_IN_SECONDS}`,
		]);
		expect(withoutMaximumAge(pendingCookie?.attributes ?? [])).toStrictEqual(
			withoutMaximumAge(sessionCookie?.attributes ?? ["the sign-up set no session cookie"]),
		);

		const sessionsBefore = await sessionsOf(user.id);
		expect(await agePendingStateBy(user.id, PENDING_LIFETIME_IN_SECONDS + 1)).toBe(1);
		const code = totpCodeNow(secretBase32, clock);
		const late = await mounted.handler(
			postTo("/factor/totp/verify", { code }, { Cookie: pendingCookieHeader(pendingToken) }),
		);
		const lateBody = (await late.json()) as { error?: { code: string } };

		expect(`${late.status} ${lateBody.error?.code}`).toBe("401 invalid_pending_authentication");
		expect(issuedCookieValue(late, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await sessionsOf(user.id)).toBe(sessionsBefore);

		const again = await mounted.handler(
			postTo("/sign-in/password", {
				email: "pending-expiry@example.com",
				password: PROOF_PASSWORD,
			}),
		);
		const inTime = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code },
				{
					Cookie: pendingCookieHeader(issuedCookieValue(again, DEFAULT_COOKIE_NAMES.pending) ?? ""),
				},
			),
		);

		//the same code inside the lifetime proves the late one was refused for its age alone
		expect(inTime.status).toBe(200);
		expect(await sessionsOf(user.id)).toBe(sessionsBefore + 1);
	});
});
