import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { refuseUnlessTheAddressIsStillTheAccounts } from "../src/core/flows/artefact.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import type { OneTimeTokenRedemption } from "../src/core/token/one-time-token.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * Section 3.18 point 3: a one-time token mailed to an address binds that address, and the change
 * confirmation binds the account's old one. A writer who sets user.email to their own address
 * only for the request gets the link mailed to them, restores the address and presents the link;
 * the redemption finds the bound address no longer the account's and answers as a missing token.
 */

const PASSWORD = "correct-horse-battery-staple";
const ATTACKER = "attacker@example.com";

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("token_address_binding", {
		keys: testKeyProvider(),
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

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function tokenMailed(kind: EmailMessage["kind"], to?: string): string {
	const message = mounted.email.messages
		.filter((candidate) => candidate.kind === kind && (to === undefined || candidate.to === to))
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message carrying a token`);
	}
	return message.token;
}

async function signedUp(address: string): Promise<{ userId: string; cookie: string }> {
	const answer = await post("/sign-up", { email: address, password: PASSWORD });
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	const cookie = /__Host-velve_session=[^;]*/.exec(answer.headers.get("Set-Cookie") ?? "")?.[0];
	if (cookie === undefined) {
		throw new Error("no session cookie");
	}
	return { userId, cookie };
}

async function addressMovedDuring<T>(userId: string, moved: string, request: () => Promise<T>) {
	const [before] = await mounted.connection.query<{ email: string }>(
		`SELECT email FROM ${mounted.schema}.user WHERE id = $1`,
		[userId],
	);
	await mounted.connection.query(`UPDATE ${mounted.schema}.user SET email = $2 WHERE id = $1`, [
		userId,
		moved,
	]);
	const answer = await request();
	await mounted.connection.query(`UPDATE ${mounted.schema}.user SET email = $2 WHERE id = $1`, [
		userId,
		before?.email,
	]);
	return answer;
}

async function codeOf(answer: Response): Promise<string | undefined> {
	return ((await answer.json()) as { error?: { code?: string } }).error?.code;
}

describe("a link mailed while a writer had moved the account's address (section 3.18 point 3)", () => {
	it("is refused for a password reset", async () => {
		const { userId } = await signedUp("reset-victim@example.com");
		await addressMovedDuring(userId, ATTACKER, () =>
			post("/password/request-reset", { email: ATTACKER }),
		);

		const answer = await post("/password/redeem-reset", {
			token: tokenMailed("password_reset", ATTACKER),
			newPassword: "the-attackers-own-password",
		});

		expect(answer.status).toBe(400);
		expect(await codeOf(answer)).toBe("invalid_token");
	});

	it("is refused for a magic link", async () => {
		const { userId } = await signedUp("magic-victim@example.com");
		await addressMovedDuring(userId, ATTACKER, () =>
			post("/sign-in/magic-link/request", { email: ATTACKER }),
		);

		const answer = await post("/sign-in/magic-link/redeem", {
			token: tokenMailed("magic_link", ATTACKER),
		});

		expect(answer.status).toBe(400);
		expect(await codeOf(answer)).toBe("invalid_token");
		expect(answer.headers.get("Set-Cookie") ?? "").not.toMatch(/__Host-velve_session=[^;]+/);
	});

	it("is refused for a resent address verification", async () => {
		const { userId, cookie } = await signedUp("verify-victim@example.com");
		await addressMovedDuring(userId, ATTACKER, () =>
			post("/email/request-verification", {}, cookie),
		);

		const answer = await post("/email/redeem-verification", {
			token: tokenMailed("email_verification", ATTACKER),
		});

		expect(answer.status).toBe(400);
		expect(await codeOf(answer)).toBe("invalid_token");
	});

	it("is refused for an address change whose old address was moved for the request", async () => {
		const { userId, cookie } = await signedUp("change-victim@example.com");
		await addressMovedDuring(userId, ATTACKER, () =>
			post("/email/request-change", { newEmail: "changed@example.com" }, cookie),
		);

		const answer = await post("/email/redeem-change", {
			token: tokenMailed("email_change", "changed@example.com"),
		});
		const [row] = await mounted.connection.query<{ email: string }>(
			`SELECT email FROM ${mounted.schema}.user WHERE id = $1`,
			[userId],
		);

		expect(answer.status).toBe(400);
		expect(await codeOf(answer)).toBe("invalid_token");
		expect(row?.email).toBe("change-victim@example.com");
	});

	it("is redeemed when nothing moved, so the binding refuses only the broken state", async () => {
		await signedUp("plain@example.com");
		await post("/password/request-reset", { email: "plain@example.com" });

		const answer = await post("/password/redeem-reset", {
			token: tokenMailed("password_reset", "plain@example.com"),
			newPassword: "a-new-password-entirely",
		});

		expect(answer.status).toBe(200);
	});
});

describe("the comparison a redemption makes (section 3.18 point 3)", () => {
	const redeemed = (payload: OneTimeTokenRedemption["payload"]) =>
		({ userId: "u", purpose: "password_reset", payload }) as unknown as OneTimeTokenRedemption;

	it("raises seal_mismatch once for a moved address and one that was never bound", () => {
		const refusals: TokenBindingRefusal[] = [];
		const store = {
			schema: "velve",
			keys: testKeyProvider(),
			reportTokenBindingRefusal: (refusal: TokenBindingRefusal) => refusals.push(refusal),
		};

		expect(() =>
			refuseUnlessTheAddressIsStillTheAccounts(store, redeemed({ accountEmail: "a@x" }), "b@x"),
		).toThrow();
		expect(() => refuseUnlessTheAddressIsStillTheAccounts(store, redeemed(null), "b@x")).toThrow();
		refuseUnlessTheAddressIsStillTheAccounts(store, redeemed({ accountEmail: null }), null);

		expect(refusals).toStrictEqual([
			{ userId: "u", occasion: "token_redemption", reason: "seal_mismatch", verdict: "mismatch" },
			{ userId: "u", occasion: "token_redemption", reason: "seal_mismatch", verdict: "mismatch" },
		]);
	});
});
