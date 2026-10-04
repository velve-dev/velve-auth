import { describe, expect, it } from "vitest";
import { createSessionToken } from "../src/core/session/token.js";

const SAMPLE = 1000;
const NIGHTLY_SAMPLE = 1_000_000;
const BASE64URL_OF_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function decodedLength(token: string): number {
	const bytes = Buffer.from(token, "base64url");
	//a token that does not survive the round trip is not canonical base64url
	return bytes.toString("base64url") === token ? bytes.length : -1;
}

describe("T-RAND-2 — a session token is 32 random bytes in base64url (S-RAND-2)", () => {
	it("draws 1000 tokens of 43 characters that decode to 32 bytes, with no duplicate", () => {
		const tokens = Array.from({ length: SAMPLE }, () => createSessionToken().token as string);

		expect(tokens.filter((token) => !BASE64URL_OF_32_BYTES.test(token))).toStrictEqual([]);
		expect(new Set(tokens.map(decodedLength))).toStrictEqual(new Set([32]));
		expect(new Set(tokens).size).toBe(SAMPLE);
	});

	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"draws a million tokens without a collision",
		() => {
			const seen = new Set<string>();
			for (let index = 0; index < NIGHTLY_SAMPLE; index += 1) {
				seen.add(createSessionToken().token);
			}
			expect(seen.size).toBe(NIGHTLY_SAMPLE);
		},
		300_000,
	);
});
