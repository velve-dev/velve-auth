import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "package.json";
const TAG = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const DIST_TAG = process.argv[3] ?? process.env.VELVE_RELEASE_DIST_TAG ?? "";
const REGISTRY = process.env.VELVE_REGISTRY ?? "https://registry.npmjs.org";

/** https://semver.org, the published expression, anchored. */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function refuse(reason, detail) {
	console.error(`The release tag cannot be checked: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(1);
}

function manifestVersion() {
	let contents;
	try {
		contents = readFileSync(`${repositoryRoot}${MANIFEST}`, "utf8");
	} catch (error) {
		refuse(`${MANIFEST} could not be read`, String(error));
	}
	let parsed;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		refuse(`${MANIFEST} is not JSON`, String(error));
	}
	if (parsed === null || typeof parsed !== "object") {
		refuse(`${MANIFEST} is JSON but not an object`, `it parses to ${String(parsed)}`);
	}
	if (typeof parsed.version !== "string" || parsed.version === "") {
		refuse(
			`${MANIFEST} states no version`,
			"a manifest without one cannot disagree with a tag, and that is not agreement",
		);
	}
	return { version: parsed.version, name: parsed.name };
}

if (TAG === "") {
	refuse(
		"no tag was given",
		"pass it as the first argument or in GITHUB_REF_NAME — an unchecked tag is not a matching one",
	);
}
if (DIST_TAG === "") {
	refuse("no dist-tag was given", "pass it as the second argument or in VELVE_RELEASE_DIST_TAG");
}

const { version, name } = manifestVersion();
const findings = [];

if (!TAG.startsWith("v")) {
	findings.push(`The tag ${TAG} does not begin with v, so it names no version of this package.`);
}

const tagged = TAG.replace(/^v/, "");
if (tagged !== version) {
	findings.push(
		`The tag says ${tagged} and ${MANIFEST} says ${version}. A release under a name the tree does not carry publishes the wrong thing under the right name.`,
	);
}

const parsed = SEMVER.exec(version);
if (parsed === null) {
	findings.push(`${MANIFEST} states ${version}, which is not a semantic version.`);
}

/** npm resolves a bare `npm install <name>` to whatever `latest` points at, so a prerelease
 * published there reaches every consumer who asked for none. */
const prerelease = parsed?.[4];
if (prerelease !== undefined && DIST_TAG === "latest") {
	findings.push(
		`Version ${version} carries the prerelease ${prerelease} and would be published under latest, which is what a bare install resolves to.`,
	);
}

if (findings.length > 0) {
	for (const finding of findings) console.error(finding);
	process.exit(1);
}

/** An unauthenticated read of a scoped package that does not exist answers 401 and not 404,
 * because the registry will not say whether a private one is there. Both mean absent here. */
const ABSENT = new Set([401, 404]);

/** npm points `latest` at the first version a package ever publishes, whatever `--tag` says, so
 * the clause above cannot see the one case where a prerelease takes `latest` anyway (E-1771). */
async function packageIsAlreadyOnTheRegistry() {
	let response;
	try {
		response = await fetch(`${REGISTRY}/-/package/${encodeURIComponent(name)}/dist-tags`, {
			headers: { accept: "application/json", "cache-control": "no-cache" },
		});
	} catch (error) {
		return { unreachable: String(error) };
	}
	if (ABSENT.has(response.status)) {
		return { present: false };
	}
	if (!response.ok) {
		return { unreachable: `${response.status} ${response.statusText}` };
	}
	return { present: true };
}

const onTheRegistry = await packageIsAlreadyOnTheRegistry();
if (onTheRegistry.unreachable !== undefined) {
	console.error(
		`release tag: ${REGISTRY} could not be asked whether ${name} is published, so whether this is its first publish is unknown: ${onTheRegistry.unreachable}`,
	);
} else if (onTheRegistry.present === false && prerelease !== undefined) {
	console.error(
		`release tag: this is the first publish of ${name}, and npm points latest at a package's first version whatever --tag says. ${version} will therefore carry latest as well as ${DIST_TAG}, and a bare install will resolve to a prerelease until a stable version takes latest from it.`,
	);
}

const kind = prerelease === undefined ? "a stable version" : `a prerelease (${prerelease})`;
console.log(`release tag: ${TAG} matches ${name}@${version} — ${kind} published under ${DIST_TAG}`);
