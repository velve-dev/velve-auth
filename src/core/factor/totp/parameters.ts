export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

export type TotpToleranceInSteps = 0 | 1;

export const TOTP_TOLERANCE_STEPS: TotpToleranceInSteps = 1;

//rfc 4226 requires at least 128 bit and recommends 160
export const TOTP_SECRET_BYTES = 20;

//a used step must outlive every code it refuses
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

//anything but zero or one is the default so nothing narrows the window by accident
export function totpToleranceOf(configured: number | undefined): TotpToleranceInSteps {
	return configured === 0 ? 0 : TOTP_TOLERANCE_STEPS;
}
