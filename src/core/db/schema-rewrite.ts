const SHIPPED_SCHEMA_NAME = "velve";
const SCHEMA_NAME_MODIFIERS = new Set(["if", "not", "exists", "authorization"]);
const SCHEMA_STATEMENTS = new Set(["create", "drop", "alter"]);
const REWRITE_PROBE = "velve_probe";

export class UnrewritableMigrationError extends Error {
	readonly code = "migration_unrewritable_body";

	constructor(message: string) {
		super(message);
		this.name = "UnrewritableMigrationError";
	}
}

type RegionKind = "code" | "comment" | "string" | "quoted-identifier" | "dollar-quoted";

interface Region {
	readonly kind: RegionKind;
	readonly text: string;
}

function isWordCharacter(character: string): boolean {
	return /[A-Za-z0-9_$]/.test(character);
}

function isWordStart(character: string): boolean {
	return /[A-Za-z_]/.test(character);
}

function dollarQuoteTag(sql: string, start: number): string | null {
	const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start));
	return match === null ? null : match[0];
}

function endOfLineComment(sql: string, start: number): number {
	const newline = sql.indexOf("\n", start);
	return newline === -1 ? sql.length : newline + 1;
}

function endOfBlockComment(sql: string, start: number): number {
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
				return index;
			}
			continue;
		}
		index += 1;
	}
	return sql.length;
}

function backslashesEscape(sql: string, quote: number): boolean {
	const marker = sql[quote - 1] ?? "";
	const beforeMarker = sql[quote - 2] ?? "";
	return /[Ee]/.test(marker) && !isWordCharacter(beforeMarker);
}

function endOfQuoted(sql: string, start: number, quote: string): number {
	const escapes = quote === "'" && backslashesEscape(sql, start);
	let index = start + 1;
	while (index < sql.length) {
		if (escapes && sql[index] === "\\") {
			index += 2;
			continue;
		}
		if (sql[index] === quote) {
			if (sql[index + 1] === quote) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index += 1;
	}
	return sql.length;
}

function endOfDollarQuoted(sql: string, start: number, tag: string): number {
	const closing = sql.indexOf(tag, start + tag.length);
	return closing === -1 ? sql.length : closing + tag.length;
}

function boundaryAt(sql: string, index: number): { kind: RegionKind; end: number } | null {
	if (sql.startsWith("--", index)) {
		return { kind: "comment", end: endOfLineComment(sql, index) };
	}
	if (sql.startsWith("/*", index)) {
		return { kind: "comment", end: endOfBlockComment(sql, index) };
	}
	const character = sql[index] as string;
	if (character === "'") {
		return { kind: "string", end: endOfQuoted(sql, index, character) };
	}
	if (character === '"') {
		return { kind: "quoted-identifier", end: endOfQuoted(sql, index, character) };
	}
	const tag = character === "$" ? dollarQuoteTag(sql, index) : null;
	return tag === null ? null : { kind: "dollar-quoted", end: endOfDollarQuoted(sql, index, tag) };
}

function splitIntoRegions(sql: string): Region[] {
	const regions: Region[] = [];
	let index = 0;
	let codeStart = 0;

	while (index < sql.length) {
		const boundary = boundaryAt(sql, index);
		if (boundary === null) {
			index += 1;
			continue;
		}
		if (index > codeStart) {
			regions.push({ kind: "code", text: sql.slice(codeStart, index) });
		}
		regions.push({ kind: boundary.kind, text: sql.slice(index, boundary.end) });
		index = boundary.end;
		codeStart = index;
	}

	if (codeStart < sql.length) {
		regions.push({ kind: "code", text: sql.slice(codeStart) });
	}
	return regions;
}

function readWord(code: string, start: number): string {
	let end = start;
	while (end < code.length && isWordCharacter(code[end] as string)) {
		end += 1;
	}
	return code.slice(start, end);
}

function nextSignificantCharacter(code: string, start: number): string {
	let index = start;
	while (index < code.length && /\s/.test(code[index] as string)) {
		index += 1;
	}
	return code[index] ?? "";
}

class SchemaDeclarationTracker {
	private previousWord = "";
	private awaitingName = false;

	declaresTheSchema(word: string): boolean {
		const lowercased = word.toLowerCase();
		const declares = this.awaitingName && !SCHEMA_NAME_MODIFIERS.has(lowercased);
		if (declares) {
			this.awaitingName = false;
		} else if (lowercased === "schema" && SCHEMA_STATEMENTS.has(this.previousWord)) {
			this.awaitingName = true;
		}
		this.previousWord = lowercased;
		return declares;
	}
}

function rewriteCode(code: string, schema: string, tracker: SchemaDeclarationTracker): string {
	let rewritten = "";
	let index = 0;

	while (index < code.length) {
		const character = code[index] as string;
		if (!isWordStart(character)) {
			rewritten += character;
			index += 1;
			continue;
		}

		const word = readWord(code, index);
		const isShippedName = word.toLowerCase() === SHIPPED_SCHEMA_NAME;
		const declaresTheSchema = tracker.declaresTheSchema(word);
		const qualifiesSomething = nextSignificantCharacter(code, index + word.length) === ".";

		rewritten += isShippedName && (qualifiesSomething || declaresTheSchema) ? schema : word;
		index += word.length;
	}

	return rewritten;
}

export function applySchemaName(sql: string, schema: string): string {
	if (schema === SHIPPED_SCHEMA_NAME) {
		return sql;
	}
	const tracker = new SchemaDeclarationTracker();
	return splitIntoRegions(sql)
		.map((region) =>
			region.kind === "code" ? rewriteCode(region.text, schema, tracker) : region.text,
		)
		.join("");
}

function namesTheShippedSchema(sql: string): boolean {
	const tracker = new SchemaDeclarationTracker();
	return splitIntoRegions(sql).some(
		(region) =>
			region.kind === "code" && rewriteCode(region.text, REWRITE_PROBE, tracker) !== region.text,
	);
}

function dollarQuotedBody(region: Region): string {
	const tag = dollarQuoteTag(region.text, 0) ?? "";
	return region.text.slice(tag.length, region.text.length - tag.length);
}

export function assertNoSchemaNameInsideDollarQuoting(sql: string, schema: string): void {
	if (schema === SHIPPED_SCHEMA_NAME) {
		return;
	}
	for (const region of splitIntoRegions(sql)) {
		if (region.kind === "dollar-quoted" && namesTheShippedSchema(dollarQuotedBody(region))) {
			throw new UnrewritableMigrationError(
				`the migration names the schema "${SHIPPED_SCHEMA_NAME}" inside a dollar-quoted body, which is not rewritten to "${schema}"; qualify it at run time or ship the migration only for the default schema name`,
			);
		}
	}
}
