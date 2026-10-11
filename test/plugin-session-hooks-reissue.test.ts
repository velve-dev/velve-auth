import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { registerPluginErrorCodes, VelveError } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * 3.11 enumerates `beforeSessionCreate` and `afterSessionCreate`, and the specification's own
 * comparison table (F40) says there is no session update hook because a session is never
 * rewritten but issued anew, so every issue is a creation these two points report. The two
 * password resets sign the caller in and a password change re-issues the caller's session
 * (S-FIX-1), and none of the three runs either point, so a plugin refusing an account at
 * `beforeSessionCreate` is bypassed by resetting its password (E-2794 reports this and leaves it
 * open).
 */

type SessionPoint = "beforeSessionCreate" | "afterSessionCreate";

interface Fired {
	readonly point: SessionPoint;
	readonly event: Readonly<Record<string, unknown>>;
}

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const REFUSED = { httpStatus: 403, message: "Refused by the session spy." } as const;

let mounted: MountedAuth;
let clock: TestClock;
const fired: Fired[] = [];
let refuseAtBeforeSessionCreate = false;

function at(point: SessionPoint) {
	return (event: object): Promise<void> => {
		fired.push({ point, event: { ...event } });
		return point === "beforeSessionCreate" && refuseAtBeforeSessionCreate
			? Promise.reject(new VelveError("sessionspy.refused"))
			: Promise.resolve();
	};
}

const SPY: VelvePlugin<"sessionspy"> = {
	id: "sessionspy",
	hooks: {
		beforeSessionCreate: at("beforeSessionCreate"),
		afterSessionCreate: at("afterSessionCreate"),
	},
};

beforeAll(async () => {
	registerPluginErrorCodes({ "sessionspy.refused": REFUSED });
	clock = createTestClock();
	mounted = await mountAuth("sessionreissue", {
		clock,
		plugins: [SPY],
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

beforeEach(() => {
	fired.length = 0;
	refuseAtBeforeSessionCreate = false;
});

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

let accounts = 0;

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) wrote no session cookie`);
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `sessionreissue${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status, await answer.clone().text()).toBe(200);
	const [row] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[email],
	);
	return { email, userId: row?.id ?? "", sessionToken: sessionCookieOf(answer) };
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

async function resetTokenFor(email: string): Promise<string> {
	mounted.email.clear();
	const requested = await mounted.handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = mounted.email.messages.find((sent) => sent.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

async function recoveryCodeFor(account: Account): Promise<string> {
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now())) },
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	const generated = await mounted.handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	const { codes } = (await generated.json()) as { codes: readonly string[] };
	return codes[0] ?? "";
}

async function expectTheSessionPointsAroundTheOneSession(account: Account): Promise<void> {
	const [sessionId] = await sessionIdsOf(account.userId);
	expect(fired).toStrictEqual([
		{
			point: "beforeSessionCreate",
			event: { userId: account.userId, factors: ["password"] },
		},
		{
			point: "afterSessionCreate",
			event: { userId: account.userId, factors: ["password"], sessionId },
		},
	]);
}

describe("every session a password operation issues runs the session points (3.11, F40)", () => {
	it("runs beforeSessionCreate and afterSessionCreate on a reset by mailed token", async () => {
		const account = await signUp();
		const token = await resetTokenFor(account.email);
		fired.length = 0;

		const answer = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		await expectTheSessionPointsAroundTheOneSession(account);
	});

	it("runs beforeSessionCreate and afterSessionCreate on a reset by recovery code", async () => {
		const account = await signUp();
		const code = await recoveryCodeFor(account);
		fired.length = 0;

		const answer = await mounted.handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: account.email,
				recoveryCode: code,
				newPassword: REPLACEMENT,
			}),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		await expectTheSessionPointsAroundTheOneSession(account);
	});

	it("runs beforeSessionCreate and afterSessionCreate on the re-issue of password.change", async () => {
		const account = await signUp();
		fired.length = 0;

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
				withSession(account.sessionToken),
			),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		await expectTheSessionPointsAroundTheOneSession(account);
	});

	it("signs nobody in by a reset when beforeSessionCreate refuses", async () => {
		const account = await signUp();
		const token = await resetTokenFor(account.email);
		refuseAtBeforeSessionCreate = true;

		const answer = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		refuseAtBeforeSessionCreate = false;
		const withTheOldPassword = await mounted.handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);

		expect(answer.status).toBe(403);
		expect(answer.headers.getSetCookie().join(";")).not.toContain(
			`${DEFAULT_COOKIE_NAMES.session}=`,
		);
		expect(withTheOldPassword.status).toBe(200);
	});
});
