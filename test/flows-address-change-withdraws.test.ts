import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { refuseUnlessTheAddressIsStillTheAccounts } from "../src/core/flows/artefact.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { toSecretToken } from "../src/core/token/secret-token.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { decodingJsonb } from "./jsonb-decoding-driver.js";

//a confirmed change of address withdraws the links mailed to the old one, so none of them later raises seal_mismatch (E-3278)

const PASSWORD = "correct-horse-battery-staple";
let mounted: MountedAuth;
const keys = testKeyProvider();

beforeAll(async () => {
	mounted = await mountAuth("flows_address_change_withdraws", {
		keys,
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

function tokenMailed(kind: EmailMessage["kind"], to: string): string {
	const message = mounted.email.messages
		.filter((candidate) => candidate.kind === kind && candidate.to === to)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message to ${to}`);
	}
	return message.token;
}

describe("a mailed link after a legitimate change of address", () => {
	it("is withdrawn by the change, so its later redemption raises no seal_mismatch", async () => {
		const answer = await post("/sign-up", { email: "old@example.com", password: PASSWORD });
		const userId = ((await answer.json()) as { user: { id: string } }).user.id;
		const cookie = /__Host-velve_session=[^;]*/.exec(answer.headers.get("Set-Cookie") ?? "")?.[0];
		await post("/password/request-reset", { email: "old@example.com" });
		const resetToken = tokenMailed("password_reset", "old@example.com");

		await post("/email/request-change", { newEmail: "new@example.com" }, cookie);
		const changed = await post("/email/redeem-change", {
			token: tokenMailed("email_change", "new@example.com"),
		});
		expect(changed.status).toBe(200);

		const [standing] = await mounted.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${mounted.schema}.one_time_token
			 WHERE user_id = $1 AND purpose = 'password_reset'`,
			[userId],
		);
		const refusals: TokenBindingRefusal[] = [];
		const redeemed = await createOneTimeTokens(
			createOneTimeTokenRepository({
				driver: decodingJsonb(mounted.connection),
				schema: mounted.schema,
			}),
			{ keys },
		).redeem({ token: toSecretToken(resetToken), purpose: "password_reset" });
		if (redeemed !== null) {
			try {
				refuseUnlessTheAddressIsStillTheAccounts(
					{ schema: mounted.schema, keys, reportTokenBindingRefusal: (r) => refusals.push(r) },
					redeemed,
					"new@example.com",
				);
			} catch {
				//the refusal itself is the expected answer, the report is what is measured
			}
		}

		expect({ standing: standing?.n, refusals }).toStrictEqual({ standing: 0, refusals: [] });
	});
});
