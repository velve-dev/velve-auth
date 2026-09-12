export function egressIn(path: string, source: string): string[];
export function scanEgress(): {
	offenders: string[];
	filesScanned: number;
	callsScanned: number;
};
