import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./source-text.mjs";

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
