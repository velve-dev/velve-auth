// Architecture 3.6: RFC 6238, SHA-1, six digits, thirty seconds, a tolerance of one step.
export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_TOLERANCE_STEPS = 1;

/** RFC 4226 section 4 requires at least 128 bit and recommends 160, which is also SHA-1's block-independent output width. */
export const TOTP_SECRET_BYTES = 20;

/** L-11: a used step is swept two minutes after its window, so the row outlives every code it refuses. */
export const TOTP_USED_STEP_RETENTION_SECONDS =
	TOTP_PERIOD_SECONDS * (1 + 2 * TOTP_TOLERANCE_STEPS) + 120;

export function timeStepAt(instant: Date): number {
	return Math.floor(instant.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export function acceptedTimeSteps(instant: Date): readonly number[] {
	const current = timeStepAt(instant);
	const steps: number[] = [];
	for (let offset = -TOTP_TOLERANCE_STEPS; offset <= TOTP_TOLERANCE_STEPS; offset += 1) {
		steps.push(current + offset);
	}
	return steps;
}
