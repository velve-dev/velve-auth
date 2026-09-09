import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codexSkillFrom, SkillTransformError } from "./codex-skill.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SKILL = "CLAUDE-SKILL.md";
const CODEX = "CODEX-SKILL.md";
const WRITE = process.argv.includes("--write");

function refuse(reason, detail) {
	console.error(`${CODEX} cannot be checked: ${reason}`);
	if (detail !== undefined) console.error(`  ${detail}`);
	process.exit(1);
}

function read(path) {
	try {
		return readFileSync(`${repositoryRoot}/${path}`, "utf8");
	} catch {
		return null;
	}
}

const skill = read(SKILL);
if (skill === null) {
	refuse(`${SKILL} cannot be read`, "it is the source the Codex file is produced from");
}

let expected = "";
try {
	expected = codexSkillFrom(skill);
} catch (error) {
	if (!(error instanceof SkillTransformError)) throw error;
	refuse(
		`the transform no longer applies to ${SKILL}`,
		`${error.message} — a transform that cannot run is not a transform that found nothing`,
	);
}

if (WRITE) {
	writeFileSync(`${repositoryRoot}/${CODEX}`, expected);
	console.log(`codex skill: ${CODEX} written from ${SKILL}, ${expected.length} bytes`);
	process.exit(0);
}

const committed = read(CODEX);
if (committed === null) {
	refuse(`${CODEX} cannot be read`, "regenerate it with: node tools/check-codex-skill.mjs --write");
}

if (committed !== expected) {
	const mine = committed.split("\n");
	const theirs = expected.split("\n");
	const at = mine.findIndex((line, index) => line !== theirs[index]);
	console.error(`${CODEX} is not what ${SKILL} produces.`);
	console.error(
		"CLAUDE.md §6: the Codex file is produced from the skill rather than written, so a hand-edit of it is a defect.",
	);
	console.error(`  first difference at line ${at + 1}`);
	console.error(`  committed: ${mine[at] ?? "(end of file)"}`);
	console.error(`  generated: ${theirs[at] ?? "(end of file)"}`);
	console.error("  regenerate with: node tools/check-codex-skill.mjs --write");
	process.exit(1);
}

console.log(`codex skill: ${CODEX} is byte-identical to what ${SKILL} produces`);
