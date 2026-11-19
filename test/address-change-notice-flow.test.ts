import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { EmailChangedEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import {
	configFor,
	type MountedAuth,
	mountAuth,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * T-LINK-8: a confirmed address change mails the address the account had before it one
 * `email_change_notice`, after the change has committed, carrying its kind, its recipient and the
 * account and nothing else, and tells `afterEmailChange` the account and nothing else (S-LINK-8,
 * E-3710 to E-3715). A change that does not commit tells nobody, and neither a throwing `send` nor
 * a throwing hook undoes one that did.
 */

const PASSWORD = drawTestPassword();
const AN_INVENTED_TOKEN = "an-invented-token-that-was-never-minted";
const keys = testKeyProvider();

interface Sent {
	readonly message: EmailMessage;
	/** the account's address as a separate connection read it while `send` ran */
	readonly addressWhileSending: string | null;
}

interface Heard {
	readonly event: EmailChangedEvent;
	readonly keys: readonly string[];
	/** the account's address as the hook's own context read it */
	readonly addressWhileHearing: string | null;
}

const sent: Sent[] = [];
const heard: Heard[] = [];
let failTheNotice = false;
let refuseInTheHook = false;

let mounted: MountedAuth;
let otherConnection: TestConnection;
let otherHandler: (request: Request) => Promise<Response>;

async function addressOf(userId: string): Promise<string | null> {
	const [row] = await otherConnection.query<{ email: string | null }>(
		`SELECT email FROM ${mounted.schema}.user WHERE id = $1`,
		[userId],
	);
	return row?.email ?? null;
}

async function send(message: EmailMessage): Promise<void> {
	if (message.kind !== "email_change_notice") {
		sent.push({ message, addressWhileSending: null });
		return;
	}
	if (failTheNotice) {
		throw new Error("the mail server is down");
	}
	sent.push({ message, addressWhileSending: await addressOf(message.userId) });
}

const listener: VelvePlugin = {
	id: "change_listener",
	hooks: {
		afterEmailChange: async (event, context) => {
			const user = await context.repositories.findUserById({
				userId: event.userId,
				actor: { pluginId: "change_listener", reason: "the test reads the changed account" },
			});
			heard.push({
				event: { ...event },
				keys: Object.keys(event).sort(),
				addressWhileHearing: user?.email ?? null,
			});
			if (refuseInTheHook) {
				throw new Error("the listener refuses");
			}
		},
	},
};

const LIMITS = {
	perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
	perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
};

beforeAll(async () => {
	mounted = await mountAuth("addresschangenotice", {
		keys,
		email: { send },
		plugins: [listener],
		rateLimit: LIMITS,
	});
	otherConnection = await openTestConnection();
	otherHandler = toWebHandler(
		createVelveAuth(
			configFor({
				database: otherConnection,
				schema: mounted.schema,
				keys,
				email: { send },
				plugins: [listener],
				rateLimit: LIMITS,
			}),
		),
	);
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await Promise.all([mounted.connection.close(), otherConnection.close()]);
});

beforeEach(() => {
	sent.length = 0;
	heard.length = 0;
	failTheNotice = false;
	refuseInTheHook = false;
});

function sessionCookieOf(answer: Response): Record<string, string> {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return { Cookie: pair };
		}
	}
	throw new Error("the answer carried no session cookie");
}

async function signUp(email: string): Promise<{ userId: string; session: Record<string, string> }> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const body = (await answer.json()) as { user: { id: string } };
	return { userId: body.user.id, session: sessionCookieOf(answer) };
}

function changeTokenTo(newEmail: string): string {
	const message = sent
		.map((entry) => entry.message)
		.filter((each) => each.kind === "email_change" && each.to === newEmail)
		.at(-1);
	if (message === undefined || message.kind !== "email_change") {
		throw new Error(`no email_change was sent to ${newEmail}`);
	}
	return message.token;
}

/** Signs an account up at `previous` and asks to move it to `next`, returning the mailed token. */
async function requestedChange(
	previous: string,
	next: string,
): Promise<{ userId: string; token: string }> {
	const { userId, session } = await signUp(previous);
	const requested = await mounted.handler(
		postTo("/email/request-change", { newEmail: next }, session),
	);
	expect(requested.status).toBe(204);
	return { userId, token: changeTokenTo(next) };
}

function redeem(token: string): Promise<Response> {
	return mounted.handler(postTo("/email/redeem-change", { token }));
}

function notices(): readonly Sent[] {
	return sent.filter((entry) => entry.message.kind === "email_change_notice");
}

describe("a confirmed address change tells the previous address (S-LINK-8)", () => {
	it("mails the previous address one notice that carries its kind, recipient and account only", async () => {
		const { userId, token } = await requestedChange("before@example.com", "after@example.com");

		const answer = await redeem(token);

		expect(answer.status).toBe(200);
		expect(notices().map((entry) => entry.message)).toStrictEqual([
			{ kind: "email_change_notice", to: "before@example.com", userId },
		]);
		const mailed = JSON.stringify(notices().map((entry) => entry.message));
		expect(mailed).not.toContain("after@example.com");
		expect(mailed).not.toContain(token);
	});

	it("sends the notice only once the change has committed", async () => {
		const { userId, token } = await requestedChange("committed@example.com", "moved@example.com");

		await redeem(token);

		expect(notices().map((entry) => entry.addressWhileSending)).toStrictEqual([
			"moved@example.com",
		]);
		expect(await addressOf(userId)).toBe("moved@example.com");
	});

	it("sends the notice on the direct server call too", async () => {
		const { userId, token } = await requestedChange("server@example.com", "server-new@example.com");

		await mounted.auth.email.redeemChange({ token, origin: TEST_ORIGIN });

		expect(notices().map((entry) => entry.message)).toStrictEqual([
			{ kind: "email_change_notice", to: "server@example.com", userId },
		]);
	});
});

describe("a change that does not commit tells nobody (S-LINK-8)", () => {
	it("an invented token sends no notice and runs no hook", async () => {
		const answer = await redeem(AN_INVENTED_TOKEN);

		expect(answer.status).toBe(400);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
	});

	it("a replayed token sends no second notice", async () => {
		const { token } = await requestedChange("replay@example.com", "replay-new@example.com");
		expect((await redeem(token)).status).toBe(200);

		const replayed = await redeem(token);

		expect(replayed.status).toBe(400);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 1,
			heard: 1,
		});
	});

	it("a target address taken since the request sends no notice and answers as an invented token", async () => {
		const { userId, token } = await requestedChange("loser@example.com", "taken@example.com");
		await signUp("taken@example.com");
		sent.length = 0;

		const taken = await redeem(token);
		const invented = await redeem(AN_INVENTED_TOKEN);

		expect(taken.status).toBe(invented.status);
		expect(await taken.text()).toBe(await invented.text());
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect(await addressOf(userId)).toBe("loser@example.com");
	});

	it("a disabled account sends no notice and keeps its address", async () => {
		const { userId, token } = await requestedChange(
			"disabled@example.com",
			"disabled-new@example.com",
		);
		await mounted.auth.user.disable({ userId, reason: "the test disables it" });

		const answer = await redeem(token);

		expect(answer.status).toBe(400);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect(await addressOf(userId)).toBe("disabled@example.com");
	});

	it("two redemptions of one token at once send one notice", async () => {
		const { userId, token } = await requestedChange("racer@example.com", "racer-new@example.com");

		const answers = await Promise.all([
			redeem(token),
			otherHandler(postTo("/email/redeem-change", { token })),
		]);

		expect(answers.map((answer) => answer.status).sort()).toStrictEqual([200, 400]);
		expect(notices().map((entry) => entry.message)).toStrictEqual([
			{ kind: "email_change_notice", to: "racer@example.com", userId },
		]);
		expect(heard.map((entry) => entry.event)).toStrictEqual([{ userId }]);
	});

	it("a change to the address the account already has tells nobody", async () => {
		const { userId, token } = await requestedChange("same@example.com", "same@example.com");

		const answer = await redeem(token);

		expect(answer.status).toBe(200);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect(await addressOf(userId)).toBe("same@example.com");
	});
});

describe("afterEmailChange is told the account and nothing else (S-LINK-8)", () => {
	it("carries only the account id, after the change has committed", async () => {
		const { userId, token } = await requestedChange("hook@example.com", "hook-new@example.com");

		await redeem(token);

		expect(heard).toStrictEqual([
			{ event: { userId }, keys: ["userId"], addressWhileHearing: "hook-new@example.com" },
		]);
	});

	it("a throwing hook answers 500 and does not undo the change or the notice", async () => {
		const { userId, token } = await requestedChange(
			"refused@example.com",
			"refused-new@example.com",
		);
		refuseInTheHook = true;

		const answer = await redeem(token);

		expect(answer.status).toBe(500);
		expect(await answer.text()).not.toContain("the listener refuses");
		expect(await addressOf(userId)).toBe("refused-new@example.com");
		expect(notices().map((entry) => entry.message.to)).toStrictEqual(["refused@example.com"]);
		expect((await redeem(token)).status).toBe(400);
	});
});

describe("a notice that cannot be sent (S-LINK-8)", () => {
	it("answers 500, keeps the committed change and still tells the hook", async () => {
		const { userId, token } = await requestedChange("unsent@example.com", "unsent-new@example.com");
		failTheNotice = true;

		const answer = await redeem(token);

		expect(answer.status).toBe(500);
		expect(await answer.text()).not.toContain("the mail server is down");
		expect(await addressOf(userId)).toBe("unsent-new@example.com");
		expect(heard.map((entry) => entry.event)).toStrictEqual([{ userId }]);
		expect((await redeem(token)).status).toBe(400);
	});
});
