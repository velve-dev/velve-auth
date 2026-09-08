import { Secret, TOTP } from "otpauth";
import { equalsInConstantTime } from "../../keys/constant-time.js";
import {
	acceptedTimeSteps,
	TOTP_ALGORITHM,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
} from "./parameters.js";

const utf8 = new TextEncoder();

/** An authenticator app shows the code in two groups, and a reader retypes the space with it. */
const SEPARATORS = /[\s -]/g;

export function normaliseTotpCode(submitted: string): string {
	return submitted.replace(SEPARATORS, "");
}

function secretOf(secretBytes: Uint8Array<ArrayBuffer>): Secret {
	return new Secret({ buffer: secretBytes.buffer });
}

export function totpCodeForStep(secretBytes: Uint8Array<ArrayBuffer>, timeStep: number): string {
	return TOTP.generate({
		secret: secretOf(secretBytes),
		algorithm: TOTP_ALGORITHM,
		digits: TOTP_DIGITS,
		period: TOTP_PERIOD_SECONDS,
		timestamp: timeStep * TOTP_PERIOD_SECONDS * 1000,
	});
}

/**
 * S-REPLAY-4: the answer is the step that matched, not the step the clock is in, because that
 * step is what the replay guard has to record. Every candidate is compared, so the position of
 * the match inside the tolerance window is not readable from the duration.
 */
export function matchingTimeStep(input: {
	readonly secretBytes: Uint8Array<ArrayBuffer>;
	readonly submittedCode: string;
	readonly at: Date;
}): number | null {
	const submitted = utf8.encode(normaliseTotpCode(input.submittedCode));
	let matched: number | null = null;

	for (const step of acceptedTimeSteps(input.at)) {
		const expected = utf8.encode(totpCodeForStep(input.secretBytes, step));
		if (equalsInConstantTime(expected, submitted) && matched === null) {
			matched = step;
		}
	}

	return matched;
}
