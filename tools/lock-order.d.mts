export declare function lockOrderViolations(sql: string): string[];
export declare function scanLockOrder(): {
	offenders: string[];
	filesScanned: number;
	locksScanned: number;
};
