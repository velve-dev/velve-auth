import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { readsPendingCookie } from "../src/core/http/route.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

let mounted: MountedAuth;
let clock: TestClock;

const PASSWORD = "correct-horse-battery-staple";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

beforeAll(async () => {
	// The buckets are not this file's subject, and a shared per-route bucket refuses the eleventh
	// request before the handshake it is about has run.
	clock = createTestClock();
	mounted = await mountAuth("factorroutes", {
		clock,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			return pair.slice(separator + 1);
		}
	}
	return null;
}

function sessionCookie(answer: Response): string | null {
	const value = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	return value === "" ? null : value;
}

function pendingCookie(answer: Response): string | null {
	const value = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	return value === "" ? null : value;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

let accounts = 0;

async function signUp(): Promise<{ email: string; sessionToken: string }> {
	accounts += 1;
	const email = `factor${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = sessionCookie(answer);
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, sessionToken };
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

/**
 * S-REPLAY-4 refuses a time step that has already been claimed, and `enroll.finish` claims one —
 * so a verification in the same window is a replay of the enrolment's own code. Every test that
 * signs in after enrolling steps past it, which is the requirement showing rather than an
 * inconvenience (E-1252).
 */
function stepPastTheEnrolmentsWindow(): void {
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
}

async function enrolTotp(sessionToken: string): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: codeNow(secretBase32) },
			withSession(sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	return secretBase32;
}

interface SecondFactorOffered {
	readonly pendingToken: string;
	readonly availableFactors: readonly string[];
}

async function signInToTheIntermediateState(email: string): Promise<SecondFactorOffered> {
	const answer = await mounted.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
	const body = (await answer.json()) as {
		status: string;
		pending: { availableFactors: readonly string[] };
	};
	const pendingToken = pendingCookie(answer);
	expect([answer.status, body.status]).toStrictEqual([200, "second_factor_required"]);
	expect(sessionCookie(answer)).toBeNull();
	if (pendingToken === null) {
		throw new Error("the intermediate state reached no cookie");
	}
	return { pendingToken, availableFactors: body.pending.availableFactors };
}

/**
 * The claim `README.md` carried until this branch was that the library reaches a second-factor
 * handshake no mounted route can complete. This is the whole of that handshake over HTTP, and it
 * is what makes the sentence false (E-1242).
 */
describe("the second-factor handshake, end to end over HTTP (3.6)", () => {
	it("carries a password sign-in through TOTP into a session", async () => {
		const account = await signUp();
		const secretBase32 = await enrolTotp(account.sessionToken);

		stepPastTheEnrolmentsWindow();
		const offered = await signInToTheIntermediateState(account.email);
		expect(offered.availableFactors).toStrictEqual(["totp"]);

		const verified = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: codeNow(secretBase32) },
				withPending(offered.pendingToken),
			),
		);
		const body = (await verified.json()) as { status: string; session: { factors: string[] } };

		expect(verified.status).toBe(200);
		expect(body.status).toBe("signed_in");
		// 3.6: the session records what was actually spent, and both factors were.
		expect([...body.session.factors].sort()).toStrictEqual(["password", "totp"]);
		expect(sessionCookie(verified)).not.toBeNull();
		// S-FIX-1: the intermediate state is gone, and the cookie for it goes in the same answer.
		expect(cookieIn(verified, DEFAULT_COOKIE_NAMES.pending)).toBe("");
	});

	it("refuses to spend the same intermediate state twice", async () => {
		const account = await signUp();
		const secretBase32 = await enrolTotp(account.sessionToken);
		stepPastTheEnrolmentsWindow();
		const offered = await signInToTheIntermediateState(account.email);

		const spent = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: codeNow(secretBase32) },
				withPending(offered.pendingToken),
			),
		);
		const replayed = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code: codeNow(secretBase32) },
				withPending(offered.pendingToken),
			),
		);
		const body = (await replayed.json()) as { error: { code: string } };

		expect(spent.status).toBe(200);
		expect(`${replayed.status} ${body.error.code}`).toBe("401 invalid_pending_authentication");
	});
});

describe("recovery codes are the way back the username mode depends on (3.6, S-DEFAULT-4)", () => {
	it("generates a set, spends one on a sign-in, and counts one fewer", async () => {
		const account = await signUp();
		await enrolTotp(account.sessionToken);

		const generated = await mounted.handler(
			postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
		);
		const { codes } = (await generated.json()) as { codes: readonly string[] };
		const offered = await signInToTheIntermediateState(account.email);

		expect(generated.status).toBe(200);
		expect(codes).toHaveLength(10);
		expect([...offered.availableFactors].sort()).toStrictEqual(["recovery", "totp"]);

		const verified = await mounted.handler(
			postTo("/factor/recovery/verify", { code: codes[0] }, withPending(offered.pendingToken)),
		);
		const body = (await verified.json()) as { status: string; session: { factors: string[] } };
		const remaining = await mounted.handler(
			new Request("https://api.example.com/factor/recovery/remaining", {
				headers: { Origin: "https://app.example.com", ...withSession(account.sessionToken) },
			}),
		);

		expect(verified.status).toBe(200);
		expect(body.status).toBe("signed_in");
		expect([...body.session.factors].sort()).toStrictEqual(["password", "recovery"]);
		expect(await remaining.json()).toStrictEqual({ remainingCount: 9 });
	});

	it("refuses a code that was already spent, and one that never existed, alike", async () => {
		const account = await signUp();
		await enrolTotp(account.sessionToken);
		const generated = await mounted.handler(
			postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
		);
		const { codes } = (await generated.json()) as { codes: readonly string[] };

		const spent = codes[0] ?? "";
		const first = await signInToTheIntermediateState(account.email);
		await mounted.handler(
			postTo("/factor/recovery/verify", { code: spent }, withPending(first.pendingToken)),
		);

		const second = await signInToTheIntermediateState(account.email);
		const replayed = await mounted.handler(
			postTo("/factor/recovery/verify", { code: spent }, withPending(second.pendingToken)),
		);
		const third = await signInToTheIntermediateState(account.email);
		const invented = await mounted.handler(
			postTo(
				"/factor/recovery/verify",
				{ code: "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD" },
				withPending(third.pendingToken),
			),
		);

		// S-OWNER-8's shape on a code rather than a row: consumed and never issued are one answer.
		expect(await difference(replayed, invented)).toStrictEqual([]);
	});
});

describe("what may read `__Host-velve_pending` once every row is mounted (3.6, S-CACHE-4)", () => {
	it("declares caller `pending` for exactly the four routes 3.6 names, and no fifth", () => {
		const routes = widestVelveAuth().routes;
		const authorised = routes.filter((route) => route.caller === "pending").map((r) => r.name);

		expect(PENDING_CALLER_ROUTES).toHaveLength(4);
		expect([...authorised].sort()).toStrictEqual([...PENDING_CALLER_ROUTES].sort());
	});

	it("lets the four plus the two that report and cancel the state read the cookie, and nobody else", () => {
		const routes = widestVelveAuth().routes;
		const readers = routes.filter(readsPendingCookie).map((route) => route.name);

		expect([...readers].sort()).toStrictEqual(
			[...PENDING_CALLER_ROUTES, "pending.read", "pending.cancel"].sort(),
		);
	});
});
