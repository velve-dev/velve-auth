// Architecture 3.6: RFC 6238, SHA-1, six digits, thirty seconds, a tolerance of one step.
export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/** A.8: `stepToleranceInSteps: 0 | 1`, and a value outside the two is not a narrower window. */
export type TotpToleranceInSteps = 0 | 1;

/** A.8's `// Vorgabe 1`, which is also 3.6's `Toleranz ±1 Schritt`. */
export const TOTP_TOLERANCE_STEPS: TotpToleranceInSteps = 1;

/** RFC 4226 section 4 requires at least 128 bit and recommends 160, which is also SHA-1's block-independent output width. */
export const TOTP_SECRET_BYTES = 20;

/** L-11: a used step is swept two minutes after its window, so the row outlives every code it refuses. */
export function usedStepRetentionSeconds(toleranceInSteps: TotpToleranceInSteps): number {
	return TOTP_PERIOD_SECONDS * (1 + 2 * toleranceInSteps) + 120;
}

export function timeStepAt(instant: Date): number {
	return Math.floor(instant.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export function acceptedTimeSteps(
	instant: Date,
	toleranceInSteps: TotpToleranceInSteps,
): readonly number[] {
	const current = timeStepAt(instant);
	const steps: number[] = [];
	for (let offset = -toleranceInSteps; offset <= toleranceInSteps; offset += 1) {
		steps.push(current + offset);
	}
	return steps;
}

/** A.8 declares two values and nothing narrows the window by accident, so anything else is the default. */
export function totpToleranceOf(configured: number | undefined): TotpToleranceInSteps {
	return configured === 0 ? 0 : TOTP_TOLERANCE_STEPS;
}
