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
 * A refusal at `beforeSessionCreate` on a reset or a password change must leave the old password
 * standing (3.11, a hook may refuse), and E-2796 states that a refused reset leaves its mailed
 * token or recovery code unspent. These cases hold each of the three operations to that, and
 * present the same secret again once the refusal is lifted.
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
	mounted = await mountAuth("sessionveto", {
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
	const email = `sessionveto${accounts}@example.com`;
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

async function signInStatusWith(account: Account, password: string): Promise<number> {
	const answer = await mounted.handler(
		postTo("/sign-in/password", { email: account.email, password }),
	);
	return answer.status;
}

describe("a refused session leaves the password and the presented secret as they were (E-2796)", () => {
	it("keeps the mailed reset token usable after a refused reset", async () => {
		const account = await signUp();
		const token = await resetTokenFor(account.email);
		refuseAtBeforeSessionCreate = true;
		const refused = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		refuseAtBeforeSessionCreate = false;

		const again = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);

		expect([refused.status, again.status]).toStrictEqual([403, 200]);
		expect(await signInStatusWith(account, REPLACEMENT)).toBe(200);
	});

	it("keeps the recovery code usable and the old password after a refused recovery reset", async () => {
		const account = await signUp();
		const code = await recoveryCodeFor(account);
		const attempt = {
			email: account.email,
			recoveryCode: code,
			newPassword: REPLACEMENT,
		};
		refuseAtBeforeSessionCreate = true;
		const refused = await mounted.handler(
			postTo("/password/redeem-reset-with-recovery-code", attempt),
		);
		refuseAtBeforeSessionCreate = false;
		const sessionsAfterRefusal = await sessionIdsOf(account.userId);

		const again = await mounted.handler(
			postTo("/password/redeem-reset-with-recovery-code", attempt),
		);

		expect(refused.status).toBe(403);
		expect(refused.headers.getSetCookie().join(";")).not.toContain(
			`${DEFAULT_COOKIE_NAMES.session}=`,
		);
		expect(sessionsAfterRefusal).toHaveLength(1);
		expect(again.status, await again.clone().text()).toBe(200);
	});

	it("keeps the old password and the calling session after a refused password change", async () => {
		const account = await signUp();
		refuseAtBeforeSessionCreate = true;
		const refused = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
				withSession(account.sessionToken),
			),
		);
		refuseAtBeforeSessionCreate = false;
		const sessionsAfterRefusal = await sessionIdsOf(account.userId);

		expect(refused.status).toBe(403);
		expect(sessionsAfterRefusal).toHaveLength(1);
		expect(await signInStatusWith(account, PASSWORD)).toBe(200);
	});
});
