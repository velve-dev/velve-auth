export interface Driver {
	query<T>(sql: string, params: unknown[]): Promise<T[]>;
	transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
}
