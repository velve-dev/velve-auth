import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import {
	compareWithAnchors,
	consultAnchors,
	decodeAnchorFloor,
	recordSealWithAnchors,
	type SecurityStateAnchorPort,
	type SecurityStateFloor,
	type SecurityStateSealedEvent,
} from "../src/core/security-state/anchor.js";

//the anchor port answers what T-INTEG-4 and T-INTEG-6 ask of the request path (E-3150)

const USER_ID = "6f1c2b8e-1d2a-4a51-9c5e-0d3f7a9b1c22";
const DIGEST = new Uint8Array(32).fill(7);
const OTHER_DIGEST = new Uint8Array(32).fill(8);

function anchorAnswering(answer: () => unknown): SecurityStateAnchorPort {
	return {
		minimumVersion: async () => answer() as SecurityStateFloor | null,
		recordSeal: async () => undefined,
	};
}

function floor(version: number, digest: Uint8Array = DIGEST): SecurityStateFloor {
	return { version, digest: encodeBase64Url(digest) };
}

describe("an anchor's answer is a floor, null, or a broken state (S-INTEG-6)", () => {
	const malformed: ReadonlyArray<readonly [string, unknown]> = [
		["undefined", undefined],
		["a version NaN", { version: Number.NaN, digest: encodeBase64Url(DIGEST) }],
		["a version 1.5", { version: 1.5, digest: encodeBase64Url(DIGEST) }],
		["a version -1", { version: -1, digest: encodeBase64Url(DIGEST) }],
		["a version 0", { version: 0, digest: encodeBase64Url(DIGEST) }],
		["a version 2 ** 53", { version: 2 ** 53, digest: encodeBase64Url(DIGEST) }],
		["a digest of 31 bytes", { version: 3, digest: encodeBase64Url(new Uint8Array(31)) }],
		["a digest of 33 bytes", { version: 3, digest: encodeBase64Url(new Uint8Array(33)) }],
		["no digest", { version: 3 }],
		["a digest that is no base64url", { version: 3, digest: "not base64url!" }],
		["a version given as a string", { version: "3", digest: encodeBase64Url(DIGEST) }],
		["a number", 3],
		["a string", "3"],
	];

	for (const [name, answer] of malformed) {
		it(`reads ${name} as unavailable, never as no floor`, async () => {
			expect(decodeAnchorFloor(answer)).toBe("malformed");
			const reading = await consultAnchors([anchorAnswering(() => answer)], USER_ID);
			expect(reading).toEqual({ kind: "unavailable" });
			expect(compareWithAnchors({ version: 5, digest: DIGEST }, reading)).toBe(
				"anchor_unavailable",
			);
		});
	}

	it("reads a rejected promise and a synchronous throw as unavailable", async () => {
		const rejecting: SecurityStateAnchorPort = {
			minimumVersion: async () => {
				throw new Error("store down");
			},
			recordSeal: async () => undefined,
		};
		const throwing = {
			minimumVersion: () => {
				throw new Error("store down");
			},
			recordSeal: async () => undefined,
		} as unknown as SecurityStateAnchorPort;

		expect(await consultAnchors([rejecting], USER_ID)).toEqual({ kind: "unavailable" });
		expect(await consultAnchors([throwing], USER_ID)).toEqual({ kind: "unavailable" });
	});

	it("reads null as no floor and the largest safe integer as a floor", async () => {
		expect(decodeAnchorFloor(null)).toBeNull();
		expect(decodeAnchorFloor(floor(Number.MAX_SAFE_INTEGER))).toEqual({
			version: Number.MAX_SAFE_INTEGER,
			digest: DIGEST,
		});
	});

	it("asks every anchor with the account's id and refuses when any one of them fails", async () => {
		const asked: string[] = [];
		const answering: SecurityStateAnchorPort = {
			minimumVersion: async ({ userId }) => {
				asked.push(userId);
				return floor(2);
			},
			recordSeal: async () => undefined,
		};

		const reading = await consultAnchors(
			[answering, anchorAnswering(() => ({ version: 0 }))],
			USER_ID,
		);

		expect(asked).toEqual([USER_ID]);
		expect(reading).toEqual({ kind: "unavailable" });
	});
});

describe("a stored seal compared with the floors", () => {
	async function verdictFor(
		stored: { version: number; digest: Uint8Array<ArrayBuffer> } | null,
		...answers: unknown[]
	) {
		const reading = await consultAnchors(
			answers.map((answer) => anchorAnswering(() => answer)),
			USER_ID,
		);
		return compareWithAnchors(stored, reading);
	}

	it("is within the floor at the floor's version and digest", async () => {
		expect(await verdictFor({ version: 4, digest: DIGEST }, floor(4))).toBe("within_floor");
	});

	it("is below the anchor under the floor's version", async () => {
		expect(await verdictFor({ version: 3, digest: DIGEST }, floor(4))).toBe("version_below_anchor");
	});

	it("is a mismatch at the floor's version with another digest", async () => {
		expect(await verdictFor({ version: 4, digest: OTHER_DIGEST }, floor(4))).toBe(
			"anchor_mismatch",
		);
	});

	it("is ahead of an anchor that recorded less or nothing, so a verified seal can be recorded again", async () => {
		expect(await verdictFor({ version: 5, digest: DIGEST }, floor(4))).toBe("ahead_of_anchor");
		expect(await verdictFor({ version: 1, digest: DIGEST }, null)).toBe("ahead_of_anchor");
	});

	it("is within the floor with no anchor and for an unsealed account no anchor knows", async () => {
		expect(await verdictFor({ version: 5, digest: DIGEST })).toBe("within_floor");
		expect(await verdictFor(null, null)).toBe("within_floor");
	});

	it("is below the anchor for an account without a seal row that an anchor holds a floor for", async () => {
		expect(await verdictFor(null, floor(1))).toBe("version_below_anchor");
	});

	it("refuses on the highest floor among several anchors", async () => {
		expect(await verdictFor({ version: 4, digest: DIGEST }, floor(2), floor(6))).toBe(
			"version_below_anchor",
		);
		expect(await verdictFor({ version: 6, digest: DIGEST }, floor(6, OTHER_DIGEST), floor(2))).toBe(
			"anchor_mismatch",
		);
	});
});

describe("recording a seal with the anchors after commit", () => {
	const event: SecurityStateSealedEvent = {
		userId: USER_ID,
		version: 4,
		digest: encodeBase64Url(DIGEST),
	};

	it("hands every anchor the event and reports nothing when all succeed", async () => {
		const recorded: SecurityStateSealedEvent[] = [];
		const anchor: SecurityStateAnchorPort = {
			minimumVersion: async () => null,
			recordSeal: async (sealed) => {
				recorded.push(sealed);
			},
		};
		let failures = 0;

		await recordSealWithAnchors([anchor, anchor], event, () => {
			failures += 1;
		});

		expect(recorded).toEqual([event, event]);
		expect(failures).toBe(0);
	});

	it("reports one failure however many anchors fail, and never rejects", async () => {
		const failing = {
			minimumVersion: async () => null,
			recordSeal: () => {
				throw new Error("store down");
			},
		} as unknown as SecurityStateAnchorPort;
		let failures = 0;

		await expect(
			recordSealWithAnchors([failing, failing], event, () => {
				failures += 1;
			}),
		).resolves.toBeUndefined();

		expect(failures).toBe(1);
	});
});
