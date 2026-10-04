import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { randomBytes } from "../src/core/token/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

const PASSWORD = drawTestPassword();

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("replayanswers", {
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function signUp(email: string): Promise<string> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return pair.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
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

async function expireEveryOutstandingToken(): Promise<void> {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.one_time_token SET expires_at = now() - interval '1 second'`,
		[],
	);
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

interface Purpose {
	readonly purpose: string;
	/** Mints a fresh token of this purpose and hands it back. */
	readonly issue: () => Promise<string>;
	readonly redeem: (token: string) => Request;
}

async function purposes(): Promise<Purpose[]> {
	const verifySession = await signUp("verify@example.com");
	const changeSession = await signUp("change@example.com");
	await signUp("reset@example.com");
	await signUp("magic@example.com");
	let changes = 0;

	return [
		{
			purpose: "email_verify",
			issue: async () => {
				await mounted.handler(
					postTo("/email/request-verification", {}, withSession(verifySession)),
				);
				return lastToken("email_verification");
			},
			redeem: (token) => postTo("/email/redeem-verification", { token }),
		},
		{
			purpose: "password_reset",
			issue: async () => {
				await mounted.handler(postTo("/password/request-reset", { email: "reset@example.com" }));
				return lastToken("password_reset");
			},
			redeem: (token) => postTo("/password/redeem-reset", { token, newPassword: PASSWORD }),
		},
		{
			purpose: "email_change",
			issue: async () => {
				changes += 1;
				await mounted.handler(
					postTo(
						"/email/request-change",
						{ newEmail: `changed${changes}@example.com` },
						withSession(changeSession),
					),
				);
				return lastToken("email_change");
			},
			redeem: (token) => postTo("/email/redeem-change", { token }),
		},
		{
			purpose: "magic_link",
			issue: async () => {
				await mounted.handler(
					postTo("/sign-in/magic-link/request", { email: "magic@example.com" }),
				);
				return lastToken("magic_link");
			},
			redeem: (token) => postTo("/sign-in/magic-link/redeem", { token }),
		},
	];
}

describe("T-REPLAY-3 — expired, used and invented are one answer for every purpose (S-REPLAY-3)", () => {
	it("answers all twelve byte for byte alike", async () => {
		const answers = new Map<string, string>();
		const firstRedemptions: number[] = [];

		for (const { purpose, issue, redeem } of await purposes()) {
			const expiring = await issue();
			await expireEveryOutstandingToken();
			answers.set(`${purpose} expired`, await rawAnswer(await mounted.handler(redeem(expiring))));

			const used = await issue();
			const first = await mounted.handler(redeem(used));
			firstRedemptions.push(first.status);
			answers.set(`${purpose} used`, await rawAnswer(await mounted.handler(redeem(used))));

			const invented = encodeBase64Url(randomBytes(32));
			answers.set(`${purpose} invented`, await rawAnswer(await mounted.handler(redeem(invented))));
		}

		expect(firstRedemptions, "each used token was a live one before it was used").toStrictEqual([
			200, 200, 200, 200,
		]);
		expect(answers.size).toBe(12);
		const reference = answers.get("email_verify expired") as string;
		expect(reference).toMatch(/^status 4\d\d\n/);
		for (const [name, answer] of answers) {
			expect(answer, name).toBe(reference);
		}
	}, 60_000);
});
