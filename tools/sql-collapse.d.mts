export declare const SOURCE_ROOT: string;
export declare function withoutSqlComments(sql: string): string;
export declare function onOneLine(sql: string): string;
export declare function survivesCollapsing(sql: string): boolean;
export declare function statementsOf(sql: string): string[];
export declare function literalsIn(source: string): string[];
export declare function examinedStatementsIn(source: string): string[];
export declare function scanSqlCollapse(): {
	offenders: string[];
	statementsScanned: number;
	filesScanned: number;
};
