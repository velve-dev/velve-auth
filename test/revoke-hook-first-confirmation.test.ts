import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { PluginActor, SessionRevokeEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * The first confirmation of an address that deletes a password set in another session revokes
 * every session of the account (S-LINK-4, L-12), and L-12 names the reason those revocations are
 * announced under: `email_verified`, once per session, before the rows go and inside the
 * transaction the redemption runs in, so a hook that refuses leaves the token, the password, the
 * sessions and the unconfirmed address exactly as they were (E-2730).
 */

const PASSWORD = "correct-horse-battery-staple";
const ACTOR: PluginActor = { pluginId: "recorder", reason: "the test reads the sessions" };

const announced: SessionRevokeEvent[] = [];
const standingWhenAnnounced: boolean[] = [];
let refuse = false;

const RECORDER: VelvePlugin<"recorder"> = {
	id: "recorder",
	hooks: {
		beforeSessionRevoke: async (event, context) => {
			announced.push(event);
			const standing = await context.repositories.listSessionsForUser({
				userId: event.userId,
				actor: ACTOR,
			});
			standingWhenAnnounced.push(standing.some((session) => session.id === event.sessionId));
			if (refuse) {
				throw new Error("the recorder refused the revocation");
			}
		},
	},
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;
const mailed: EmailMessage[] = [];

function send(message: EmailMessage): Promise<void> {
	mailed.push(message);
	return Promise.resolve();
}

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("firstconfirm"));
	pool = await openConnectionPool(4);
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema,
				email: { send },
				plugins: [RECORDER],
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
}, 120_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	announced.length = 0;
	standingWhenAnnounced.length = 0;
	refuse = false;
	mailed.length = 0;
});

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error(`the answer (${answer.status}) wrote no session cookie`);
}

let accounts = 0;

interface PreRegistered {
	readonly email: string;
	readonly userId: string;
	readonly signUpCookie: string;
	readonly verificationToken: string;
}

/** An unconfirmed account whose password the sign-up session set, holding two sessions. */
async function preRegisteredAccount(): Promise<PreRegistered> {
	accounts += 1;
	const address = `firstconfirm${accounts}@example.com`;
	const signedUp = await handler(postTo("/sign-up", { email: address, password: PASSWORD }));
	expect(signedUp.status, await signedUp.clone().text()).toBe(200);
	const verification = mailed.find((message) => message.kind === "email_verification");
	if (verification === undefined || verification.kind !== "email_verification") {
		throw new Error("the sign-up sent no verification message");
	}
	const signedIn = await handler(
		postTo("/sign-in/password", { email: address, password: PASSWORD }),
	);
	expect(signedIn.status).toBe(200);
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[address],
	);
	mailed.length = 0;
	return {
		email: address,
		userId: row?.id ?? "",
		signUpCookie: sessionCookieOf(signedUp),
		verificationToken: verification.token,
	};
}

async function magicLinkTokenFor(address: string): Promise<string> {
	mailed.length = 0;
	const requested = await handler(postTo("/sign-in/magic-link/request", { email: address }));
	expect(requested.status).toBe(204);
	const message = mailed.find((sent) => sent.kind === "magic_link");
	if (message === undefined || message.kind !== "magic_link") {
		throw new Error("no magic link was sent");
	}
	return message.token;
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

async function accountStateOf(userId: string): Promise<{ verified: boolean; passwords: number }> {
	const [row] = await connection.query<{ verified: boolean; passwords: number }>(
		`SELECT email_verified_at IS NOT NULL AS verified,
		        (SELECT count(*)::int FROM ${schema}.password_credential WHERE user_id = $1) AS passwords
		   FROM ${schema}.user WHERE id = $1`,
		[userId],
	);
	return { verified: row?.verified ?? true, passwords: row?.passwords ?? -1 };
}

function eventsFor(userId: string, ids: readonly string[]): SessionRevokeEvent[] {
	return [...ids].sort().map((sessionId) => ({ sessionId, userId, reason: "email_verified" }));
}

function sortedAnnouncements(): SessionRevokeEvent[] {
	return [...announced].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

describe("the S-LINK-4 revocation is announced as email_verified (L-12)", () => {
	it("announces every session a magic link removes from a pre-registered account", async () => {
		const account = await preRegisteredAccount();
		const before = await sessionIdsOf(account.userId);
		expect(before).toHaveLength(2);
		const token = await magicLinkTokenFor(account.email);

		const answer = await handler(postTo("/sign-in/magic-link/redeem", { token }));

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(eventsFor(account.userId, before));
		expect(standingWhenAnnounced).toStrictEqual([true, true]);
		expect(await accountStateOf(account.userId)).toStrictEqual({ verified: true, passwords: 0 });
	}, 60_000);

	it("announces every session a confirmation link from no session removes", async () => {
		const account = await preRegisteredAccount();
		const before = await sessionIdsOf(account.userId);

		const answer = await handler(
			postTo("/email/redeem-verification", { token: account.verificationToken }),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(eventsFor(account.userId, before));
		expect(await sessionIdsOf(account.userId)).toStrictEqual([]);
	}, 60_000);

	it("announces nothing when the session that set the password confirms, as nothing is revoked", async () => {
		const account = await preRegisteredAccount();
		const before = await sessionIdsOf(account.userId);

		const answer = await handler(
			postTo(
				"/email/redeem-verification",
				{ token: account.verificationToken },
				{ Cookie: account.signUpCookie },
			),
		);

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(announced).toStrictEqual([]);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(before);
		expect(await accountStateOf(account.userId)).toStrictEqual({ verified: true, passwords: 1 });
	}, 60_000);
});

describe("a refused S-LINK-4 revocation leaves the confirmation undone as a whole (S-OWNER-12)", () => {
	it("keeps the token, the password, every session and the unconfirmed address", async () => {
		const account = await preRegisteredAccount();
		const before = await sessionIdsOf(account.userId);
		const token = await magicLinkTokenFor(account.email);
		refuse = true;

		const refused = await handler(postTo("/sign-in/magic-link/redeem", { token }));
		refuse = false;

		expect(refused.status).toBe(500);
		expect(announced).toHaveLength(1);
		expect(eventsFor(account.userId, before)).toContainEqual(announced[0]);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(before);
		expect(await accountStateOf(account.userId)).toStrictEqual({ verified: false, passwords: 1 });

		const redeemedLater = await handler(postTo("/sign-in/magic-link/redeem", { token }));
		expect(redeemedLater.status, await redeemedLater.clone().text()).toBe(200);
		expect(await accountStateOf(account.userId)).toStrictEqual({ verified: true, passwords: 0 });
	}, 60_000);
});
