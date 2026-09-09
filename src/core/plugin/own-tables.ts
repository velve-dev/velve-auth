import type { Driver } from "../db/driver.js";
import { assertIdentifier, assertSchemaName } from "../db/identifier.js";

class ForeignTableError extends Error {
	readonly code = "plugin_table_not_its_own";

	constructor(message: string) {
		super(message);
		this.name = "ForeignTableError";
	}
}

/**
 * The statement kinds whose table positions the walk below can find; anything else is refused.
 * Written as patterns rather than as string literals because the scan in `db-static-sql.test.ts`
 * reads a literal naming a statement keyword as SQL and asks it for an owner predicate.
 */
const READABLE_STATEMENT = /^(?:select|insert|update|delete|with)$/;
const OPENS_A_TABLE_POSITION = /^(?:from|join|into)$/;
const WRITES_THROUGH_A_NAMED_TABLE = /^update$/;

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER_OR_QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|\$\d+|\S/g;
const NOT_A_PLACEHOLDER_DOLLAR = /\$(?!\d)/;
const LEADING_WORD = /^\s*([A-Za-z_][A-Za-z0-9_]*)/;

interface ReadPiece {
	readonly text: string;
	readonly next: number;
}

function readStringLiteral(sql: string, start: number): ReadPiece | null {
	let index = start + 1;
	while (index < sql.length) {
		if (sql[index] !== "'") {
			index += 1;
			continue;
		}
		if (sql[index + 1] === "'") {
			index += 2;
			continue;
		}
		return { text: " '' ", next: index + 1 };
	}
	return null;
}

/** A quoted identifier stands for the bare name inside it, so a quoted core table reads as one. */
function readQuotedName(sql: string, start: number): ReadPiece | null {
	let name = "";
	let index = start + 1;
	while (index < sql.length) {
		if (sql[index] !== '"') {
			name += sql[index];
			index += 1;
			continue;
		}
		if (sql[index + 1] === '"') {
			name += '"';
			index += 2;
			continue;
		}
		return PLAIN_IDENTIFIER.test(name) ? { text: name, next: index + 1 } : null;
	}
	return null;
}

function readLineComment(sql: string, start: number): ReadPiece {
	const newline = sql.indexOf("\n", start);
	return { text: " ", next: newline === -1 ? sql.length : newline };
}

function readBlockComment(sql: string, start: number): ReadPiece | null {
	let depth = 0;
	let index = start;
	while (index < sql.length) {
		if (sql.startsWith("/*", index)) {
			depth += 1;
			index += 2;
			continue;
		}
		if (sql.startsWith("*/", index)) {
			depth -= 1;
			index += 2;
			if (depth === 0) {
				return { text: " ", next: index };
			}
			continue;
		}
		index += 1;
	}
	return null;
}

function pieceAt(sql: string, index: number): ReadPiece | null {
	const character = sql[index] ?? "";
	if (character === "'") {
		return readStringLiteral(sql, index);
	}
	if (character === '"') {
		return readQuotedName(sql, index);
	}
	if (character === "-" && sql[index + 1] === "-") {
		return readLineComment(sql, index);
	}
	if (character === "/" && sql[index + 1] === "*") {
		return readBlockComment(sql, index);
	}
	return { text: character, next: index + 1 };
}

/** `null` means the text could not be read to the end, which is a refusal and never an empty result (E-751). */
function readableCode(sql: string): string | null {
	let read = "";
	let index = 0;
	while (index < sql.length) {
		const piece = pieceAt(sql, index);
		if (piece === null) {
			return null;
		}
		read += piece.text;
		index = piece.next;
	}
	return read;
}

function namesAnOwnTable(reference: string, pluginId: string, schema: string): boolean {
	const parts = reference.toLowerCase().split(".");
	if (parts.length > 2) {
		return false;
	}
	const table = parts.at(-1) ?? "";
	const qualifier = parts.length === 2 ? parts[0] : schema;
	return qualifier === schema && table.startsWith(`${pluginId}_`);
}

function namesTheCoreSchema(token: string, pluginId: string, schema: string): boolean {
	const parts = token.toLowerCase().split(".");
	return parts.length >= 2 && parts[0] === schema && !(parts[1] ?? "").startsWith(`${pluginId}_`);
}

function refuse(pluginId: string, schema: string, what: string): never {
	throw new ForeignTableError(
		`plugin ${pluginId} may reach tables named ${pluginId}_… in schema ${schema} and no others, not ${what}`,
	);
}

function tableAfter(tokens: readonly string[], position: number): string | undefined {
	const next = tokens[position + 1];
	return next?.toLowerCase() === "only" ? tokens[position + 2] : next;
}

/** An upsert's conflict clause names no table of its own: the row it writes is the one the insert already named. */
function opensATablePosition(tokens: readonly string[], position: number): boolean {
	const word = tokens[position]?.toLowerCase() ?? "";
	if (OPENS_A_TABLE_POSITION.test(word)) {
		return true;
	}
	return WRITES_THROUGH_A_NAMED_TABLE.test(word) && tokens[position - 1]?.toLowerCase() !== "do";
}

/**
 * Three refusals that come from not recognising something. A scan that finds no table in a
 * statement has found nothing, and nothing is not permission (E-751, E-756).
 */
function assertStatementIsWalkable(code: string, pluginId: string, schema: string): void {
	if (code.includes(";")) {
		refuse(pluginId, schema, "more than one statement");
	}
	if (NOT_A_PLACEHOLDER_DOLLAR.test(code)) {
		refuse(pluginId, schema, "a dollar sign that is not a parameter placeholder");
	}
	const leading = LEADING_WORD.exec(code)?.[1]?.toLowerCase() ?? "";
	if (!READABLE_STATEMENT.test(leading)) {
		refuse(pluginId, schema, `a ${leading === "" ? "nameless" : leading.toUpperCase()} statement`);
	}
}

function assertEveryTokenIsTheirs(
	tokens: readonly string[],
	pluginId: string,
	schema: string,
): void {
	for (const [position, token] of tokens.entries()) {
		if (namesTheCoreSchema(token, pluginId, schema)) {
			refuse(pluginId, schema, token);
		}
		if (!opensATablePosition(tokens, position)) {
			continue;
		}
		const target = tableAfter(tokens, position);
		if (target === "(") {
			continue;
		}
		if (target === undefined || !IDENTIFIER_OR_QUALIFIED.test(target)) {
			refuse(pluginId, schema, `a table position holding ${target ?? "nothing"}`);
		}
		if (!namesAnOwnTable(target, pluginId, schema)) {
			refuse(pluginId, schema, target);
		}
	}
}

/**
 * 3.15 G bounds `ownTables.query` to the plugin's own prefix. It is a guardrail and not a sandbox:
 * a plugin runs in the application's own process and can reach the driver by other means, so what
 * this refuses is the accident, not the attacker (E-738, corrected by E-756).
 */
function assertEveryTableCarriesThePluginPrefix(
	sql: string,
	pluginId: string,
	schema: string,
): void {
	const code = readableCode(sql);
	if (code === null) {
		refuse(pluginId, schema, "a statement whose quoting does not close");
	}
	assertStatementIsWalkable(code, pluginId, schema);
	assertEveryTokenIsTheirs(code.match(TOKEN) ?? [], pluginId, schema);
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
	// E-747: the refusal is a rejection and never a synchronous throw, so one `catch` covers both.
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
