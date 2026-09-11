import { afterAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

const PASSWORD = "correct-horse-battery-staple";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

const mountings: MountedAuth[] = [];

afterAll(async () => {
	for (const mounted of mountings) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

interface Installation {
	readonly mounted: MountedAuth;
	readonly clock: TestClock;
}

async function installationWith(
	prefix: string,
	totp: { readonly issuer: string; readonly stepToleranceInSteps?: 0 | 1 },
): Promise<Installation> {
	const clock = createTestClock();
	const mounted = await mountAuth(prefix, {
		clock,
		totp,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
	mountings.push(mounted);
	return { mounted, clock };
}

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

interface EnrolledAccount {
	readonly email: string;
	readonly secretBase32: string;
}

let accounts = 0;

async function enrolAnAccount(installation: Installation): Promise<EnrolledAccount> {
	accounts += 1;
	const email = `tolerance${accounts}@example.com`;
	const signedUp = await installation.mounted.handler(
		postTo("/sign-up", { email, password: PASSWORD }),
	);
	const headers = {
		Cookie: `${DEFAULT_COOKIE_NAMES.session}=${cookieIn(signedUp, DEFAULT_COOKIE_NAMES.session)}`,
	};
	const started = await installation.mounted.handler(
		postTo("/factor/totp/enroll/start", {}, headers),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await installation.mounted.handler(
		postTo(
			"/factor/totp/enroll/finish",
			{
				code: totpCodeForStep(
					secretBytesOfBase32(secretBase32),
					timeStepAt(installation.clock.now()),
				),
			},
			headers,
		),
	);

	expect([signedUp.status, started.status, finished.status]).toStrictEqual([200, 200, 204]);
	// S-REPLAY-4: `enroll.finish` claimed the current step, so a sign-in has to leave that window.
	installation.clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return { email, secretBase32 };
}

async function verifyWithTheCodeOfStep(
	installation: Installation,
	account: EnrolledAccount,
	offsetInSteps: number,
): Promise<string> {
	const signedIn = await installation.mounted.handler(
		postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
	);
	const pendingToken = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
	const verified = await installation.mounted.handler(
		postTo(
			"/factor/totp/verify",
			{
				code: totpCodeForStep(
					secretBytesOfBase32(account.secretBase32),
					timeStepAt(installation.clock.now()) + offsetInSteps,
				),
			},
			{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingToken}` },
		),
	);
	const body = (await verified.json()) as { status?: string; error?: { code: string } };
	return `${verified.status} ${body.status ?? body.error?.code}`;
}

/**
 * A.8 declares `totp.stepToleranceInSteps: 0 | 1` with the default 1, and 3.6 fixes that default
 * as `Toleranz ±1 Schritt`. An operator who asks for the narrower window has to get it (E-1693).
 */
describe("A.8: the configured TOTP step tolerance reaches the comparison", () => {
	it("accepts the neighbouring step at the default and refuses it at zero", async () => {
		const atTheDefault = await installationWith("totptoldefault", { issuer: "Velve" });
		const atZero = await installationWith("totptolzero", {
			issuer: "Velve",
			stepToleranceInSteps: 0,
		});

		const lenient = await enrolAnAccount(atTheDefault);
		const strict = await enrolAnAccount(atZero);

		expect(await verifyWithTheCodeOfStep(atTheDefault, lenient, -1)).toBe("200 signed_in");
		expect(await verifyWithTheCodeOfStep(atZero, strict, -1)).toBe("401 invalid_factor_code");
	});

	it("accepts the current step at zero, so the narrower window is narrower and not shut", async () => {
		const atZero = await installationWith("totptolzeronow", {
			issuer: "Velve",
			stepToleranceInSteps: 0,
		});
		const account = await enrolAnAccount(atZero);

		expect(await verifyWithTheCodeOfStep(atZero, account, 0)).toBe("200 signed_in");
	});

	/** A.2 makes `totp` itself optional, so the default has to hold with nothing configured. */
	it("accepts the neighbouring step where nothing configured a tolerance", async () => {
		const unconfigured = await installationWith("totptolabsent", { issuer: "Velve" });
		const account = await enrolAnAccount(unconfigured);

		expect(await verifyWithTheCodeOfStep(unconfigured, account, 1)).toBe("200 signed_in");
	});
});
