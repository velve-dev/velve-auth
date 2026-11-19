import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { EmailChangedEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import {
	configFor,
	createLogSink,
	type MountedAuth,
	mountAuth,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * Review of S-LINK-8 against the requirement rather than against the writer's cases: the previous
 * address is the one the account had when the change committed, also when two changes race; no
 * redemption that commits nothing tells anybody, including an expired token and a redemption a
 * refusing plugin rolls back; the hook cannot alter what the caller is told; and a notice that
 * could not be sent is never lost without a trace.
 */

const PASSWORD = drawTestPassword();
const AN_INVENTED_TOKEN = "an-invented-token-that-was-never-minted";
const keys = testKeyProvider();
const log = createLogSink();

const sent: EmailMessage[] = [];
const heard: EmailChangedEvent[] = [];
let failTheNotice: Error | null = null;
let failTheHook: Error | null = null;
let refuseRevocation = false;
let mutateTheEvent = false;

async function send(message: EmailMessage): Promise<void> {
	if (message.kind === "email_change_notice" && failTheNotice !== null) {
		throw failTheNotice;
	}
	sent.push(message);
}

const listener: VelvePlugin = {
	id: "review_listener",
	hooks: {
		afterEmailChange: async (event) => {
			heard.push({ ...event });
			if (mutateTheEvent) {
				(event as { userId: string }).userId = "00000000-0000-4000-8000-000000000000";
			}
			if (failTheHook !== null) {
				throw failTheHook;
			}
		},
		beforeSessionRevoke: async () => {
			if (refuseRevocation) {
				throw new Error("the listener refuses the revocation");
			}
		},
	},
};

const LIMITS = {
	perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
	perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
};

let mounted: MountedAuth;
let otherConnection: TestConnection;
let otherHandler: (request: Request) => Promise<Response>;

beforeAll(async () => {
	mounted = await mountAuth("acnreview", {
		keys,
		email: { send },
		plugins: [listener],
		rateLimit: LIMITS,
		log: log.write,
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
				log: log.write,
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
	failTheNotice = null;
	failTheHook = null;
	refuseRevocation = false;
	mutateTheEvent = false;
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

async function requestChange(session: Record<string, string>, next: string): Promise<string> {
	const answer = await mounted.handler(
		postTo("/email/request-change", { newEmail: next }, session),
	);
	expect(answer.status).toBe(204);
	const mailed = sent.filter((each) => each.kind === "email_change" && each.to === next).at(-1);
	if (mailed === undefined || mailed.kind !== "email_change") {
		throw new Error(`no email_change was sent to ${next}`);
	}
	return mailed.token;
}

function redeemOn(
	handler: (request: Request) => Promise<Response>,
	token: string,
): Promise<Response> {
	return handler(postTo("/email/redeem-change", { token }));
}

function notices(): readonly EmailMessage[] {
	return sent.filter((each) => each.kind === "email_change_notice");
}

async function addressOf(userId: string): Promise<string | null> {
	const [row] = await mounted.connection.query<{ email: string | null }>(
		`SELECT email FROM ${mounted.schema}.user WHERE id = $1`,
		[userId],
	);
	return row?.email ?? null;
}

describe("a redemption that commits nothing tells nobody (S-LINK-8)", () => {
	it("an expired change token sends no notice, runs no hook and answers as an invented one", async () => {
		const { userId, session } = await signUp("expired@example.com");
		const token = await requestChange(session, "expired-new@example.com");
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.one_time_token SET expires_at = now() - interval '1 minute'
			WHERE user_id = $1 AND purpose = 'email_change'`,
			[userId],
		);
		sent.length = 0;

		const expired = await normalisedAnswer(await redeemOn(mounted.handler, token));
		const invented = await normalisedAnswer(await redeemOn(mounted.handler, AN_INVENTED_TOKEN));

		expect(expired).toBe(invented);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect(await addressOf(userId)).toBe("expired@example.com");
	});

	it("a redemption a plugin rolls back sends no notice, runs no hook and keeps the address", async () => {
		const { userId, session } = await signUp("rolledback@example.com");
		const token = await requestChange(session, "rolledback-new@example.com");
		sent.length = 0;
		refuseRevocation = true;

		const answer = await redeemOn(mounted.handler, token);

		expect(answer.status).toBe(500);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect(await addressOf(userId)).toBe("rolledback@example.com");
	});

	it("a change token replaced by a later request sends no notice, and the live one sends one", async () => {
		const { userId, session } = await signUp("first@example.com");
		const replaced = await requestChange(session, "second@example.com");
		const live = await requestChange(session, "third@example.com");
		sent.length = 0;

		const stale = await redeemOn(mounted.handler, replaced);

		expect(stale.status).toBe(400);
		expect({ notices: notices().length, heard: heard.length }).toStrictEqual({
			notices: 0,
			heard: 0,
		});
		expect((await redeemOn(mounted.handler, live)).status).toBe(200);
		expect(notices()).toStrictEqual([
			{ kind: "email_change_notice", to: "first@example.com", userId },
		]);
		expect(heard).toStrictEqual([{ userId }]);
		expect(await addressOf(userId)).toBe("third@example.com");
	});
});

describe("the previous address is the one the change replaced, also under a race (S-LINK-8)", () => {
	it("a replaced and a live change token of one account redeemed at once notify the previous address once", async () => {
		for (let round = 0; round < 3; round += 1) {
			const origin = `race${round}@example.com`;
			const { userId, session } = await signUp(origin);
			const replaced = await requestChange(session, `race${round}-b@example.com`);
			const live = await requestChange(session, `race${round}-c@example.com`);
			sent.length = 0;
			heard.length = 0;

			const answers = await Promise.all([
				redeemOn(mounted.handler, replaced),
				redeemOn(otherHandler, live),
			]);

			expect(answers.map((answer) => answer.status)).toStrictEqual([400, 200]);
			expect(notices()).toStrictEqual([{ kind: "email_change_notice", to: origin, userId }]);
			expect(heard).toStrictEqual([{ userId }]);
			expect(await addressOf(userId)).toBe(`race${round}-c@example.com`);
		}
	});

	it("two accounts racing for one target address notify only the winner's previous address", async () => {
		const x = await signUp("racex@example.com");
		const y = await signUp("racey@example.com");
		const fromX = await requestChange(x.session, "contested@example.com");
		const fromY = await requestChange(y.session, "contested@example.com");
		sent.length = 0;

		const [ofX, ofY] = await Promise.all([
			redeemOn(mounted.handler, fromX),
			redeemOn(otherHandler, fromY),
		]);
		const statuses = [ofX.status, ofY.status].sort();
		const loser = ofX.status === 200 ? ofY : ofX;
		const winner = ofX.status === 200 ? x : y;

		expect(statuses).toStrictEqual([200, 400]);
		expect(await normalisedAnswer(loser)).toBe(
			await normalisedAnswer(await redeemOn(mounted.handler, AN_INVENTED_TOKEN)),
		);
		expect(notices()).toStrictEqual([
			{
				kind: "email_change_notice",
				to: winner === x ? "racex@example.com" : "racey@example.com",
				userId: winner.userId,
			},
		]);
		expect(heard).toStrictEqual([{ userId: winner.userId }]);
	});
});

describe("the notice and the hook carry nothing and change nothing (S-LINK-8)", () => {
	it("the notice has exactly three fields, none of them the new address or a secret", async () => {
		const { userId, session } = await signUp("fields@example.com");
		const token = await requestChange(session, "fields-new@example.com");
		sent.length = 0;

		await redeemOn(mounted.handler, token);

		const [notice] = notices();
		expect(Object.keys(notice ?? {}).sort()).toStrictEqual(["kind", "to", "userId"]);
		expect(notice).toStrictEqual({ kind: "email_change_notice", to: "fields@example.com", userId });
		const cookie = session.Cookie ?? "";
		const flat = JSON.stringify(notice);
		expect(flat).not.toContain("fields-new");
		expect(flat).not.toContain(token);
		expect(flat).not.toContain(cookie.slice(cookie.indexOf("=") + 1));
	});

	it("a hook that rewrites its event changes neither the answer nor the account", async () => {
		const { userId, session } = await signUp("mutate@example.com");
		const token = await requestChange(session, "mutate-new@example.com");
		mutateTheEvent = true;

		const answer = await redeemOn(mounted.handler, token);

		expect(answer.status).toBe(200);
		const body = (await answer.json()) as { user: { id: string; email: string } };
		expect(body.user).toMatchObject({ id: userId, email: "mutate-new@example.com" });
	});
});

describe("a notice that could not be sent is never lost without a trace (S-LINK-8, E-3713)", () => {
	it("the send failure reaches the log when the hook fails as well", async () => {
		const { userId, session } = await signUp("bothfail@example.com");
		const token = await requestChange(session, "bothfail-new@example.com");
		failTheNotice = new Error("the notice mailer is down 7f3a");
		failTheHook = new Error("the listener is down 9c1e");
		const before = log.lines.length;

		const answer = await redeemOn(mounted.handler, token);

		expect(answer.status).toBe(500);
		expect(await addressOf(userId)).toBe("bothfail-new@example.com");
		const logged = JSON.stringify(log.lines.slice(before));
		expect(logged).toContain("the listener is down 9c1e");
		expect(logged).toContain("the notice mailer is down 7f3a");
	});
});
