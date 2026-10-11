export const SIGN_UP_MINT_ALLOWANCE: { path: string; call: RegExp };
export function tokenReachedAfterAccountLock(
	source: string,
	allowedCalls?: readonly RegExp[],
): string[];
export function scanTokenAfterLock(allowance?: { path: string; call: RegExp } | null): {
	offenders: string[];
	filesScanned: number;
	locksScanned: number;
};
