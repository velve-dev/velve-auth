import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SessionRevokeEvent, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * L-12 names three routes that reach the S-LINK-4 sweep, and says of all of them that the revoked
 * sessions are announced as `email_verified` and that a hook which throws leaves the token, the
 * password, the sessions and the unconfirmed address as they were (E-2730). The writer's file
 * drives the refusal through the magic link only and the address change not at all; this one
 * drives the confirmation link and the address change, and holds the refused answer to the
 * generic `internal_error` body, so the hook's own message reaches no caller.
 */

const PASSWORD = "correct-horse-battery-staple";
const HOOK_MESSAGE = "the recorder refused the revocation";
const GENERIC_FAILURE =
	'{"error":{"code":"internal_error","message":"The request could not be completed."}}';

const announced: SessionRevokeEvent[] = [];
let refuse = false;

const RECORDER: VelvePlugin<"recorder"> = {
	id: "recorder",
	hooks: {
		beforeSessionRevoke: async (event) => {
			announced.push(event);
			if (refuse) {
				throw new Error(HOOK_MESSAGE);
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
	({ connection, schema } = await openMigratedSchema("firstconfirmall"));
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
	const address = `firstconfirmall${accounts}@example.com`;
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

async function changeTokenFor(account: PreRegistered, newEmail: string): Promise<string> {
	mailed.length = 0;
	const requested = await handler(
		postTo("/email/request-change", { newEmail }, { Cookie: account.signUpCookie }),
	);
	expect(requested.status, await requested.clone().text()).toBe(204);
	const message = mailed.find((sent) => sent.kind === "email_change");
	if (message === undefined || message.kind !== "email_change") {
		throw new Error("no change message was sent");
	}
	mailed.length = 0;
	return message.token;
}

async function sessionIdsOf(userId: string): Promise<string[]> {
	const rows = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

interface AccountState {
	readonly email: string | null;
	readonly verified: boolean;
	readonly passwords: number;
}

async function accountStateOf(userId: string): Promise<AccountState> {
	const [row] = await connection.query<AccountState>(
		`SELECT email, email_verified_at IS NOT NULL AS verified,
		        (SELECT count(*)::int FROM ${schema}.password_credential WHERE user_id = $1) AS passwords
		   FROM ${schema}.user WHERE id = $1`,
		[userId],
	);
	return {
		email: row?.email ?? null,
		verified: row?.verified ?? true,
		passwords: row?.passwords ?? -1,
	};
}

function eventsFor(userId: string, ids: readonly string[]): SessionRevokeEvent[] {
	return [...ids].sort().map((sessionId) => ({ sessionId, userId, reason: "email_verified" }));
}

function sortedAnnouncements(): SessionRevokeEvent[] {
	return [...announced].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

describe("email.redeemChange reaches the S-LINK-4 sweep and announces it (L-12)", () => {
	it("announces every session once as email_verified when a change is the first confirmation", async () => {
		const account = await preRegisteredAccount();
		const newEmail = `moved${accounts}@example.com`;
		const token = await changeTokenFor(account, newEmail);
		const before = await sessionIdsOf(account.userId);
		expect(before).toHaveLength(2);

		const answer = await handler(postTo("/email/redeem-change", { token }));

		expect(answer.status, await answer.clone().text()).toBe(200);
		expect(sortedAnnouncements()).toStrictEqual(eventsFor(account.userId, before));
		expect(await sessionIdsOf(account.userId)).toStrictEqual([]);
		expect(await accountStateOf(account.userId)).toStrictEqual({
			email: newEmail,
			verified: true,
			passwords: 0,
		});
	}, 60_000);

	it("leaves the token, the old address, the password and every session when the hook refuses", async () => {
		const account = await preRegisteredAccount();
		const newEmail = `refusedmove${accounts}@example.com`;
		const token = await changeTokenFor(account, newEmail);
		const before = await sessionIdsOf(account.userId);
		refuse = true;

		const refused = await handler(postTo("/email/redeem-change", { token }));
		refuse = false;

		expect(refused.status).toBe(500);
		expect(await refused.text()).toBe(GENERIC_FAILURE);
		expect(announced).toHaveLength(1);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(before);
		expect(await accountStateOf(account.userId)).toStrictEqual({
			email: account.email,
			verified: false,
			passwords: 1,
		});

		const redeemedLater = await handler(postTo("/email/redeem-change", { token }));
		expect(redeemedLater.status, await redeemedLater.clone().text()).toBe(200);
		expect(await accountStateOf(account.userId)).toStrictEqual({
			email: newEmail,
			verified: true,
			passwords: 0,
		});
	}, 60_000);
});

describe("email.redeemVerification undoes the whole confirmation on a refusal (L-12)", () => {
	it("leaves the token, the password, every session and the unconfirmed address", async () => {
		const account = await preRegisteredAccount();
		const before = await sessionIdsOf(account.userId);
		refuse = true;

		const refused = await handler(
			postTo("/email/redeem-verification", { token: account.verificationToken }),
		);
		refuse = false;

		expect(refused.status).toBe(500);
		expect(await refused.text()).toBe(GENERIC_FAILURE);
		expect(announced).toHaveLength(1);
		expect(await sessionIdsOf(account.userId)).toStrictEqual(before);
		expect(await accountStateOf(account.userId)).toStrictEqual({
			email: account.email,
			verified: false,
			passwords: 1,
		});

		const redeemedLater = await handler(
			postTo("/email/redeem-verification", { token: account.verificationToken }),
		);
		expect(redeemedLater.status, await redeemedLater.clone().text()).toBe(200);
		expect(await sessionIdsOf(account.userId)).toStrictEqual([]);
	}, 60_000);
});
