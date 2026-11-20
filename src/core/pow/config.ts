/** the five request routes that ask for a proof on every call while the proof of work is configured */
export const ALWAYS_GUARDED_ROUTES = [
	"signUp.withPassword",
	"signUp.withoutPassword",
	"password.requestReset",
	"signIn.magicLink.request",
	"passkeyRecovery.request",
] as const;

/** the two sign-in routes that ask for a proof once their failure counters reach the threshold */
export const SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES = [
	"signIn.password",
	"signIn.passkey.finish",
] as const;

/** a route the proof of work can guard, which is the name a challenge is bound to */
export type ProofOfWorkRoute =
	| (typeof ALWAYS_GUARDED_ROUTES)[number]
	| (typeof SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES)[number];

/** a sign-in route that asks for a proof only after repeated failures */
export type SignInRouteGuardedAfterFailures =
	(typeof SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES)[number];

/** what the difficulty of one challenge is asked with */
export interface ProofOfWorkContext {
	readonly route: ProofOfWorkRoute;
}

/** what the failure threshold of one sign-in is asked with */
export interface SignInFailureContext {
	readonly route: SignInRouteGuardedAfterFailures;
}

/** turns the proof of work on, which is off while this is absent */
export interface ProofOfWorkConfig {
	/** leading zero bits a challenge for the route asks for, read on each request and clamped to 0 to 24 */
	readonly difficulty: (context: ProofOfWorkContext) => number;
	/** failed sign-ins on one account or address after which a sign-in asks for a proof, read on each request and clamped to 1 to 100 */
	readonly signInFailuresBeforeProof: (context: SignInFailureContext) => number;
}

/** the fewest leading zero bits a challenge asks for */
export const LOWEST_PROOF_OF_WORK_DIFFICULTY = 0;

/** the most leading zero bits a challenge asks for */
export const HIGHEST_PROOF_OF_WORK_DIFFICULTY = 24;

/** the fewest failed sign-ins after which a sign-in asks for a proof */
export const FEWEST_SIGN_IN_FAILURES_BEFORE_PROOF = 1;

/** the most failed sign-ins after which a sign-in asks for a proof */
export const MOST_SIGN_IN_FAILURES_BEFORE_PROOF = 100;

function withinBounds(value: number, lowest: number, highest: number): number {
	return Math.min(Math.max(value, lowest), highest);
}

//an answer that is no number asks for the hardest challenge the bounds allow (E-3662)
export function difficultyWithinBounds(answer: unknown): number {
	if (typeof answer !== "number" || Number.isNaN(answer)) {
		return HIGHEST_PROOF_OF_WORK_DIFFICULTY;
	}
	return withinBounds(
		Math.ceil(answer),
		LOWEST_PROOF_OF_WORK_DIFFICULTY,
		HIGHEST_PROOF_OF_WORK_DIFFICULTY,
	);
}

//an answer that is no number asks for a proof after the first failure (E-3662)
export function failureThresholdWithinBounds(answer: unknown): number {
	if (typeof answer !== "number" || Number.isNaN(answer)) {
		return FEWEST_SIGN_IN_FAILURES_BEFORE_PROOF;
	}
	return withinBounds(
		Math.floor(answer),
		FEWEST_SIGN_IN_FAILURES_BEFORE_PROOF,
		MOST_SIGN_IN_FAILURES_BEFORE_PROOF,
	);
}

/** whether a configuration value can turn the proof of work on, checked at the start */
export function isUsableProofOfWorkConfig(configured: unknown): boolean {
	if (typeof configured !== "object" || configured === null) {
		return false;
	}
	const { difficulty, signInFailuresBeforeProof } = configured as Partial<
		Record<keyof ProofOfWorkConfig, unknown>
	>;
	return typeof difficulty === "function" && typeof signInFailuresBeforeProof === "function";
}
