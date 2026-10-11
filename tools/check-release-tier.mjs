import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Architecture 6.19 puts the release tier before every release. The publish runs on the
 * maintainer's machine (E-2760), so this asks GitHub's public REST API whether `release-tier.yml`
 * has a successful run on the exact commit about to be published. The repository is public, so
 * the read needs no token and no credential is involved.
 *
 * Three outcomes, kept apart because a check has to tell found nothing from could not look
 * (CLAUDE.md section 5): a successful run on the commit passes with exit 0, no such run is a
 * finding with exit 1, and an API that could not be asked or answered something unreadable is a
 * refusal with exit 2.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const API = process.env.VELVE_GITHUB_API ?? "https://api.github.com";
const WORKFLOW = "release-tier.yml";
const COMMIT = process.argv[2] ?? "";
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/;

function refuse(reason, detail) {
	console.error(`The release tier cannot be checked: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(2);
}

function repositoryOfManifest() {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8"));
	} catch (error) {
		refuse("package.json could not be read", String(error));
	}
	const url =
		typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url;
	const match = typeof url === "string" ? REPOSITORY.exec(url) : null;
	if (match === null) {
		refuse("package.json names no GitHub repository", `repository is ${JSON.stringify(url)}`);
	}
	return match[1];
}

if (!FULL_COMMIT.test(COMMIT)) {
	refuse(
		"no full commit id was given",
		`pass the output of git rev-parse HEAD as the first argument, not ${JSON.stringify(COMMIT)}`,
	);
}

const repository = repositoryOfManifest();
const url = `${API}/repos/${repository}/actions/workflows/${WORKFLOW}/runs?head_sha=${COMMIT}&status=success&per_page=100`;

let response;
try {
	response = await fetch(url, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "velve-auth-release-check",
			"x-github-api-version": "2022-11-28",
		},
	});
} catch (error) {
	refuse(`${url} could not be reached`, String(error));
}
if (!response.ok) {
	refuse(`${url} answered ${response.status} ${response.statusText}`);
}

let body;
try {
	body = await response.json();
} catch (error) {
	refuse(`the body of ${url} is not JSON`, String(error));
}
if (typeof body?.total_count !== "number" || !Array.isArray(body?.workflow_runs)) {
	refuse(
		`${url} answered without total_count and workflow_runs`,
		JSON.stringify(body).slice(0, 200),
	);
}

/** The filters are read back from each run rather than trusted, because an API that ignored a
 * misspelt filter would answer with every run of the workflow and the count alone would pass. */
const passed = body.workflow_runs.filter(
	(run) => run?.head_sha === COMMIT && run?.conclusion === "success",
);

if (body.total_count === 0 || passed.length === 0) {
	console.error(
		`No successful run of ${WORKFLOW} on ${COMMIT} in ${repository}. Push the commit to main, wait for the release tier to finish green, and start again.`,
	);
	process.exit(1);
}

console.log(
	`release tier: ${WORKFLOW} passed on ${COMMIT} in ${repository} (${passed[0].html_url ?? `run ${passed[0].id}`})`,
);
