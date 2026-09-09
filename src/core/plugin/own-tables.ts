import type { Driver } from "../db/driver.js";
import { assertIdentifier, assertSchemaName } from "../db/identifier.js";

class ForeignTableError extends Error {
	readonly code = "plugin_table_not_its_own";

	constructor(message: string) {
		super(message);
		this.name = "ForeignTableError";
	}
}

const COMMENT_OR_QUOTED =
	/\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$\$[\s\S]*?\$\$/g;

/**
 * The identifier standing where a table stands. `FROM (SELECT …)` matches nothing and is therefore
 * not a reference, which is right: the tables inside the subquery are found by their own `FROM`.
 */
const TABLE_POSITION =
	/\b(?:from|join|into|update)\s+(?:only\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;

function withoutCommentsAndQuoted(sql: string): string {
	return sql.replace(COMMENT_OR_QUOTED, " ");
}

function tableReferencesIn(sql: string): readonly string[] {
	return [...withoutCommentsAndQuoted(sql).matchAll(TABLE_POSITION)].map((match) =>
		String(match[1]),
	);
}

function namesAnOwnTable(reference: string, pluginId: string, schema: string): boolean {
	const parts = reference.split(".");
	const table = parts.at(-1) ?? "";
	const qualifier = parts.length === 2 ? parts[0] : schema;
	return qualifier === schema && table.startsWith(`${pluginId}_`);
}

/**
 * 3.15 G bounds `ownTables.query` to the plugin's own prefix. It is a guardrail and not a sandbox:
 * a plugin runs in the application's own process and can reach the driver by other means, so what
 * this refuses is the accident, not the attacker.
 */
function assertEveryTableCarriesThePluginPrefix(
	sql: string,
	pluginId: string,
	schema: string,
): void {
	for (const reference of tableReferencesIn(sql)) {
		if (!namesAnOwnTable(reference, pluginId, schema)) {
			throw new ForeignTableError(
				`plugin ${pluginId} may reach tables named ${pluginId}_… in schema ${schema} and no others, not ${reference}`,
			);
		}
	}
}

export interface OwnTables {
	query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]>;
}

export function createOwnTables(options: {
	readonly driver: Driver;
	readonly schema: string;
	readonly pluginId: string;
}): OwnTables {
	const schema = assertSchemaName(options.schema);
	const pluginId = assertIdentifier(options.pluginId);
	// The refusal is a rejection and never a synchronous throw, so one `catch` covers both outcomes.
	return Object.freeze({
		query: async <Row>(sql: string, params: readonly unknown[]): Promise<Row[]> => {
			assertEveryTableCarriesThePluginPrefix(sql, pluginId, schema);
			return options.driver.query<Row>(sql, [...params]);
		},
	});
}

/** 3.15 D.1 gives a core route the field and no tables of its own behind it. */
export function createNoOwnTables(): OwnTables {
	return Object.freeze({
		query: <Row>(): Promise<Row[]> =>
			Promise.reject(new ForeignTableError("a core route owns no tables of its own")),
	});
}
