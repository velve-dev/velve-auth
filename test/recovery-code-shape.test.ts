import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normaliseRecoveryCode } from "../src/core/factor/recovery/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

const PASSWORD = "correct-horse-battery-staple";

let configured: MountedAuth;
let unconfigured: MountedAuth;

beforeAll(async () => {
	const rateLimit = {
		perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
		perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
	};
	configured = await mountAuth("recoveryshape", {
		rateLimit,
		recoveryCodes: { count: 4, groupSize: 8 },
	});
	unconfigured = await mountAuth("recoveryshapedefault", { rateLimit });
});

afterAll(async () => {
	for (const mounted of [configured, unconfigured]) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

function cookieIn(answer: Response, name: string): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			return pair.slice(separator + 1);
		}
	}
	return "";
}

let accounts = 0;

async function generateASet(
	mounted: MountedAuth,
): Promise<{ email: string; codes: readonly string[]; headers: Record<string, string> }> {
	accounts += 1;
	const email = `shape${accounts}@example.com`;
	const signedUp = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const headers = {
		Cookie: `${DEFAULT_COOKIE_NAMES.session}=${cookieIn(signedUp, DEFAULT_COOKIE_NAMES.session)}`,
	};
	const generated = await mounted.handler(postTo("/factor/recovery/generate", {}, headers));
	const body = (await generated.json()) as { codes: readonly string[] };

	expect([signedUp.status, generated.status]).toStrictEqual([200, 200]);
	return { email, codes: body.codes, headers };
}

/**
 * A.8 declares `RecoveryCodesConfig { count: number; groupSize: number }` with the defaults 10
 * and 5, and `E-1249` recorded both as reaching the service and being ignored (E-1695).
 */
describe("A.8: the configured recovery-code shape reaches the generator", () => {
	it("draws ten codes in groups of five where nothing is configured", async () => {
		const { codes } = await generateASet(unconfigured);

		expect(codes).toHaveLength(10);
		for (const code of codes) {
			expect(code.split("-")).toStrictEqual([
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}$/),
				expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{2}$/),
			]);
			expect(normaliseRecoveryCode(code)).toHaveLength(32);
		}
	});

	it("draws the configured count in the configured grouping", async () => {
		const { codes } = await generateASet(configured);

		expect(codes).toHaveLength(4);
		for (const code of codes) {
			expect(code.split("-")).toHaveLength(4);
			expect(normaliseRecoveryCode(code)).toHaveLength(32);
		}
	});

	it("reports the configured count back through remaining", async () => {
		const { headers } = await generateASet(configured);
		const answer = await configured.handler(
			new Request("https://api.example.com/factor/recovery/remaining", {
				headers: { Origin: TEST_ORIGIN, ...headers },
			}),
		);

		expect(await answer.json()).toStrictEqual({ remainingCount: 4 });
	});

	/** The grouping is presentation: what is stored is the HMAC of the canonical form. */
	it("redeems a code from a set that was grouped differently", async () => {
		const { email, codes } = await generateASet(configured);
		const signedIn = await configured.handler(
			postTo("/sign-in/password", { email, password: PASSWORD }),
		);
		const pending = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
		const redeemed = await configured.handler(
			postTo(
				"/factor/recovery/verify",
				{ code: codes[0] },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pending}` },
			),
		);
		const body = (await redeemed.json()) as { status: string };

		expect([redeemed.status, body.status]).toStrictEqual([200, "signed_in"]);
	});
});
