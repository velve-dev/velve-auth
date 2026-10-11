import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * A magic link, an address verification and an address change presented for a disabled account are
 * answered as an invented token, and the token is spent, as both resets spend theirs (E-2872,
 * E-2879): the account may be disabled because it is compromised, and a token someone else
 * presented must not sign in or confirm an address once the account is enabled again. The answer is
 * the one an invented token gets, status, every header but `Date` and the body bytes, now that one
 * of them commits and the other rolls back (L-4, S-ENUM-2, S-REPLAY-3).
 */

const PASSWORD = drawTestPassword();
const AN_INVENTED_TOKEN = "an-invented-token-that-was-never-minted";

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("redeemdisabled", {
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

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function signUp(email: string): Promise<{ userId: string; sessionToken: string }> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const body = (await answer.json()) as { user: { id: string } };
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return {
				userId: body.user.id,
				sessionToken: pair.slice(DEFAULT_COOKIE_NAMES.session.length + 1),
			};
		}
	}
	throw new Error("the sign-up set no session");
}

function lastToken(kind: EmailMessage["kind"]): string {
	const message = mounted.email.messages.filter((sent) => sent.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} was sent`);
	}
	return message.token;
}

/** Status, every header but `Date`, and the body bytes, nothing normalised. */
async function rawAnswer(answer: Response): Promise<string> {
	const headers = [...answer.headers]
		.filter(([name]) => name !== "date")
		.map(([name, value]) => `${name}: ${value}`)
		.sort();
	const body = Buffer.from(await answer.arrayBuffer()).toString("hex");
	return [`status ${answer.status}`, ...headers, `body ${body}`].join("\n");
}

async function standingTokensOf(userId: string, purpose: string): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${mounted.schema}.one_time_token
		WHERE user_id = $1 AND purpose = $2`,
		[userId, purpose],
	);
	return row?.total ?? -1;
}

async function accountRowOf(
	userId: string,
): Promise<{ email: string | null; email_verified_at: Date | null }> {
	const [row] = await mounted.connection.query<{
		email: string | null;
		email_verified_at: Date | null;
	}>(`SELECT email, email_verified_at FROM ${mounted.schema}.user WHERE id = $1`, [userId]);
	if (row === undefined) {
		throw new Error("the account is gone");
	}
	return row;
}

interface Purpose {
	readonly purpose: string;
	/** Signs an account up and mints one token of this purpose for it. */
	readonly issue: (label: string) => Promise<{ userId: string; token: string }>;
	readonly redeem: (token: string) => Request;
}

const PURPOSES: readonly Purpose[] = [
	{
		purpose: "magic_link",
		issue: async (label) => {
			const email = `magic-${label}@example.com`;
			const { userId } = await signUp(email);
			const requested = await mounted.handler(postTo("/sign-in/magic-link/request", { email }));
			expect(requested.status).toBe(204);
			return { userId, token: lastToken("magic_link") };
		},
		redeem: (token) => postTo("/sign-in/magic-link/redeem", { token }),
	},
	{
		purpose: "email_verify",
		issue: async (label) => {
			const { userId, sessionToken } = await signUp(`verify-${label}@example.com`);
			const requested = await mounted.handler(
				postTo("/email/request-verification", {}, withSession(sessionToken)),
			);
			expect(requested.status).toBe(204);
			return { userId, token: lastToken("email_verification") };
		},
		redeem: (token) => postTo("/email/redeem-verification", { token }),
	},
	{
		purpose: "email_change",
		issue: async (label) => {
			const { userId, sessionToken } = await signUp(`change-${label}@example.com`);
			const requested = await mounted.handler(
				postTo(
					"/email/request-change",
					{ newEmail: `changed-${label}@example.com` },
					withSession(sessionToken),
				),
			);
			expect(requested.status).toBe(204);
			return { userId, token: lastToken("email_change") };
		},
		redeem: (token) => postTo("/email/redeem-change", { token }),
	},
];

describe.each(PURPOSES)("a $purpose token on a disabled account", ({ purpose, issue, redeem }) => {
	it("is spent, so it does nothing once the account is enabled", async () => {
		const { userId, token } = await issue("spent");
		const before = await accountRowOf(userId);
		expect(await standingTokensOf(userId, purpose)).toBe(1);

		await mounted.auth.user.disable({ userId, reason: "the test disables it" });
		const whileDisabled = await mounted.handler(redeem(token));

		expect(whileDisabled.status).toBe(400);
		expect(await standingTokensOf(userId, purpose)).toBe(0);

		await mounted.auth.user.enable({ userId });
		const afterEnable = await mounted.handler(redeem(token));

		expect(afterEnable.status).toBe(400);
		expect(afterEnable.headers.getSetCookie()).toStrictEqual([]);
		expect(await accountRowOf(userId)).toStrictEqual(before);
	});

	it("answers byte for byte as an invented token", async () => {
		const { userId, token } = await issue("bytes");

		await mounted.auth.user.disable({ userId, reason: "the test disables it" });
		const whileDisabled = await rawAnswer(await mounted.handler(redeem(token)));
		const invented = await rawAnswer(await mounted.handler(redeem(AN_INVENTED_TOKEN)));

		expect(whileDisabled).toBe(invented);
	});
});
