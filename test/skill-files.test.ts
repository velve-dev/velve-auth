import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexSkillFrom, SkillTransformError } from "../tools/codex-skill.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const skill = readFileSync(`${repositoryRoot}/CLAUDE-SKILL.md`, "utf8");
const codex = readFileSync(`${repositoryRoot}/CODEX-SKILL.md`, "utf8");

/** CLAUDE.md §6: the session check compares this line against the published copy, so its shape
 * is part of the contract rather than a formatting choice. */
const VERSION_LINE = /^\*\*Skill version (\d+) · (\d{4}-\d{2}-\d{2})\*\*$/m;
const VERSION_RULE = "**This number tracks this file, never the library.**";
const A_REWORDED_PASSAGE = "Most of the difficulty in this skill is here.";

describe("the agent skill", () => {
	it("produces CODEX-SKILL.md byte for byte", () => {
		expect(codex).toBe(codexSkillFrom(skill));
	});

	it("states the same version, in the documented form, in both files", () => {
		const stated = VERSION_LINE.exec(skill);
		expect(stated, "CLAUDE-SKILL.md states no version line").not.toBeNull();
		expect(VERSION_LINE.exec(codex)?.[0]).toBe(stated?.[0]);
		expect(Number(stated?.[1])).toBeGreaterThan(0);

		const day = String(stated?.[2]);
		expect(new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10)).toBe(day);
	});

	it("carries the rule that the version tracks the file into both", () => {
		expect(skill).toContain(VERSION_RULE);
		expect(codex).toContain(VERSION_RULE);
	});

	it("addresses an agent that holds one file, not a skill", () => {
		expect(codex).not.toMatch(/this skill/i);
	});

	// Both refusals keep "found nothing" apart from "could not look": a transform that quietly
	// skipped a rewording would write a file that then compares equal to itself for ever.
	it("refuses a skill it can no longer reword rather than producing one", () => {
		const reworded = skill.replace(A_REWORDED_PASSAGE, "Most of the difficulty is here.");
		expect(reworded).not.toBe(skill);
		expect(() => codexSkillFrom(reworded)).toThrow(SkillTransformError);
	});

	it("refuses a skill that states no version", () => {
		expect(() => codexSkillFrom(skill.replace(VERSION_LINE, ""))).toThrow(SkillTransformError);
	});
});
