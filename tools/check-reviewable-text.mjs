import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** A NUL byte makes git classify a file as binary: `git grep -I` skips it and a diff
 * shows only "Bin", so the file escapes both halves of the attribution scan and human
 * review at once. CI refuses it; running the same check here means an author finds out
 * while writing rather than at the merge gate. */
const NOT_TEXT = /^assets\//;

function trackedTextFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => !NOT_TEXT.test(path))
		.filter((path) => lstatSync(`${repositoryRoot}/${path}`, { throwIfNoEntry: false })?.isFile());
}

const offenders = trackedTextFiles().filter((path) =>
	readFileSync(`${repositoryRoot}/${path}`).includes(0),
);

if (offenders.length > 0) {
	console.error("A NUL byte hides a file from review and from the attribution scan.");
	for (const path of offenders) console.error(`  ${path} — write it as \\u0000 instead`);
	process.exit(1);
}

console.log(`review: ${trackedTextFiles().length} text files scanned, none hidden by a NUL byte`);
