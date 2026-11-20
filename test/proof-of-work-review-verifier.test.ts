import { describe, expect, it } from "vitest";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import { createProofOfWorkChallenges } from "../src/core/pow/challenge.js";
import {
	isSolvedAt,
	LARGEST_PROOF_OF_WORK_NONCE,
	proofOfWorkInput,
	writtenSolution,
} from "../src/core/pow/work.js";
import { testKeyProvider } from "./auth-fixtures.js";

/**
 * Review of the verifier of change 2 as a fuzz and property case (S-RATE-9): from a fixed seed,
 * every single-character edit, deletion and insertion of a valid solution, every prefix of it,
 * random strings over a wide alphabet and solutions assembled from random fields are checked. The
 * check must never throw and must accept only what an independent oracle says is a solution of the
 * challenge as it was handed out, for the route it was handed out for.
 */

const ROUTE = "signUp.withPassword";
const OTHER_ROUTE = "password.requestReset";
const DIFFICULTY = 12;

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const ALPHABET = [
	..."0123456789",
	..."abcxyzABCXYZ",
	"-",
	"_",
	".",
	"+",
	"/",
	"=",
	" ",
	"\t",
	"\u0000",
	"é",
	"١",
	"０",
	"😀",
	"﻿",
];

async function isGenuineSolution(challenge: string, presented: string): Promise<boolean> {
	const separator = presented.lastIndexOf(".");
	if (separator === -1 || presented.slice(0, separator) !== challenge) {
		return false;
	}
	const nonceText = presented.slice(separator + 1);
	if (
		!/^(0|[1-9][0-9]{0,15})$/.test(nonceText) ||
		Number(nonceText) > LARGEST_PROOF_OF_WORK_NONCE
	) {
		return false;
	}
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", proofOfWorkInput(challenge, Number(nonceText))),
	);
	return isSolvedAt(digest, DIFFICULTY);
}

async function fixture() {
	const challenges = createProofOfWorkChallenges(testKeyProvider());
	const issued = await challenges.issue({
		route: ROUTE,
		difficulty: DIFFICULTY,
		expiresAt: new Date(Date.now() + 600_000),
	});
	const solution = writtenSolution(issued.challenge, await solveProofOfWork(issued));
	return { challenges, challenge: issued.challenge, solution };
}

function editsOf(solution: string): string[] {
	const edited: string[] = [];
	for (let position = 0; position <= solution.length; position += 1) {
		edited.push(solution.slice(0, position));
		if (position < solution.length) {
			edited.push(solution.slice(0, position) + solution.slice(position + 1));
		}
		for (const character of ALPHABET) {
			edited.push(solution.slice(0, position) + character + solution.slice(position));
			if (position < solution.length) {
				edited.push(solution.slice(0, position) + character + solution.slice(position + 1));
			}
		}
	}
	return edited.filter((candidate) => candidate !== solution);
}

function randomText(random: () => number): string {
	const length = Math.floor(random() * 220);
	let text = "";
	for (let index = 0; index < length; index += 1) {
		text += ALPHABET[Math.floor(random() * ALPHABET.length)];
	}
	return text;
}

function randomBase64Url(random: () => number, length: number): string {
	const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let text = "";
	for (let index = 0; index < length; index += 1) {
		text += characters[Math.floor(random() * characters.length)];
	}
	return text;
}

function randomAssembled(random: () => number, challenge: string): string {
	const [version, difficulty, expiry, value, mac] = challenge.split(".");
	const pick = <T>(choices: readonly T[]): T => choices[Math.floor(random() * choices.length)] as T;
	return [
		pick([version, "0", "01", "2", "2147483647", "2147483648", "99999999999"]),
		pick([difficulty, "0", "00", "20", "21", "99", "100", "-1"]),
		pick([expiry, "0", "1", "4102444800", "999999999999", "9999999999999"]),
		pick([
			value,
			randomBase64Url(random, 43),
			randomBase64Url(random, 42),
			randomBase64Url(random, 44),
		]),
		pick([mac, randomBase64Url(random, 43), `${mac}=`, (mac ?? "").slice(0, 42)]),
		pick([
			"0",
			"1",
			String(Math.floor(random() * 2 ** 53)),
			"9007199254740991",
			"9007199254740992",
		]),
	].join(".");
}

describe("the verifier under fuzzing (S-RATE-9)", () => {
	it("accepts only the oracle's solutions among every single edit and prefix, and never throws", async () => {
		const { challenges, challenge, solution } = await fixture();
		const edits = editsOf(solution);
		let accepted = 0;
		let genuine = 0;
		let threw = 0;

		for (const presented of edits) {
			const outcome = await challenges.check({ route: ROUTE, presented }).catch(() => null);
			if (outcome === null) {
				threw += 1;
				continue;
			}
			const shouldAccept = await isGenuineSolution(challenge, presented);
			genuine += shouldAccept ? 1 : 0;
			if (outcome.outcome === "checked") {
				accepted += 1;
				expect(shouldAccept, presented).toBe(true);
			}
		}

		expect(edits.length).toBeGreaterThan(5000);
		expect(threw).toBe(0);
		expect(accepted).toBe(genuine);
		expect((await challenges.check({ route: ROUTE, presented: solution })).outcome).toBe("checked");
		expect((await challenges.check({ route: OTHER_ROUTE, presented: solution })).outcome).toBe(
			"refused",
		);
	});

	it("accepts none of 3000 random or assembled inputs and never throws", async () => {
		const { challenges, challenge } = await fixture();
		const random = seeded(0x5eed_2026);
		let threw = 0;
		let accepted = 0;

		for (let round = 0; round < 3000; round += 1) {
			const presented = round % 2 === 0 ? randomText(random) : randomAssembled(random, challenge);
			const outcome = await challenges.check({ route: ROUTE, presented }).catch(() => null);
			if (outcome === null) {
				threw += 1;
			} else if (
				outcome.outcome === "checked" &&
				!(await isGenuineSolution(challenge, presented))
			) {
				accepted += 1;
			}
		}

		expect(threw).toBe(0);
		expect(accepted).toBe(0);
	});

	it("never throws and never accepts for an empty, a huge or a lone-surrogate input", async () => {
		const { challenges, solution } = await fixture();
		const inputs = [
			"",
			".",
			".....",
			"\ud800",
			`${solution}\ud800`,
			`${solution}.`,
			`.${solution}`,
			`${solution}\n`,
			solution.repeat(2),
			"9".repeat(1_000_000),
			`${"0.".repeat(100_000)}0`,
		];

		for (const presented of inputs) {
			const outcome = await challenges.check({ route: ROUTE, presented }).catch(() => null);
			expect(outcome?.outcome, presented.slice(0, 30)).toBe("refused");
		}
	});
});
