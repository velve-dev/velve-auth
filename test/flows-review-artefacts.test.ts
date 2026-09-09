import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { ONE_TIME_TOKEN_LIFETIME_SECONDS } from "../src/core/token/purpose.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;

beforeEach(async () => {
	mounted = await mountAuth("artefacts");
});

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const OWNER = "owner@example.com";
const PASSWORD = "a password long enough to pass";

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function cookieIn(answer: Response): string {
	const value = /__Host-velve_session=([^;]*)/.exec(answer.headers.get("Set-Cookie") ?? "")?.[1];
	return `__Host-velve_session=${value ?? ""}`;
}

function tokenOf(message: EmailMessage | undefined): string {
	if (message === undefined || !("token" in message)) {
		throw new Error(`the ${message?.kind ?? "missing"} message carries no token`);
	}
	return message.token;
}

const lastOf = (kind: EmailMessage["kind"]): EmailMessage | undefined =>
	mounted.email.messages.filter((each) => each.kind === kind).at(-1);

/** The four redeeming rows, each with the purpose it consumes and a body that reaches its handler. */
const REDEEMERS = {
	magic_link: (token: string) => ["/sign-in/magic-link/redeem", { token }] as const,
	email_verify: (token: string) => ["/email/redeem-verification", { token }] as const,
	email_change: (token: string) => ["/email/redeem-change", { token }] as const,
	password_reset: (token: string) =>
		["/password/redeem-reset", { token, newPassword: "another long password" }] as const,
} as const;

type Purpose = keyof typeof REDEEMERS;

const PURPOSES = Object.keys(REDEEMERS) as readonly Purpose[];

async function mintEveryPurpose(): Promise<Record<Purpose, string>> {
	const registration = await post("/sign-up", { email: OWNER, password: PASSWORD });
	const cookie = cookieIn(registration);
	const email_verify = tokenOf(lastOf("email_verification"));
	await post("/sign-in/magic-link/request", { email: OWNER });
	const magic_link = tokenOf(lastOf("magic_link"));
	await post("/password/request-reset", { email: OWNER });
	const password_reset = tokenOf(lastOf("password_reset"));
	await post("/email/request-change", { newEmail: "moved@example.com" }, cookie);
	const email_change = tokenOf(lastOf("email_change"));
	return { email_verify, magic_link, password_reset, email_change };
}

async function answerAt(purpose: Purpose, token: string): Promise<string> {
	const [path, body] = REDEEMERS[purpose](token);
	const answer = await post(path, body);
	return `${answer.status} ${await answer.text()}`;
}

async function tokenRows(): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${mounted.schema}.one_time_token`,
		[],
	);
	return row?.total ?? 0;
}

describe("S-TOKEN-2: a purpose is refused as an invention is", () => {
	it("answers every one of the twelve wrong pairings exactly as an invented token", async () => {
		const minted = await mintEveryPurpose();

		const wrong: string[] = [];
		const invented: string[] = [];
		for (const endpoint of PURPOSES) {
			for (const held of PURPOSES) {
				if (held === endpoint) {
					continue;
				}
				wrong.push(`${endpoint}<-${held} ${await answerAt(endpoint, minted[held])}`);
				invented.push(`${endpoint}<-${held} ${await answerAt(endpoint, "not-a-real-token")}`);
			}
		}

		expect(wrong).toHaveLength(12);
		expect(wrong).toStrictEqual(invented);
	});

	it("leaves a token of the wrong purpose in place rather than spending it", async () => {
		const minted = await mintEveryPurpose();
		const before = await tokenRows();

		await answerAt("email_verify", minted.magic_link);

		expect(await tokenRows()).toBe(before);
	});
});

describe("S-REPLAY-2 and S-REPLAY-3: spent, expired and never issued are one answer", () => {
	it("gives the same answer to all three, for all four purposes", async () => {
		const answers: string[] = [];
		for (const purpose of PURPOSES) {
			const minted = await mintEveryPurpose();
			const spent = minted[purpose];
			await answerAt(purpose, spent);
			const afterSpending = await answerAt(purpose, spent);

			const fresh = await mintEveryPurpose();
			await mounted.connection.query(
				`UPDATE ${mounted.schema}.one_time_token SET expires_at = now() - interval '1 second'`,
				[],
			);
			const afterExpiry = await answerAt(purpose, fresh[purpose]);
			const never = await answerAt(purpose, "a token that was never issued at all");

			answers.push(
				`${purpose} ${afterSpending}`,
				`${purpose} ${afterExpiry}`,
				`${purpose} ${never}`,
			);
			await mounted.connection.query(`DELETE FROM ${mounted.schema}.one_time_token`, []);
			await mounted.connection.query(`DELETE FROM ${mounted.schema}.user`, []);
		}

		expect(answers).toHaveLength(12);
		for (let index = 0; index < answers.length; index += 3) {
			expect(answers[index + 1]).toBe(answers[index]);
			expect(answers[index + 2]).toBe(answers[index]);
		}
	});

	it("removes the row on the one redemption that works", async () => {
		const minted = await mintEveryPurpose();
		const before = await tokenRows();

		await answerAt("magic_link", minted.magic_link);

		expect(await tokenRows()).toBe(before - 1);
	});
});

describe("3.7: the deadline is fixed per purpose and is not a setting", () => {
	it("writes the four deadlines the section names, measured against the row's own clock", async () => {
		await mintEveryPurpose();
		const rows = await mounted.connection.query<{ purpose: string; seconds: number }>(
			`SELECT purpose, round(extract(epoch FROM expires_at - created_at))::int AS seconds
			 FROM ${mounted.schema}.one_time_token ORDER BY purpose`,
			[],
		);

		expect(rows.map((row) => `${row.purpose} ${row.seconds}`)).toStrictEqual([
			"email_change 3600",
			"email_verify 86400",
			"magic_link 600",
			"password_reset 3600",
		]);
	});

	it("agrees with the table the core reads", () => {
		expect(ONE_TIME_TOKEN_LIFETIME_SECONDS).toStrictEqual({
			email_verify: 86_400,
			password_reset: 3_600,
			email_change: 3_600,
			magic_link: 600,
		});
	});

	it("reaches the table from one statement and from no configuration", () => {
		const core = fileURLToPath(new URL("../src/core", import.meta.url));
		const configuration = readFileSync(`${core}/auth/config.ts`, "utf8");
		const repository = readFileSync(`${core}/db/repositories/token.ts`, "utf8");

		expect(configuration).not.toContain("ONE_TIME_TOKEN_LIFETIME_SECONDS");
		expect(configuration).not.toMatch(/expiresIn|tokenLifetime|expiryS/);
		expect(repository.match(/ONE_TIME_TOKEN_LIFETIME_SECONDS\[/g)).toHaveLength(1);
	});
});

describe("3.7: a new artefact of the same purpose supersedes the previous one", () => {
	it("leaves one row and refuses the token it replaced", async () => {
		await post("/sign-up", { email: OWNER, password: PASSWORD });
		await post("/password/request-reset", { email: OWNER });
		const first = tokenOf(lastOf("password_reset"));
		await post("/password/request-reset", { email: OWNER });
		const second = tokenOf(lastOf("password_reset"));

		const superseded = await answerAt("password_reset", first);
		const invented = await answerAt("password_reset", "not-a-real-token");
		const current = await answerAt("password_reset", second);

		expect(first).not.toBe(second);
		expect(superseded).toBe(invented);
		expect(current.startsWith("200")).toBe(true);
	});
});
