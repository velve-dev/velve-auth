export function tokenReachedAfterAccountLock(source: string): string[];
export function scanTokenAfterLock(): {
	offenders: string[];
	filesScanned: number;
	locksScanned: number;
};
