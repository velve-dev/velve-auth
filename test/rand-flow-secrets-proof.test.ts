import { describe, expect, it } from "vitest";
import {
	createFlowPointer,
	createPkceVerifier,
	stateOfPointer,
} from "../src/core/oauth/flow-secrets.js";

const SAMPLE = 1000;
const MINIMUM_BYTES = 32;
//RFC 7636 section 4.1 allows the unreserved characters and a length of 43 to 128
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function decodedLength(value: string): number {
	const bytes = Buffer.from(value, "base64url");
	return bytes.toString("base64url") === value ? bytes.length : -1;
}

function draw(create: () => string): string[] {
	return Array.from({ length: SAMPLE }, create);
}

describe("T-RAND-4 — the OAuth flow secrets carry at least 256 bits (S-RAND-4)", () => {
	it.each([
		["PKCE verifier", createPkceVerifier],
		["flow pointer", createFlowPointer],
		["state", () => stateOfPointer(createFlowPointer())],
	] as const)(
		"1000 values of the %s decode to at least 32 bytes, with no duplicate",
		(_, create) => {
			const values = draw(create);

			expect(values.filter((value) => decodedLength(value) < MINIMUM_BYTES)).toStrictEqual([]);
			expect(new Set(values).size).toBe(SAMPLE);
		},
	);

	it("keeps every PKCE verifier inside the characters and the 43 to 128 RFC 7636 allows", () => {
		expect(draw(createPkceVerifier).filter((value) => !PKCE_VERIFIER.test(value))).toStrictEqual(
			[],
		);
	});
});
