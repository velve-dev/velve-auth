import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "package.json";

/** https://semver.org, the published expression, anchored. */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function refuse(reason, detail) {
	console.error(`The dist-tag cannot be decided: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(1);
}

let manifest;
try {
	manifest = JSON.parse(readFileSync(`${repositoryRoot}${MANIFEST}`, "utf8"));
} catch (error) {
	refuse(`${MANIFEST} could not be read`, String(error));
}
if (manifest === null || typeof manifest !== "object") {
	refuse(`${MANIFEST} is JSON but not an object`, `it parses to ${String(manifest)}`);
}
if (typeof manifest.version !== "string") {
	refuse(`${MANIFEST} states no version`);
}

const parsed = SEMVER.exec(manifest.version);
if (parsed === null) {
	refuse(`${MANIFEST} states ${manifest.version}, which is not a semantic version`);
}

/**
 * The version rather than the tag, because the tag is not yet known to name it — `check:release-tag`
 * establishes that later, and it runs before this value reaches a publish (E-1777).
 */
const distTag = parsed[4] === undefined ? "latest" : "next";

/**
 * Written here rather than by the workflow, so that a refusal above is the step's exit status.
 * `echo "value=$(tool)"` would exit zero on a refusal and hand an empty tag to the publish.
 */
if (process.env.GITHUB_OUTPUT !== undefined) {
	appendFileSync(process.env.GITHUB_OUTPUT, `value=${distTag}\n`);
}
console.log(distTag);
