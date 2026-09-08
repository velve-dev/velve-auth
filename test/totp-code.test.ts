import { describe, expect, it } from "vitest";
import {
	acceptedTimeSteps,
	createTotpSecret,
	matchingTimeStep,
	normaliseTotpCode,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	TOTP_TOLERANCE_STEPS,
	TOTP_USED_STEP_RETENTION_SECONDS,
	timeStepAt,
	totpCodeForStep,
	totpSecretBase32,
} from "../src/core/factor/totp/index.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

const AT = new Date("2026-03-04T10:00:00.000Z");
const secret = createTotpSecret();
const currentStep = timeStepAt(AT);

describe("the time step follows the period and nothing else", () => {
	it("advances once per period and not within it", () => {
		expect(timeStepAt(new Date(currentStep * TOTP_PERIOD_SECONDS * 1000))).toBe(currentStep);
		expect(
			timeStepAt(new Date((currentStep * TOTP_PERIOD_SECONDS + TOTP_PERIOD_SECONDS - 1) * 1000)),
		).toBe(currentStep);
		expect(
			timeStepAt(new Date((currentStep * TOTP_PERIOD_SECONDS + TOTP_PERIOD_SECONDS) * 1000)),
		).toBe(currentStep + 1);
	});

	it("accepts one step either side and no more (3.6)", () => {
		expect(TOTP_TOLERANCE_STEPS).toBe(1);
		expect(acceptedTimeSteps(AT)).toEqual([currentStep - 1, currentStep, currentStep + 1]);
	});

	it("keeps a used step longer than any code that could reach it (L-11)", () => {
		const widestWindow = TOTP_PERIOD_SECONDS * (1 + 2 * TOTP_TOLERANCE_STEPS);
		expect(TOTP_USED_STEP_RETENTION_SECONDS).toBe(widestWindow + 120);
	});
});

describe("matching answers with the step, not with a boolean", () => {
	it.each([-1, 0, 1])("returns the matched step for an offset of %i", (offset) => {
		expect(
			matchingTimeStep({
				secretBytes: secret,
				submittedCode: totpCodeForStep(secret, currentStep + offset),
				at: AT,
			}),
		).toBe(currentStep + offset);
	});

	it.each([-2, 2])("refuses an offset of %i", (offset) => {
		expect(
			matchingTimeStep({
				secretBytes: secret,
				submittedCode: totpCodeForStep(secret, currentStep + offset),
				at: AT,
			}),
		).toBeNull();
	});

	it("refuses a code from another secret", () => {
		expect(
			matchingTimeStep({
				secretBytes: secret,
				submittedCode: totpCodeForStep(createTotpSecret(), currentStep),
				at: AT,
			}),
		).toBeNull();
	});

	it.each(["", "12345", "1234567", "abcdef", "  ", "000000000000"])(
		"refuses the malformed submission %j",
		(submitted) => {
			expect(
				matchingTimeStep({ secretBytes: secret, submittedCode: submitted, at: AT }),
			).toBeNull();
		},
	);

	it("reads a code the way an authenticator shows it", () => {
		const code = totpCodeForStep(secret, currentStep);
		const shown = `${code.slice(0, 3)} ${code.slice(3)}`;
		expect(normaliseTotpCode(shown)).toBe(code);
		expect(matchingTimeStep({ secretBytes: secret, submittedCode: shown, at: AT })).toBe(
			currentStep,
		);
	});
});

describe("the generated code and secret keep the shape 3.6 fixes", () => {
	it("is six digits", () => {
		const code = totpCodeForStep(secret, currentStep);
		expect(code).toHaveLength(TOTP_DIGITS);
		expect(code).toMatch(/^[0-9]{6}$/);
	});

	it("round-trips the secret through base32", () => {
		expect(Array.from(secretBytesOfBase32(totpSecretBase32(secret)))).toEqual(Array.from(secret));
	});

	it("draws a different secret every time (S-RAND-1)", () => {
		const drawn = new Set(Array.from({ length: 64 }, () => totpSecretBase32(createTotpSecret())));
		expect(drawn.size).toBe(64);
	});
});
