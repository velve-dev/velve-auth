export declare function withoutSqlComments(sql: string): string;
export declare function onOneLine(sql: string): string;
export declare function survivesCollapsing(sql: string): boolean;
export declare function scanSqlCollapse(): {
	offenders: string[];
	statementsScanned: number;
	filesDeferred: number;
};
