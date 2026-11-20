import { describe, expect, it } from "vitest";
import {
	compareWithAnchors,
	consultAnchors,
	type SecurityStateAnchorPort,
} from "../src/core/security-state/anchor.js";

/**
 * 3.15 G: an anchor whose `minimumVersion` throws or answers anything other than `null` or a valid
 * floor is a broken state, and the request is refused with the alarm `anchor_unavailable` (3.18,
 * S-INTEG-2). A floor whose field is a getter that throws is such an answer, and it must be read as
 * one rather than reject the whole reading.
 */

function portAnswering(answer: () => unknown): SecurityStateAnchorPort {
	return {
		minimumVersion: () => Promise.resolve(answer()),
		recordSeal: () => Promise.resolve(),
	};
}

describe("an anchor floor that throws while it is read (3.15 G, S-INTEG-2)", () => {
	it("reads a floor whose version getter throws as an unavailable anchor", async () => {
		const floor = {
			get version(): number {
				throw new Error("planted by the anchor");
			},
			digest: "A".repeat(43),
		};

		const reading = await consultAnchors([portAnswering(() => floor)], "a-user");

		expect(reading).toStrictEqual({ kind: "unavailable" });
		expect(compareWithAnchors(null, reading)).toBe("anchor_unavailable");
	});

	it("reads a floor whose digest getter throws as an unavailable anchor", async () => {
		const floor = {
			version: 1,
			get digest(): string {
				throw new Error("planted by the anchor");
			},
		};

		await expect(consultAnchors([portAnswering(() => floor)], "a-user")).resolves.toStrictEqual({
			kind: "unavailable",
		});
	});
});
