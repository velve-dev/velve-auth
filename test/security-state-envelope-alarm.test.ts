import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

//a ciphertext copied from another account fails its binding and raises envelope_binding_mismatch (S-INTEG-1, S-INTEG-4)

const PASSWORD = "a password long enough for the policy 3d9a";

let mounted: MountedAuth;
let clock: TestClock;
const alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	clock = createTestClock();
	mounted = await mountAuth("envelope_alarm", {
		clock,
		securityState: { sealing: "migrating", alarm: (alarm) => alarms.push(alarm) },
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

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

async function signUpWithTotp(email: string): Promise<{ userId: string; secret: string }> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	const cookie = {
		Cookie: `${DEFAULT_COOKIE_NAMES.session}=${cookieIn(answer, DEFAULT_COOKIE_NAMES.session)}`,
	};
	const started = await mounted.handler(postTo("/factor/totp/enroll/start", {}, cookie));
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const code = totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
	const finished = await mounted.handler(postTo("/factor/totp/enroll/finish", { code }, cookie));
	expect(finished.status).toBe(204);
	return { userId, secret: secretBase32 };
}

describe("a bound envelope that fails to open raises its alarm (S-INTEG-1, S-INTEG-4)", () => {
	it("raises envelope_binding_mismatch when a factor check meets a copied TOTP ciphertext", async () => {
		const attacker = await signUpWithTotp("attacker@example.com");
		const victim = await signUpWithTotp("victim@example.com");
		clock.advanceBy(60_000);
		const { connection, schema } = mounted;
		await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [
			victim.userId,
		]);
		await connection.query(
			`UPDATE ${schema}.totp_credential SET secret_enc = (SELECT secret_enc FROM ${schema}.totp_credential WHERE user_id = $2),
  key_version = (SELECT key_version FROM ${schema}.totp_credential WHERE user_id = $2) WHERE user_id = $1`,
			[victim.userId, attacker.userId],
		);
		const signIn = await mounted.handler(
			postTo("/sign-in/password", { email: "victim@example.com", password: PASSWORD }),
		);
		const pending = cookieIn(signIn, DEFAULT_COOKIE_NAMES.pending);
		expect(pending).not.toBeNull();
		const code = totpCodeForStep(secretBytesOfBase32(attacker.secret), timeStepAt(clock.now()));
		const verified = await mounted.handler(
			postTo(
				"/factor/totp/verify",
				{ code },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pending}` },
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(verified.status).not.toBe(200);
		expect(
			alarms
				.filter((alarm) => alarm.userId === victim.userId)
				.map((alarm) => `${alarm.occasion} ${alarm.reason}`),
		).toStrictEqual(["factor_check envelope_binding_mismatch"]);
	});
});
