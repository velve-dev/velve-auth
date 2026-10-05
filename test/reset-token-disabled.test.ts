import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";

/**
 * A mailed reset token presented for a disabled account is answered as an invented token, and it is
 * spent, as a recovery code presented for one is (E-2872): the account may be disabled because it
 * is compromised, and a token someone else presented must not reset the password once the account
 * is enabled again (E-2879). The answer is the one an invented token gets, status, header set and
 * body, now that one of them commits and the other rolls back (L-4, S-ENUM-2).
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ROUTE = "/password/redeem-reset";
const AN_INVENTED_TOKEN = "an-invented-token-that-was-never-minted";

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("resetdisabled", {
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

async function accountWithAResetToken(email: string): Promise<{ userId: string; token: string }> {
	const signedUp = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	mounted.email.clear();
	const requested = await mounted.handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = mounted.email.messages.find((sent) => sent.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	const [row] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[email],
	);
	return { userId: row?.id ?? "", token: message.token };
}

async function standingResetTokensOf(userId: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.one_time_token
		WHERE user_id = $1 AND purpose = 'password_reset'`,
		[userId],
	);
	return row?.total ?? -1;
}

describe("a mailed reset on a disabled account", () => {
	it("leaves the token spent, so it resets nothing once the account is enabled", async () => {
		const email = "reset-disabled@example.com";
		const { userId, token } = await accountWithAResetToken(email);
		expect(await standingResetTokensOf(userId)).toBe(1);

		await mounted.auth.user.disable({ userId, reason: "the test disables it" });
		const whileDisabled = await mounted.handler(postTo(ROUTE, { token, newPassword: REPLACEMENT }));

		expect(whileDisabled.status).toBe(400);
		expect(await standingResetTokensOf(userId)).toBe(0);

		await mounted.auth.user.enable({ userId });
		const afterEnable = await mounted.handler(postTo(ROUTE, { token, newPassword: REPLACEMENT }));
		const withTheOldPassword = await mounted.handler(
			postTo("/sign-in/password", { email, password: PASSWORD }),
		);

		expect(afterEnable.status).toBe(400);
		expect(withTheOldPassword.status).toBe(200);
	});

	it("answers byte for byte as an invented token", async () => {
		const { userId, token } = await accountWithAResetToken("reset-disabled-bytes@example.com");

		await mounted.auth.user.disable({ userId, reason: "the test disables it" });
		const whileDisabled = await mounted.handler(postTo(ROUTE, { token, newPassword: REPLACEMENT }));
		const invented = await mounted.handler(
			postTo(ROUTE, { token: AN_INVENTED_TOKEN, newPassword: REPLACEMENT }),
		);

		expect(await difference(whileDisabled, invented)).toStrictEqual([]);
	});
});
