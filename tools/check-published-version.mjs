import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = process.env.VELVE_REGISTRY ?? "https://registry.npmjs.org";
const DIST_TAG = process.argv[2] ?? "";
const NAME_OVERRIDE = process.argv[3];
const VERSION_OVERRIDE = process.argv[4];
const DEADLINE_MS = Number(process.env.VELVE_REGISTRY_DEADLINE_MS ?? 180_000);
const POLL_MS = Number(process.env.VELVE_REGISTRY_POLL_MS ?? 5_000);
const PRERELEASE = /-/;
const SEMANTIC = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareIdentifiers(x, y) {
	const [numericX, numericY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
	if (numericX && numericY) return Math.sign(Number(x) - Number(y));
	if (numericX !== numericY) return numericX ? -1 : 1;
	return x === y ? 0 : x < y ? -1 : 1;
}

function comparePrereleases(left, right) {
	if (left === undefined || right === undefined) {
		return left === right ? 0 : left === undefined ? 1 : -1;
	}
	const [x, y] = [left.split("."), right.split(".")];
	for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
		const order = compareIdentifiers(x[index], y[index]);
		if (order !== 0) return order;
	}
	return Math.sign(x.length - y.length);
}

/** Precedence as semver.org section 11 states it: the three numbers, then a release above any of
 * its prereleases, then the prerelease identifiers one by one, numbers below words. Anything that
 * is not a semantic version compares as unknown and is reported rather than ranked. */
function compareVersions(left, right) {
	const [a, b] = [SEMANTIC.exec(left), SEMANTIC.exec(right)];
	if (a === null || b === null) return undefined;
	for (let index = 1; index <= 3; index += 1) {
		const difference = Math.sign(Number(a[index]) - Number(b[index]));
		if (difference !== 0) return difference;
	}
	return comparePrereleases(a[4], b[4]);
}

/** An unauthenticated read of a scoped package that does not exist answers 401 and not 404,
 * because the registry will not say whether a private one is there. Both mean absent here. */
const ABSENT = new Set([401, 404]);

const findings = [];
const refusals = [];

function refuse(reason, detail) {
	for (const finding of findings) console.error(finding);
	console.error(`The published version cannot be checked: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(1);
}

function packageUnderTest() {
	if (NAME_OVERRIDE !== undefined && VERSION_OVERRIDE === undefined) {
		refuse("a name was given without a version", "pass both, or neither and read package.json");
	}
	if (NAME_OVERRIDE !== undefined && VERSION_OVERRIDE !== undefined) {
		return { name: NAME_OVERRIDE, version: VERSION_OVERRIDE };
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8"));
	} catch (error) {
		refuse("package.json could not be read", String(error));
	}
	if (manifest === null || typeof manifest !== "object") {
		refuse("package.json is JSON but not an object", `it parses to ${String(manifest)}`);
	}
	if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
		refuse("package.json states no name or no version");
	}
	return { name: manifest.name, version: manifest.version };
}

/** Distinguishes the three answers a registry gives: what it said, that what was asked for is
 * not there, and that it could not be asked. Only the third is a refusal. */
async function ask(url) {
	let response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json", "cache-control": "no-cache" },
		});
	} catch (error) {
		return { unreachable: String(error) };
	}
	if (ABSENT.has(response.status)) {
		return { absent: response.status };
	}
	if (!response.ok) {
		return { unreachable: `${response.status} ${response.statusText}` };
	}
	try {
		return { body: await response.json() };
	} catch (error) {
		return { unreachable: `the body of ${url} is not JSON: ${String(error)}` };
	}
}

/** A publish reaches the registry's read path after it returns, so absence is polled rather
 * than concluded; an unreachable registry is never concluded from at all. A body that is there but
 * not yet what the publish makes it, a dist-tag still on the previous version, is polled as well,
 * and the last one read is what the findings are taken from (E-2767). */
async function pollUntilPresent(url, describe, settled = () => true) {
	const started = Date.now();
	let last = { absent: 0 };
	let lastBody = null;
	for (;;) {
		last = await ask(url);
		if (last.body !== undefined) {
			lastBody = last.body;
			if (settled(last.body)) {
				return last.body;
			}
		}
		if (Date.now() - started >= DEADLINE_MS) {
			break;
		}
		await sleep(POLL_MS);
	}
	if (lastBody !== null) {
		return lastBody;
	}
	if (last.unreachable !== undefined) {
		refusals.push(`${describe} could not be read within ${DEADLINE_MS} ms: ${last.unreachable}`);
		return null;
	}
	findings.push(
		`${describe} is absent from ${REGISTRY} after ${DEADLINE_MS} ms (HTTP ${last.absent}).`,
	);
	return null;
}

const { name, version } = packageUnderTest();
if (DIST_TAG === "") {
	refuse(
		"no dist-tag was given",
		"pass it as the first argument — a publish whose tag is unchecked is not a publish that was checked",
	);
}

const encoded = encodeURIComponent(name);

const published = await pollUntilPresent(`${REGISTRY}/${encoded}/${version}`, `${name}@${version}`);
if (published !== null && published.version !== version) {
	findings.push(`${REGISTRY} resolves ${name}@${version} to version ${published.version}.`);
}

const distTags = await pollUntilPresent(
	`${REGISTRY}/-/package/${encoded}/dist-tags`,
	`the dist-tags of ${name}`,
	(tags) => tags?.[DIST_TAG] === version,
);
if (distTags !== null) {
	if (distTags[DIST_TAG] !== version) {
		findings.push(
			`The dist-tag ${DIST_TAG} points at ${distTags[DIST_TAG] ?? "nothing"} and not at ${version}.`,
		);
	}
	/** Whether `latest` names a prerelease at all, rather than whether it names this one: it asked
	 * the narrower question until 1.0.0, and was blind to `latest` being stuck on an older
	 * prerelease while `next` moved past it (E-1774). */
	if (typeof distTags.latest === "string" && PRERELEASE.test(distTags.latest)) {
		findings.push(
			`latest points at ${distTags.latest}, which is a prerelease, so a bare install of ${name} resolves to one.`,
		);
	}
	/** A tag the publish never moves stays where it was left, and `npm install <name>@<tag>` keeps
	 * installing that version after every fix since: `next` named 1.0.0-next.2 long after 2.0.1
	 * held `latest` (E-3890). Only the maintainer can move or remove it, so the finding names the
	 * command rather than leaving the reader to look it up. */
	if (typeof distTags.latest === "string") {
		for (const [tag, tagged] of Object.entries(distTags)) {
			if (tag === "latest") continue;
			const order = compareVersions(String(tagged), distTags.latest);
			if (order === undefined) {
				findings.push(
					`The dist-tag ${tag} points at ${String(tagged)}, which cannot be compared with latest (${distTags.latest}).`,
				);
			} else if (order < 0) {
				findings.push(
					`The dist-tag ${tag} points at ${String(tagged)}, which is older than latest (${distTags.latest}), so ${name}@${tag} installs it; remove the tag with npm dist-tag rm ${name} ${tag}.`,
				);
			}
		}
	}
}

/** No attestation is asked for. A publish from the maintainer's machine cannot carry a provenance
 * attestation, because npm mints one only from a CI provider's OIDC token, and this check required
 * one until the publish left CI (E-2761). */
if (refusals.length > 0) {
	refuse(refusals[0], refusals.slice(1).join("; ") || undefined);
}
if (findings.length > 0) {
	for (const finding of findings) console.error(finding);
	process.exit(1);
}

console.log(
	`published version: ${REGISTRY} resolves ${name}@${version}, ${DIST_TAG} points at it, latest names no prerelease, and no dist-tag names a version older than latest`,
);
