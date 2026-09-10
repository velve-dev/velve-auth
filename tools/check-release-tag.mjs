import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "package.json";
const TAG = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const DIST_TAG = process.argv[3] ?? process.env.VELVE_RELEASE_DIST_TAG ?? "";

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

const kind = prerelease === undefined ? "a stable version" : `a prerelease (${prerelease})`;
console.log(`release tag: ${TAG} matches ${name}@${version} — ${kind} published under ${DIST_TAG}`);
