import type { Driver } from "../src/core/db/driver.js";

/** node-postgres, postgres.js and the neon driver hand a jsonb column back decoded; the test connection hands it back as text, and this wrapper stands in for them. */
export function decodingJsonb(inner: Driver, column = "payload"): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) =>
			(await inner.query<Record<string, unknown>>(sql, params)).map((row) => {
				const value = row[column];
				return typeof value === "string" ? { ...row, [column]: JSON.parse(value) } : row;
			}) as T[],
		transaction: (work) => inner.transaction((tx) => work(decodingJsonb(tx, column))),
	};
}
