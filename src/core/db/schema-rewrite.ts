const SHIPPED_SCHEMA_NAME = "velve";
const SCHEMA_NAME_MODIFIERS = new Set(["if", "not", "exists", "authorization"]);
const SCHEMA_STATEMENTS = new Set(["create", "drop", "alter"]);

function isWordCharacter(character: string): boolean {
	return /[A-Za-z0-9_$]/.test(character);
}

function isWordStart(character: string): boolean {
	return /[A-Za-z_]/.test(character);
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

function endOfQuoted(sql: string, start: number, quote: string): number {
	let index = start + 1;
	while (index < sql.length) {
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

function dollarQuoteTag(sql: string, start: number): string | null {
	const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start));
	return match === null ? null : match[0];
}

function endOfDollarQuoted(sql: string, start: number, tag: string): number {
	const closing = sql.indexOf(tag, start + tag.length);
	return closing === -1 ? sql.length : closing + tag.length;
}

function readWord(sql: string, start: number): string {
	let end = start;
	while (end < sql.length && isWordCharacter(sql[end] as string)) {
		end += 1;
	}
	return sql.slice(start, end);
}

function nextSignificantCharacter(sql: string, start: number): string {
	let index = start;
	while (index < sql.length && /\s/.test(sql[index] as string)) {
		index += 1;
	}
	return sql[index] ?? "";
}

function endOfSkippableRegion(sql: string, index: number): number {
	if (sql.startsWith("--", index)) {
		return endOfLineComment(sql, index);
	}
	if (sql.startsWith("/*", index)) {
		return endOfBlockComment(sql, index);
	}
	const character = sql[index] as string;
	if (character === "'" || character === '"') {
		return endOfQuoted(sql, index, character);
	}
	const tag = character === "$" ? dollarQuoteTag(sql, index) : null;
	return tag === null ? -1 : endOfDollarQuoted(sql, index, tag);
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

export function applySchemaName(sql: string, schema: string): string {
	if (schema === SHIPPED_SCHEMA_NAME) {
		return sql;
	}

	const tracker = new SchemaDeclarationTracker();
	let rewritten = "";
	let index = 0;

	while (index < sql.length) {
		const skipped = endOfSkippableRegion(sql, index);
		if (skipped !== -1) {
			rewritten += sql.slice(index, skipped);
			index = skipped;
			continue;
		}

		const character = sql[index] as string;
		if (!isWordStart(character)) {
			rewritten += character;
			index += 1;
			continue;
		}

		const word = readWord(sql, index);
		const isShippedName = word.toLowerCase() === SHIPPED_SCHEMA_NAME;
		const declaresTheSchema = tracker.declaresTheSchema(word);
		const qualifiesSomething = nextSignificantCharacter(sql, index + word.length) === ".";

		rewritten += isShippedName && (qualifiesSomething || declaresTheSchema) ? schema : word;
		index += word.length;
	}

	return rewritten;
}
