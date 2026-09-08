export declare function statementsIn(source: string): string[];
export declare function reassignsSessionOwner(statement: string): boolean;
export declare function scanTree(directories: readonly string[]): {
	offenders: string[];
	statementsScanned: number;
};
