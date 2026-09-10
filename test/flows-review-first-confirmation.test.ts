import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;

beforeEach(async () => {
	mounted = await mountAuth("linkfour");
});

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const VICTIM = "victim@example.com";
const ATTACKER_PASSWORD = "the password the attacker chose";

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function cookieIn(answer: Response): string {
	const value = /__Host-velve_session=([^;]*)/.exec(answer.headers.get("Set-Cookie") ?? "")?.[1];
	if (value === undefined || value === "") {
		throw new Error("the answer carried no session cookie");
	}
	return `__Host-velve_session=${value}`;
}

function tokenOf(message: EmailMessage | undefined): string {
	if (message === undefined || !("token" in message)) {
		throw new Error(`the ${message?.kind ?? "missing"} message carries no token`);
	}
	return message.token;
}

async function lastMessage(kind: EmailMessage["kind"]): Promise<EmailMessage> {
	const message = mounted.email.messages.filter((each) => each.kind === kind).at(-1);
	if (message === undefined) {
		throw new Error(`no ${kind} message was sent`);
	}
	return message;
}

async function userIdOf(email: string): Promise<string> {
	const [row] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[email],
	);
	if (row === undefined) {
		throw new Error(`no account for ${email}`);
	}
	return row.id;
}

async function count(sql: string, params: readonly unknown[]): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(sql, [...params]);
	return row?.total ?? 0;
}

const sessionsOf = async (userId: string): Promise<number> =>
	count(`SELECT count(*)::int AS total FROM ${mounted.schema}.session WHERE user_id = $1`, [
		userId,
	]);

/** What a sign-in would find. No `/sign-in/password` row is mounted in this tree, so this is the last observable point before it. */
async function storedCredentialOf(userId: string): Promise<unknown> {
	return createPasswordCredentialRepository({
		driver: mounted.connection,
		keys: testKeyProvider(),
		schema: mounted.schema,
	}).findByUserId(userId);
}

describe("T-LINK-4: the three cases S-LINK-4 fixes", () => {
	it("takes the password and every session when a magic link confirms from elsewhere", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		expect(await sessionsOf(userId)).toBe(1);
		await post("/sign-in/magic-link/request", { email: VICTIM });

		await post("/sign-in/magic-link/redeem", { token: tokenOf(await lastMessage("magic_link")) });

		expect(await storedCredentialOf(userId)).toBeNull();
		expect(
			await count(
				`SELECT count(*)::int AS total FROM ${mounted.schema}.session
				 WHERE user_id = $1 AND created_at < (SELECT email_verified_at FROM ${mounted.schema}.user WHERE id = $1)`,
				[userId],
			),
		).toBe(0);
	});

	it("keeps both when the confirmation link is redeemed in the session that set the password", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);

		await post(
			"/email/redeem-verification",
			{ token: tokenOf(await lastMessage("email_verification")) },
			cookieIn(registration),
		);

		expect(await storedCredentialOf(userId)).not.toBeNull();
		expect(await sessionsOf(userId)).toBe(1);
	});

	it("adds no identity row when a magic link lands on an address a provider identity carries", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.identity (user_id, provider, subject, provider_email, provider_email_verified)
			 VALUES ($1, 'google', 'subject-1', $2, true)`,
			[userId, VICTIM],
		);
		const before = await count(`SELECT count(*)::int AS total FROM ${mounted.schema}.identity`, []);
		await post("/sign-in/magic-link/request", { email: VICTIM });

		await post("/sign-in/magic-link/redeem", { token: tokenOf(await lastMessage("magic_link")) });

		expect(await count(`SELECT count(*)::int AS total FROM ${mounted.schema}.identity`, [])).toBe(
			before,
		);
	});
});

describe("S-LINK-4: the deletion is unconditional (L-13 guards two other routes)", () => {
	it("takes the password even when it is the only way into the account", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		expect(await count(`SELECT count(*)::int AS total FROM ${mounted.schema}.identity`, [])).toBe(
			0,
		);
		expect(
			await count(`SELECT count(*)::int AS total FROM ${mounted.schema}.webauthn_credential`, []),
		).toBe(0);
		await post("/sign-in/magic-link/request", { email: VICTIM });

		const answer = await post("/sign-in/magic-link/redeem", {
			token: tokenOf(await lastMessage("magic_link")),
		});

		expect(answer.status).toBe(200);
		expect(await storedCredentialOf(userId)).toBeNull();
	});
});

describe("S-LINK-4: the column the rule is decided on", () => {
	it("reads an unrecorded provenance as a different session", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.password_credential SET set_by_session_id = NULL WHERE user_id = $1`,
			[userId],
		);

		await post(
			"/email/redeem-verification",
			{ token: tokenOf(await lastMessage("email_verification")) },
			cookieIn(registration),
		);

		expect(await storedCredentialOf(userId)).toBeNull();
	});

	/**
	 * Unknown on both sides. A naive `IS DISTINCT FROM` keeps the credential here, which is the one
	 * reading E-609 rejects — and it is the reading that keeps an imported password on an account
	 * whose address a stranger's link has just confirmed.
	 */
	it("takes an unrecorded password when the confirming request carries no session either", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.password_credential SET set_by_session_id = NULL WHERE user_id = $1`,
			[userId],
		);
		await post("/sign-in/magic-link/request", { email: VICTIM });

		await post("/sign-in/magic-link/redeem", { token: tokenOf(await lastMessage("magic_link")) });

		expect(await storedCredentialOf(userId)).toBeNull();
	});

	it("reads a provenance naming a session that is gone as a different session", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		const confirmation = tokenOf(await lastMessage("email_verification"));
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.password_credential SET set_by_session_id = gen_random_uuid() WHERE user_id = $1`,
			[userId],
		);

		await post("/email/redeem-verification", { token: confirmation }, cookieIn(registration));

		expect(await storedCredentialOf(userId)).toBeNull();
	});

	it("does not take a password written after the address was already confirmed", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		await post(
			"/email/redeem-verification",
			{ token: tokenOf(await lastMessage("email_verification")) },
			cookieIn(registration),
		);
		mounted.email.clear();
		await post("/sign-in/magic-link/request", { email: VICTIM });

		await post("/sign-in/magic-link/redeem", { token: tokenOf(await lastMessage("magic_link")) });

		expect(await storedCredentialOf(userId)).not.toBeNull();
	});

	/** A redemption carrying a session of a different account is not the session that set the password. */
	it("takes the password when the confirming session belongs to somebody else", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		const confirmation = tokenOf(await lastMessage("email_verification"));
		const stranger = await post("/sign-up", {
			email: "stranger@example.com",
			password: ATTACKER_PASSWORD,
		});

		await post("/email/redeem-verification", { token: confirmation }, cookieIn(stranger));

		expect(await storedCredentialOf(userId)).toBeNull();
	});

	/**
	 * A confirming request whose cookie resolves to nothing carries no session, and L-12 reads that
	 * as a different one — so an expired or forged cookie may not save the credential.
	 */
	it("takes the password when the confirming cookie resolves to no session", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);

		await post(
			"/email/redeem-verification",
			{ token: tokenOf(await lastMessage("email_verification")) },
			"__Host-velve_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);

		expect(await storedCredentialOf(userId)).toBeNull();
	});
});

describe("S-LINK-4: a change redemption is a first confirmation too", () => {
	it("takes a password set elsewhere when the address moves and is confirmed", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		mounted.email.clear();
		await post("/email/request-change", { newEmail: "moved@example.com" }, cookieIn(registration));
		const change = tokenOf(await lastMessage("email_change"));
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.password_credential SET set_by_session_id = gen_random_uuid() WHERE user_id = $1`,
			[userId],
		);

		const answer = await post("/email/redeem-change", { token: change });

		expect(answer.status).toBe(200);
		expect(await storedCredentialOf(userId)).toBeNull();
	});
});
