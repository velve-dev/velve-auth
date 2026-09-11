const QUOTES = new Set(["'", '"', "`"]);

function endOfBlockComment(source, index) {
	const close = source.indexOf("*/", index + 2);
	return close === -1 ? source.length : close + 2;
}

function endOfLineComment(source, index) {
	const newline = source.indexOf("\n", index);
	return newline === -1 ? source.length : newline;
}

function endOfQuoted(source, index) {
	const quote = source[index];
	let cursor = index + 1;
	while (cursor < source.length) {
		if (source[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (source[cursor] !== quote) {
			cursor += 1;
			continue;
		}
		if (quote === "'" && source[cursor + 1] === "'") {
			cursor += 2;
			continue;
		}
		return cursor + 1;
	}
	return source.length;
}

/** `--` opens a comment in SQL but is a decrement in TypeScript, and `//` the
 * reverse, so the file's language decides which one blinds the scanner. */
function commentEndsAt(source, index, lineCommentOpener) {
	if (source.startsWith("/*", index)) return endOfBlockComment(source, index);
	if (source.startsWith(lineCommentOpener, index)) return endOfLineComment(source, index);
	return null;
}

/**
 * One pass over a source file that tells a comment from a string body, so that a marker written
 * inside a statement survives and prose written beside it does not. A scan that reads whole file
 * text instead accuses a comment of being the SQL it describes (E-1621, E-1653).
 */
export function* chunksOf(source, lineCommentOpener = "//") {
	let code = "";
	let index = 0;
	while (index < source.length) {
		const commentEnd = commentEndsAt(source, index, lineCommentOpener);
		if (commentEnd !== null) {
			yield { kind: "code", text: code };
			code = "";
			yield { kind: "comment", text: source.slice(index, commentEnd) };
			index = commentEnd;
			continue;
		}
		if (QUOTES.has(source[index])) {
			const quotedEnd = endOfQuoted(source, index);
			yield { kind: "code", text: code };
			code = "";
			yield { kind: "quoted", text: source.slice(index, quotedEnd) };
			index = quotedEnd;
			continue;
		}
		code += source[index];
		index += 1;
	}
	yield { kind: "code", text: code };
}

/** The file with every comment replaced by one space, and every string body left exactly as it was:
 * the SQL a statement carries lives inside a template literal, markers included. */
export function withoutComments(source, lineCommentOpener = "//") {
	let kept = "";
	for (const chunk of chunksOf(source, lineCommentOpener)) {
		kept += chunk.kind === "comment" ? " " : chunk.text;
	}
	return kept;
}
