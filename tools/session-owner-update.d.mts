export declare function statementsIn(source: string, lineCommentOpener?: string): string[];
export declare function reassignsSessionOwner(statement: string): boolean;
export declare function scanBuiltPackage(): {
	offenders: string[];
	statementsScanned: number;
	built: boolean;
};
export declare function scanTree(): {
	offenders: string[];
	statementsScanned: number;
};
export declare function reportOn(
	source: { offenders: string[]; statementsScanned: number },
	built: { offenders: string[]; statementsScanned: number; built: boolean },
): {
	refusals: string[];
	findings: string[];
	summary: string;
	exitCode: number;
};
