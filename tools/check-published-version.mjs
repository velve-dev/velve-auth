import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = process.env.VELVE_REGISTRY ?? "https://registry.npmjs.org";
const DIST_TAG = process.argv[2] ?? "";
const NAME_OVERRIDE = process.argv[3];
const VERSION_OVERRIDE = process.argv[4];
const DEADLINE_MS = Number(process.env.VELVE_REGISTRY_DEADLINE_MS ?? 180_000);
const POLL_MS = 5_000;
const PROVENANCE = "https://slsa.dev/provenance/v1";
const PRERELEASE = /-/;

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
 * than concluded; an unreachable registry is never concluded from at all. */
async function pollUntilPresent(url, describe) {
	const started = Date.now();
	let last = { absent: 0 };
	do {
		last = await ask(url);
		if (last.body !== undefined) {
			return last.body;
		}
		await sleep(POLL_MS);
	} while (Date.now() - started < DEADLINE_MS);
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
);
if (distTags !== null) {
	if (distTags[DIST_TAG] !== version) {
		findings.push(
			`The dist-tag ${DIST_TAG} points at ${distTags[DIST_TAG] ?? "nothing"} and not at ${version}.`,
		);
	}
	if (PRERELEASE.test(version) && distTags.latest === version) {
		findings.push(
			`${version} is a prerelease and latest points at it, so a bare install of ${name} resolves to it.`,
		);
	}
}

const attestations = await pollUntilPresent(
	`${REGISTRY}/-/npm/v1/attestations/${encoded}@${version}`,
	`the attestations of ${name}@${version}`,
);
if (attestations !== null) {
	const predicates =
		attestations.attestations?.map((attestation) => attestation.predicateType) ?? [];
	if (!predicates.includes(PROVENANCE)) {
		findings.push(
			`${name}@${version} carries no ${PROVENANCE} attestation; the registry lists ${predicates.length === 0 ? "none" : predicates.join(", ")}.`,
		);
	}
}

if (refusals.length > 0) {
	refuse(refusals[0], refusals.slice(1).join("; ") || undefined);
}
if (findings.length > 0) {
	for (const finding of findings) console.error(finding);
	process.exit(1);
}

console.log(
	`published version: ${REGISTRY} resolves ${name}@${version}, ${DIST_TAG} points at it, and it carries a provenance attestation`,
);
