import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { createProofOfWorkChallenges } from "../src/core/pow/challenge.js";
import {
	difficultyWithinBounds,
	failureThresholdWithinBounds,
	HIGHEST_PROOF_OF_WORK_DIFFICULTY,
	MOST_SIGN_IN_FAILURES_BEFORE_PROOF,
} from "../src/core/pow/config.js";
import {
	isSolvedAt,
	LARGEST_PROOF_OF_WORK_NONCE,
	leadingZeroBits,
	proofOfWorkInput,
	writtenSolution,
} from "../src/core/pow/work.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";

/**
 * The verifier on its own (3.9, S-RATE-9, S-RATE-12): one hash over the bytes both sides build in
 * one place, a mac over the route the challenge is for, and a parser that refuses anything the
 * challenge route never hands out. The fuzz cases draw from a seeded generator, so a failure
 * names an input that can be replayed.
 */

const NOW = new Date();
const ROUTE = "signUp.withPassword";

function keysWithVersions(...versions: number[]) {
	const keysByVersion: Record<number, string> = {};
	for (const version of versions) {
		keysByVersion[version] = encodeBase64Url(randomBytes(32));
	}
	return {
		keysByVersion,
		provider: (currentVersion: number) => rootKeyProvider({ currentVersion, keysByVersion }),
	};
}

async function solvedChallenge(difficulty = 6) {
	const keys = keysWithVersions(1).provider(1);
	const challenges = createProofOfWorkChallenges(keys);
	const issued = await challenges.issue({ route: ROUTE, difficulty, expiresAt: NOW });
	const nonce = await solveProofOfWork(issued);
	return { challenges, issued, nonce, solution: writtenSolution(issued.challenge, nonce) };
}

/** mulberry32: small, seeded and good enough to spread fuzz inputs, never used for a secret */
function seededGenerator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = "0123456789.abcdefABCDEF-_xyz~ é\u0000";

function randomText(next: () => number, length: number): string {
	return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
}

describe("the bytes both sides hash (S-RATE-9)", () => {
	it("are the challenge's UTF-8 followed by the nonce as eight big-endian bytes", () => {
		const input = proofOfWorkInput("ab", 2 ** 32 + 258);

		expect([...input]).toStrictEqual([0x61, 0x62, 0, 0, 0, 1, 0, 0, 1, 2]);
		expect([...proofOfWorkInput("", LARGEST_PROOF_OF_WORK_NONCE)]).toStrictEqual([
			0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		]);
	});

	it("count leading zero bits across byte boundaries", () => {
		const vectors: [number[], number][] = [
			[[0xff], 0],
			[[0x80], 0],
			[[0x7f], 1],
			[[0x01], 7],
			[[0x00, 0x80], 8],
			[[0x00, 0x00, 0x0f], 20],
			[[0x00, 0x00, 0x00], 24],
		];
		for (const [bytes, zeros] of vectors) {
			expect(leadingZeroBits(new Uint8Array(bytes))).toBe(zeros);
		}
		expect(isSolvedAt(new Uint8Array([0x00, 0x0f]), 12)).toBe(true);
		expect(isSolvedAt(new Uint8Array([0x00, 0x0f]), 13)).toBe(false);
	});
});

describe("a solution the challenge route handed out (S-RATE-9)", () => {
	it("is checked for the route it was issued for", async () => {
		const { challenges, solution } = await solvedChallenge();

		const checked = await challenges.check({ route: ROUTE, presented: solution });

		expect(checked.outcome).toBe("checked");
	});

	it("is refused as forged for any other route", async () => {
		const { challenges, solution } = await solvedChallenge();

		const checked = await challenges.check({ route: "signIn.password", presented: solution });

		expect(checked).toStrictEqual({ outcome: "refused", reason: "proof_of_work_forged" });
	});

	it("is refused as unsolved with a nonce that misses the difficulty", async () => {
		const { challenges, issued, nonce } = await solvedChallenge(12);
		let missing = nonce + 1;
		while (
			isSolvedAt(
				new Uint8Array(
					await crypto.subtle.digest("SHA-256", proofOfWorkInput(issued.challenge, missing)),
				),
				12,
			)
		) {
			missing += 1;
		}

		const checked = await challenges.check({
			route: ROUTE,
			presented: writtenSolution(issued.challenge, missing),
		});

		expect(checked).toStrictEqual({ outcome: "refused", reason: "proof_of_work_unsolved" });
	});

	it("still checks after the key ring moved on, while its version stays in the ring", async () => {
		const ring = keysWithVersions(1, 2);
		const before = createProofOfWorkChallenges(ring.provider(1));
		const after = createProofOfWorkChallenges(ring.provider(2));
		const issued = await before.issue({ route: ROUTE, difficulty: 2, expiresAt: NOW });
		const solution = writtenSolution(issued.challenge, await solveProofOfWork(issued));

		expect((await after.check({ route: ROUTE, presented: solution })).outcome).toBe("checked");
	});

	it("is refused as forged once its key version left the ring", async () => {
		const { solution } = await solvedChallenge();
		const other = createProofOfWorkChallenges(keysWithVersions(3).provider(3));

		expect(await other.check({ route: ROUTE, presented: solution })).toStrictEqual({
			outcome: "refused",
			reason: "proof_of_work_forged",
		});
	});

	it("is refused as forged when any signed field is changed", async () => {
		const { challenges, solution } = await solvedChallenge();
		const [version, difficulty, expiresAt, value, mac, nonce] = solution.split(".");
		const flipped = (text: string) => `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;
		const changed = [
			[version, "0", expiresAt, value, mac, nonce],
			[version, difficulty, String(Number(expiresAt) + 1), value, mac, nonce],
			[version, difficulty, expiresAt, flipped(value ?? ""), mac, nonce],
			[version, difficulty, expiresAt, value, flipped(mac ?? ""), nonce],
		];

		for (const fields of changed) {
			const checked = await challenges.check({ route: ROUTE, presented: fields.join(".") });
			expect(checked.outcome).toBe("refused");
		}
	});
});

describe("a presented value the challenge route never hands out (S-RATE-9)", () => {
	it("is refused as malformed for wrong lengths, huge nonces and foreign spellings", async () => {
		const { challenges, solution } = await solvedChallenge();
		const [version, difficulty, expiresAt, value, mac, nonce] = solution.split(".");
		const malformed = [
			"",
			".",
			"1.2.3",
			`${solution}.1`,
			`${solution} `,
			[version, difficulty, expiresAt, `${value}A`, mac, nonce].join("."),
			[version, difficulty, expiresAt, value?.slice(1), mac, nonce].join("."),
			[version, difficulty, expiresAt, value, mac?.slice(1), nonce].join("."),
			[version, difficulty, expiresAt, value, mac, "9007199254740992"].join("."),
			[version, difficulty, expiresAt, value, mac, "100000000000000000000"].join("."),
			[version, difficulty, expiresAt, value, mac, "-1"].join("."),
			[version, difficulty, expiresAt, value, mac, "01"].join("."),
			[version, difficulty, expiresAt, value, mac, "1e3"].join("."),
			[version, difficulty, expiresAt, value, mac, "0x10"].join("."),
			["0", difficulty, expiresAt, value, mac, nonce].join("."),
			[version, String(HIGHEST_PROOF_OF_WORK_DIFFICULTY + 1), expiresAt, value, mac, nonce].join(
				".",
			),
			[version, difficulty, expiresAt, `+${value?.slice(1)}`, mac, nonce].join("."),
			`${solution.slice(0, 60)}${"9".repeat(200)}`,
		];

		for (const presented of malformed) {
			expect(await challenges.check({ route: ROUTE, presented })).toStrictEqual({
				outcome: "refused",
				reason: "proof_of_work_malformed",
			});
		}
	});

	//a changed nonce may still solve the unchanged challenge, which is a solution and not a fault
	async function stillSolves(challenge: string, presented: string, difficulty: number) {
		const separator = presented.lastIndexOf(".");
		const nonce = presented.slice(separator + 1);
		if (presented.slice(0, separator) !== challenge || !/^(0|[1-9][0-9]{0,15})$/.test(nonce)) {
			return false;
		}
		const digest = await crypto.subtle.digest(
			"SHA-256",
			proofOfWorkInput(challenge, Number(nonce)),
		);
		return (
			Number(nonce) <= LARGEST_PROOF_OF_WORK_NONCE && isSolvedAt(new Uint8Array(digest), difficulty)
		);
	}

	it("never checks and never throws for two thousand random inputs", async () => {
		const { challenges, issued, solution } = await solvedChallenge(12);
		const next = seededGenerator(20261120);
		const outcomes = new Set<string>();

		for (let draw = 0; draw < 2000; draw += 1) {
			const presented =
				draw % 2 === 0
					? randomText(next, Math.floor(next() * 200))
					: [...solution]
							.map((character) => (next() < 0.03 ? randomText(next, 1) : character))
							.join("");
			const checked = await challenges.check({ route: ROUTE, presented });
			const expected = (await stillSolves(issued.challenge, presented, 12)) ? "checked" : "refused";
			expect(checked.outcome, presented).toBe(expected);
			outcomes.add(checked.outcome === "refused" ? checked.reason : checked.outcome);
		}

		expect(outcomes.has("proof_of_work_malformed")).toBe(true);
		expect(outcomes.has("proof_of_work_forged")).toBe(true);
	});
});

describe("the bounds the library holds the application's answers to (S-RATE-12)", () => {
	it("clamps the difficulty to 0 to 20 bits and reads no number as the hardest", () => {
		expect(difficultyWithinBounds(-3)).toBe(0);
		expect(difficultyWithinBounds(0)).toBe(0);
		expect(difficultyWithinBounds(12.2)).toBe(13);
		expect(difficultyWithinBounds(1000)).toBe(20);
		expect(difficultyWithinBounds(Number.POSITIVE_INFINITY)).toBe(20);
		expect(difficultyWithinBounds(Number.NaN)).toBe(20);
		expect(difficultyWithinBounds("8")).toBe(20);
		expect(HIGHEST_PROOF_OF_WORK_DIFFICULTY).toBe(20);
	});

	it("clamps the failure threshold to 1 to 100 and reads no number as the strictest", () => {
		expect(failureThresholdWithinBounds(0)).toBe(1);
		expect(failureThresholdWithinBounds(5.9)).toBe(5);
		expect(failureThresholdWithinBounds(10_000)).toBe(MOST_SIGN_IN_FAILURES_BEFORE_PROOF);
		expect(failureThresholdWithinBounds(Number.NEGATIVE_INFINITY)).toBe(1);
		expect(failureThresholdWithinBounds(undefined)).toBe(1);
	});

	it("refuses to start with a proof of work it could not ask", () => {
		const unusable = [
			{},
			{ difficulty: () => 4 },
			{ difficulty: 4, signInFailuresBeforeProof: () => 3 },
			null,
		];
		for (const proofOfWork of unusable) {
			expect(() =>
				createVelveAuth(
					configFor({
						database: { query: async () => [], transaction: async () => undefined as never },
						rateLimit: { proofOfWork: proofOfWork as never },
					}),
				),
			).toThrow(VelveStartupError);
		}
	});
});
