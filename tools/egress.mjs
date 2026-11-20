import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chunksOf, withoutComments } from "./source-text.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `README.md` promises that the only traffic leaving an operator's infrastructure goes to the
 * OAuth providers they chose to enable, and that enabling none sends none. Nothing enforced it.
 * A library that answers who is signed in has no business reaching anywhere else, and a telemetry
 * call added later would be one line nobody would see in a diff (E-1844).
 */
const CALLS_OUT =
	/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\s*\(|\bnavigator\.sendBeacon\b/g;

/**
 * A network destination, which is narrower than an absolute URL in two ways, each a rule with a
 * stated limit rather than an exception for a file.
 *
 * Only the schemes that carry data off the machine: `otpauth://` is a provisioning URI handed to
 * an authenticator app and reaches nothing. And the host must carry a dot, because a single-label
 * name is not a public destination — `https://velve-auth` is the base `new URL(path, base)` is
 * given to normalise a relative path, and is never fetched. The limit of the second rule: a
 * single-label host **can** resolve on an internal network, so a deliberate exfiltration to one
 * would pass this scan.
 */
const A_NETWORK_DESTINATION = /\b(?:https?|wss?):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/**
 * The two files that may reach the network, and nothing else.
 * `outbound.ts` is the one provider seam: the implementation is injected through `config.fetch`,
 * so an operator can see or refuse every outbound request. `transport.ts` is the browser client
 * calling the application's own mounted routes, which is not egress from the operator at all.
 */
const MAY_CALL_OUT = new Set(["src/core/oauth/outbound.ts", "src/client/transport.ts"]);

/** The one file that may name an external host: the fourteen providers 3.10 enumerates. */
const MAY_NAME_A_HOST = "src/core/oauth/providers.ts";

/** Loopback is not egress; a test or a doc string naming it sends nothing anywhere. */
const NOT_A_DESTINATION = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|example\.(?:com|org))/i;

/** A URI that names a standard is an identifier, not somewhere a request goes. */
const A_STANDARD_URI =
	/^https?:\/\/(?:www\.)?(?:w3\.org|schemas\.|slsa\.dev|iana\.org|rfc-editor\.org)/i;

const SOURCE = /^src\/.*\.ts$/;

/**
 * A request needs no `fetch(` beside it, and no literal URL either, so four further shapes are
 * refused outside the seam (E-3892). Each one is a text rule over the code with comments, string
 * bodies and regular expression literals blanked, so a word in a message or in a pattern is not
 * read as a reference.
 *
 * The built-in modules that open a socket or resolve a name, imported, re-exported or required
 * under either spelling: test/keys-static-scan.test.ts refuses the `node:` spelling under
 * src/core only, and the bare one nowhere.
 */
const NETWORK_MODULE =
	/\b(?:from|import|require)\s*\(?\s*(["'`])(?:node:)?(https?|http2|net|tls|dgram|dns(?:\/promises)?)\1/g;

/** `fetch` written as a name rather than reached through an object: passed, aliased, destructured
 * or called through `.call`, `.apply` or `.bind`, all of which `fetch(` does not see. */
const FETCH_BY_NAME = /(?<![.\w$])fetch\b/g;

/** A fetch reached through any object and then called indirectly. */
const FETCH_CALLED_INDIRECTLY = /\.\s*fetch\s*\.\s*(?:call|apply|bind)\b/g;

/** The global object's own fetch read as a value, which is an alias in all but name. */
const GLOBAL_FETCH = /\b(?:globalThis|window|self|global)\s*(?:\?\.|\.)\s*fetch\b/g;

/** A computed member of the global object, or the global object handed to a reflective read, which
 * reaches fetch without writing its name. */
const GLOBAL_COMPUTED =
	/\b(?:globalThis|window|self|global)\s*(?:\?\.\s*)?\[|\b(?:Reflect\s*\.\s*(?:get|apply|getOwnPropertyDescriptor)|Object\s*\.\s*getOwnPropertyDescriptors?)\s*\(\s*(?:globalThis|window|self|global)\b/g;

/**
 * The one place the global fetch is read as a value: the provider service resolves the fetch it
 * hands to outbound.ts, the injected one or the global one when none was injected. The exact
 * expression is permitted in that file once, and any other reference there is a finding.
 */
const DEFAULT_FETCH = {
	path: "src/core/oauth/service.ts",
	expression: "services.fetch ?? globalThis.fetch",
};

const TYPE_OPERATOR_BEFORE = /\btypeof\s*$/;
const KEY_POSITION_BEFORE = /(?:^|[{,;(]|\breadonly)\s*$/;
const KEY_POSITION_AFTER = /^\s*\??\s*:/;
const REGEX_MAY_START_AFTER = /(?:^|[(,=:[!&|?{};]|\breturn|\btypeof|\bcase)\s*$/;

/** The end of a regular expression literal opening at `start`, or -1 when the slash is a division:
 * a literal closes on its own line at a slash outside a character class. */
function endOfRegexLiteral(code, start) {
	let inClass = false;
	for (let index = start + 1; index < code.length; index += 1) {
		const character = code[index];
		if (character === "\n") return -1;
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "[") inClass = true;
		if (character === "]") inClass = false;
		if (character === "/" && !inClass) return index + 1;
	}
	return -1;
}

function withoutRegexLiterals(code) {
	let kept = "";
	let index = 0;
	while (index < code.length) {
		const end =
			code[index] === "/" && REGEX_MAY_START_AFTER.test(kept.slice(-40))
				? endOfRegexLiteral(code, index)
				: -1;
		if (end === -1) {
			kept += code[index];
			index += 1;
			continue;
		}
		kept += "/r/";
		index = end;
	}
	return kept;
}

/** The code alone: comments become a space, every string body becomes an empty string, and every
 * regular expression literal becomes `/r/`, so only what the program names is left. */
function codeOnly(source) {
	let code = "";
	for (const chunk of chunksOf(source)) {
		if (chunk.kind === "code") code += withoutRegexLiterals(chunk.text);
		else code += chunk.kind === "quoted" ? '""' : " ";
	}
	return code;
}

function isTypeOrKeyPosition(code, at, length) {
	const before = code.slice(Math.max(0, at - 40), at);
	if (TYPE_OPERATOR_BEFORE.test(before)) return true;
	return KEY_POSITION_BEFORE.test(before) && KEY_POSITION_AFTER.test(code.slice(at + length));
}

function fetchReferencesIn(path, code) {
	const found = [];
	for (const match of code.matchAll(FETCH_BY_NAME)) {
		if (code.slice(match.index + 5).match(/^\s*\(/)) continue;
		if (isTypeOrKeyPosition(code, match.index, 5)) continue;
		found.push(`${path}: refers to fetch by name, which is a request no fetch( shows`);
	}
	for (const match of code.matchAll(FETCH_CALLED_INDIRECTLY)) {
		found.push(
			`${path}: calls fetch indirectly with ${match[0].replace(/^[.\s]*fetch\s*\.\s*/, "")}`,
		);
	}
	const permitted = path === DEFAULT_FETCH.path ? code.replace(DEFAULT_FETCH.expression, "") : code;
	for (const match of permitted.matchAll(GLOBAL_FETCH)) {
		if (TYPE_OPERATOR_BEFORE.test(permitted.slice(Math.max(0, match.index - 40), match.index))) {
			continue;
		}
		found.push(`${path}: takes the global fetch as a value with ${match[0]}`);
	}
	for (const match of code.matchAll(GLOBAL_COMPUTED)) {
		found.push(
			`${path}: reads the global object by a computed or reflective member with ${match[0]}`,
		);
	}
	return found;
}

function sourceFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => SOURCE.test(path));
}

export function egressIn(path, source) {
	const code = withoutComments(source);
	const found = [];
	if (!MAY_CALL_OUT.has(path)) {
		for (const call of code.matchAll(CALLS_OUT)) {
			found.push(`${path}: reaches the network with ${String(call[0]).replace(/\s*\($/, "")}`);
		}
		for (const module of code.matchAll(NETWORK_MODULE)) {
			found.push(`${path}: imports the network module ${module[2]}`);
		}
		found.push(...fetchReferencesIn(path, codeOnly(source)));
	}
	if (path !== MAY_NAME_A_HOST) {
		for (const url of code.matchAll(A_NETWORK_DESTINATION)) {
			const written = String(url[0]);
			if (NOT_A_DESTINATION.test(written) || A_STANDARD_URI.test(written)) {
				continue;
			}
			found.push(`${path}: names the external host ${written}`);
		}
	}
	return found;
}

export function scanEgress() {
	const offenders = [];
	let filesScanned = 0;
	let callsScanned = 0;
	for (const path of sourceFiles()) {
		filesScanned += 1;
		const source = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		if (MAY_CALL_OUT.has(path)) {
			callsScanned += [...withoutComments(source).matchAll(CALLS_OUT)].length;
		}
		offenders.push(...egressIn(path, source));
	}
	return { offenders, filesScanned, callsScanned };
}
