/** CLAUDE.md §6: CODEX-SKILL.md is produced from CLAUDE-SKILL.md rather than written, so this
 * transform is the file's definition and check-codex-skill.mjs is what makes that a fact. */

const BODY_ANCHOR = "You are an expert on Velve Auth. Not a reader of it";
const BODY_LEAD = "You are an expert on Velve Auth. ";
const DISCIPLINE_OPENS = "**This number tracks this file";
const DISCIPLINE_ENDS = "This file is the Claude Code skill.";
const VERSION_LINE = /^\*\*Skill version \d+ · \d{4}-\d{2}-\d{2}\*\*$/m;

/** The Codex file addresses an agent that takes one instruction file, so it says "these
 * instructions" where the skill says "this skill", with the verb agreement that follows. */
const REWORDINGS = [
	[
		"**This skill contains no copy of the library's documentation, deliberately.**",
		"**These instructions contain no copy of the library's documentation, deliberately.**",
	],
	[
		"the confidently-wrong answer this skill exists to prevent",
		"the confidently-wrong answer these instructions exist to prevent",
	],
	[
		"value of this skill is that it does not produce one.",
		"value of these instructions is that they do not produce one.",
	],
	[
		"Three rules this skill applies to itself, which it long applied only to the files it\nreads.",
		"Three rules these instructions apply to themselves, which they long applied only to\nthe files they read.",
	],
	[
		"**Where this skill and the file it reads disagree, the file wins, and the disagreement\nis a defect in this skill.**",
		"**Where these instructions and the file they read disagree, the file wins, and the\ndisagreement is a defect in these instructions.**",
	],
	[
		"**This skill states method, never fact about the library.**",
		"**These instructions state method, never fact about the library.**",
	],
	[
		"**Adding a fact about the library's features to this skill is a defect, not a\nconvenience.**",
		"**Adding a fact about the library's features to these instructions is a defect, not a\nconvenience.**",
	],
	[
		"write it into the documentation this skill reads instead",
		"write it into the documentation these instructions read instead",
	],
	[
		"as usable is the exact failure this skill exists to prevent",
		"as usable is the exact failure these instructions exist to prevent",
	],
	[
		"Most of the difficulty in this skill is here.",
		"Most of the difficulty in these instructions is here.",
	],
	[
		"Collapsing them is how this skill misleads people.",
		"Collapsing them is how these instructions mislead people.",
	],
];

export class SkillTransformError extends Error {}

function required(condition, reason) {
	if (!condition) throw new SkillTransformError(reason);
}

function headerFor(versionLine, discipline) {
	return `# Velve Auth — expert instructions

${versionLine}

${discipline}Give this file to Codex, or any coding agent that takes a single instruction file,
before asking it about Velve Auth. It is self-contained: paste it, attach it, or save
it as \`AGENTS.md\` in the project root.

The Claude Code skill at [\`CLAUDE-SKILL.md\`](./CLAUDE-SKILL.md) carries the same
instructions. This file is produced from it rather than written: \`pnpm check:codex-skill\`
regenerates it and refuses a copy that differs by a byte, so the two cannot drift.

These instructions are installed as \`AGENTS.md\` in a project, and their current copy
is \`https://raw.githubusercontent.com/velve-dev/velve-auth/main/CODEX-SKILL.md\`.
Installing a new version means writing that URL over that file — \`curl -fsSL … -o …\`
overwrites, so the update command is the install command and there is no second
procedure. An update takes effect the next time the file is read, and it is read when it
is given to you — there is no directory to be watched and nothing to restart.

---

You are an expert on **Velve Auth** (\`@velve/auth\`), a TypeScript and PostgreSQL
authentication library.

`;
}

export function codexSkillFrom(claude) {
	const version = VERSION_LINE.exec(claude);
	required(version !== null, 'the skill states no "**Skill version <n> · <yyyy-mm-dd>**" line');

	const disciplineOpens = claude.indexOf(DISCIPLINE_OPENS);
	const disciplineEnds = claude.indexOf(DISCIPLINE_ENDS);
	required(disciplineOpens > -1, `the skill has no paragraph opening "${DISCIPLINE_OPENS}"`);
	required(
		disciplineEnds > disciplineOpens,
		`the skill has no line "${DISCIPLINE_ENDS}" after that paragraph`,
	);

	const bodyStart = claude.indexOf(BODY_ANCHOR);
	required(bodyStart > -1, `the skill has no line opening "${BODY_ANCHOR}"`);

	const header = headerFor(version[0], claude.slice(disciplineOpens, disciplineEnds));
	let codex = header + claude.slice(bodyStart + BODY_LEAD.length);

	for (const [from, to] of REWORDINGS) {
		required(codex.includes(from), `the skill no longer contains the reworded passage "${from}"`);
		codex = codex.split(from).join(to);
	}

	const survivor = /.*\bthis skill\b.*/i.exec(codex);
	required(survivor === null, `"this skill" survives the rewording: ${survivor?.[0]}`);

	return codex;
}
