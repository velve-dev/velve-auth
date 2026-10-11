import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();

let mounted: MountedAuth;

async function accountWith(email: string, password: string | null): Promise<string> {
	const answer = await mounted.handler(
		postTo(password === null ? "/sign-up/passwordless" : "/sign-up", {
			email,
			...(password === null ? {} : { password }),
		}),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { user: { id: string } }).user.id;
}

beforeAll(async () => {
	mounted = await mountAuth("enumstates", {
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
	await accountWith("unconfirmed@example.com", PASSWORD);
	const confirmed = await accountWith("confirmed@example.com", PASSWORD);
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.user SET email_verified_at = now() WHERE id = $1`,
		[confirmed],
	);
	await mounted.reseal(confirmed);
	const disabled = await accountWith("disabled@example.com", PASSWORD);
	await mounted.auth.user.disable({ userId: disabled, reason: "T-ENUM-2" });
	await accountWith("credentialless@example.com", null);
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

/** Status, every header but `Date`, and the body, exactly as the bytes left the handler. */
async function rawAnswer(answer: Response): Promise<string> {
	const headers = [...answer.headers]
		.filter(([name]) => name !== "date")
		.map(([name, value]) => `${name}: ${value}`)
		.sort();
	const body = Buffer.from(await answer.arrayBuffer()).toString("utf8");
	return [`status ${answer.status}`, ...headers, `body ${body}`].join("\n");
}

const STATES = [
	{ state: "not present", email: "absent@example.com", password: WRONG_PASSWORD },
	{ state: "present and unconfirmed", email: "unconfirmed@example.com", password: WRONG_PASSWORD },
	{ state: "present and confirmed", email: "confirmed@example.com", password: WRONG_PASSWORD },
	{ state: "present and disabled", email: "disabled@example.com", password: WRONG_PASSWORD },
	{
		state: "present without a password credential",
		email: "credentialless@example.com",
		password: WRONG_PASSWORD,
	},
	{ state: "disabled, correct password", email: "disabled@example.com", password: PASSWORD },
] as const;

describe("T-ENUM-2 — six account states, one answer (S-ENUM-2)", () => {
	it("answers all six byte for byte alike and never says account_disabled", async () => {
		const answers: Record<string, string> = {};
		for (const { state, email, password } of STATES) {
			answers[state] = await rawAnswer(
				await mounted.handler(postTo("/sign-in/password", { email, password })),
			);
		}
		const reference = answers["not present"] as string;

		expect(reference).toMatch(/^status 401\n/);
		for (const { state } of STATES) {
			expect(answers[state], state).toBe(reference);
		}
		expect(
			Object.entries(answers)
				.filter(([, answer]) => answer.includes("account_disabled"))
				.map(([state]) => state),
		).toStrictEqual([]);
	}, 60_000);

	it("signs the confirmed account in with the correct password, so the row above is not dead", async () => {
		const answer = await mounted.handler(
			postTo("/sign-in/password", { email: "confirmed@example.com", password: PASSWORD }),
		);
		expect(answer.status).toBe(200);
	}, 60_000);
});
