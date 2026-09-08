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
