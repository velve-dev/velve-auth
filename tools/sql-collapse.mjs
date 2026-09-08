import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

export const SOURCE_ROOT = "src";

const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP)\b/i;

/** The hazard is the line comment, not the keyword. A fragment with no keyword is still
 * interpolated into a statement somewhere, so carrying one is reason enough to examine it. */
const CARRIES_A_LINE_COMMENT = /(^|[\s(,;])--/;

function endOfLineComment(sql, start) {
	const newline = sql.indexOf("\n", start);
	return newline === -1 ? sql.length : newline + 1;
}

// PostgreSQL nests block comments, so the first closing marker is not necessarily the end.
function endOfBlockComment(sql, start) {
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
			if (depth === 0) return index;
			continue;
		}
		index += 1;
	}
	return sql.length;
}

function isWordCharacter(character) {
	return /[A-Za-z0-9_$]/.test(character);
}

/** Only `E'…'` reads a backslash as an escape; a plain `'…'` does not. */
function backslashesEscape(sql, quote) {
	const marker = sql[quote - 1] ?? "";
	const beforeMarker = sql[quote - 2] ?? "";
	return /[Ee]/.test(marker) && !isWordCharacter(beforeMarker);
}

function endOfQuoted(sql, start, quote) {
	const escapes = quote === "'" && backslashesEscape(sql, start);
	let index = start + 1;
	while (index < sql.length) {
		if (escapes && sql[index] === "\\") {
			index += 2;
			continue;
		}
		if (sql[index] !== quote) {
			index += 1;
			continue;
		}
		if (sql[index + 1] === quote) {
			index += 2;
			continue;
		}
		return index + 1;
	}
	return sql.length;
}

/** An unterminated tag ends at the end of the text. Computing it from `indexOf` returning -1
 * gives a position behind the opener, and a walker that jumps backwards never terminates. */
function endOfDollarQuoted(sql, start, tag) {
	const closing = sql.indexOf(tag, start + tag.length);
	return closing === -1 ? sql.length : closing + tag.length;
}

function dollarQuoteTag(sql, start) {
	return /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(start))?.[0] ?? null;
}

/** The same regions PostgreSQL reads, and read the way the migration runner reads them: inside
 * any of them a `;` ends nothing and a `--` opens nothing. Every branch mirrors `boundaryAt`
 * in src/core/db/schema-rewrite.ts — nested block comments, `E'…'` backslash escapes and an
 * unterminated dollar quote included, because a claim of mirroring is only worth its exceptions. */
function regionAt(sql, index) {
	if (sql.startsWith("--", index)) {
		return { comment: true, end: endOfLineComment(sql, index) };
	}
	if (sql.startsWith("/*", index)) {
		return { comment: true, end: endOfBlockComment(sql, index) };
	}
	const character = sql[index];
	if (character === "'" || character === '"') {
		return { comment: false, end: endOfQuoted(sql, index, character) };
	}
	const tag = character === "$" ? dollarQuoteTag(sql, index) : null;
	return tag === null ? null : { comment: false, end: endOfDollarQuoted(sql, index, tag) };
}

export function withoutSqlComments(sql) {
	let stripped = "";
	let index = 0;
	while (index < sql.length) {
		const region = regionAt(sql, index);
		if (region === null) {
			stripped += sql[index];
			index += 1;
			continue;
		}
		stripped += region.comment ? " " : sql.slice(index, region.end);
		index = region.end;
	}
	return stripped;
}

/** What a logger, a formatter or a fronting proxy leaves of a statement. */
export function onOneLine(sql) {
	return sql.replace(/\s+/g, " ").trim();
}

/** E-266: a comment that runs to the end of its line takes everything after it the moment the
 * newlines are gone, so removing the comments has to give the same statement either way round.
 * A block comment ends in the text and survives; a line comment ends in a newline and does not. */
export function survivesCollapsing(sql) {
	return onOneLine(withoutSqlComments(onOneLine(sql))) === onOneLine(withoutSqlComments(sql));
}

/** The unit a driver is handed: the migration runner cuts a script here and sends the pieces,
 * and it keeps their comments (`src/core/db/schema-rewrite.ts`), so a piece is as exposed as a
 * repository's own literal. */
export function statementsOf(sql) {
	const statements = [];
	let current = "";
	let index = 0;
	while (index < sql.length) {
		const region = regionAt(sql, index);
		if (region !== null) {
			current += sql.slice(index, region.end);
			index = region.end;
			continue;
		}
		if (sql[index] === ";") {
			statements.push(current);
			current = "";
		} else {
			current += sql[index];
		}
		index += 1;
	}
	statements.push(current);
	return statements.filter((statement) => statement.trim() !== "");
}

function endOfInterpolation(source, start) {
	let depth = 1;
	let index = start + 2;
	while (index < source.length && depth > 0) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") depth -= 1;
		index += 1;
	}
	return index;
}

function endOfTemplateLiteral(source, start) {
	let index = start + 1;
	while (index < source.length && source[index] !== "`") {
		if (source[index] === "\\") index += 2;
		else if (source.startsWith("${", index)) index = endOfInterpolation(source, index);
		else index += 1;
	}
	return Math.min(index + 1, source.length);
}

function endOfSimpleString(source, start) {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length && source[index] !== quote) {
		index += source[index] === "\\" ? 2 : 1;
	}
	return index + 1;
}

// PostgreSQL nests block comments and TypeScript does not, so the two languages get two
// scanners. Sharing the depth-counting one sent this walker past the first closer and into
// whatever followed, which is how a literal stops being read without anything reporting it.
function endOfTypeScriptBlockComment(source, start) {
	const close = source.indexOf("*/", start + 2);
	return close === -1 ? source.length : close + 2;
}

/** A comment or a literal in the surrounding TypeScript; anything else is one character. */
function tokenAt(source, index) {
	if (source.startsWith("//", index)) {
		const newline = source.indexOf("\n", index);
		return { kind: "line-comment", end: newline === -1 ? source.length : newline + 1 };
	}
	if (source.startsWith("/*", index)) {
		return { kind: "block-comment", end: endOfTypeScriptBlockComment(source, index) };
	}
	const character = source[index];
	if (character === "'" || character === '"') {
		return { kind: "literal", end: endOfSimpleString(source, index) };
	}
	if (character === "`") {
		return { kind: "literal", end: endOfTemplateLiteral(source, index) };
	}
	return null;
}

/** One walk, both outputs: what was read and what was skipped over to read it. A check that
 * cannot say what it skipped cannot notice that it skipped too much. */
function scanTypeScript(source) {
	const literals = [];
	const blockComments = [];
	let index = 0;
	while (index < source.length) {
		const token = tokenAt(source, index);
		if (token === null) {
			index += 1;
			continue;
		}
		if (token.kind === "literal") literals.push(source.slice(index + 1, token.end - 1));
		if (token.kind === "block-comment") blockComments.push(source.slice(index, token.end));
		index = token.end;
	}
	return { literals, blockComments };
}

/** A TypeScript block comment ends at its first closing marker, so a scanned one never holds
 * another inside it. One that does means the walker ran past the end, and everything it stepped
 * over on the way went unread — the silent half of getting this wrong. */
export function runsPastItsEnd(blockComment) {
	return blockComment.slice(2, -2).includes("*/");
}

export function walkerFaults(source) {
	return scanTypeScript(source)
		.blockComments.filter(runsPastItsEnd)
		.map((comment) => `ran past the end of ${JSON.stringify(comment.slice(0, 50))}`);
}

/** Nested interpolation is why this walks the source instead of matching a pair of backticks:
 * a template inside `${…}` closes the outer pattern early and truncates what is examined. */
export function literalsIn(source) {
	return scanTypeScript(source).literals;
}

export function examinedStatementsIn(source) {
	return literalsIn(source)
		.filter((literal) => LOOKS_LIKE_SQL.test(literal) || CARRIES_A_LINE_COMMENT.test(literal))
		.flatMap(statementsOf);
}

function sourceFiles() {
	const directory = `${repositoryRoot}/${SOURCE_ROOT}`;
	if (!existsSync(directory)) {
		return null;
	}
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`.replace(`${repositoryRoot}/`, ""))
		.sort();
}

export function scanSqlCollapse() {
	const files = sourceFiles();
	if (files === null) {
		return { offenders: [], blindSpots: [], statementsScanned: 0, filesScanned: 0 };
	}

	const offenders = [];
	const blindSpots = [];
	let statementsScanned = 0;
	for (const path of files) {
		const source = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		for (const fault of walkerFaults(source)) {
			blindSpots.push(`${path}: ${fault}`);
		}
		for (const statement of examinedStatementsIn(source)) {
			statementsScanned += 1;
			if (!survivesCollapsing(statement)) {
				const remains = onOneLine(withoutSqlComments(onOneLine(statement)));
				offenders.push(
					`${path}: ${onOneLine(statement).slice(0, 60)}… leaves ${remains === "" ? "nothing" : `only "${remains.slice(0, 60)}"`}`,
				);
			}
		}
	}

	return { offenders, blindSpots, statementsScanned, filesScanned: files.length };
}
