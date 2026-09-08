import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createSessionToken,
	type IssuedSessionToken,
	type SessionToken,
	sessionTokenHash,
} from "../src/core/session/token.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function tokens(count: number): IssuedSessionToken[] {
	return Array.from({ length: count }, () => createSessionToken());
}

describe("the session token (architecture 3.5, S-RAND-1)", () => {
	it("carries 32 bytes in base64url without padding", () => {
		const issued = createSessionToken();

		expect(issued.token).toMatch(BASE64URL);
		expect(issued.token).toHaveLength(43);
		expect(issued.token).not.toContain("=");
	});

	it("draws a different token every time", () => {
		const drawn = tokens(256).map((issued) => issued.token);

		expect(new Set(drawn).size).toBe(drawn.length);
	});

	it("decodes to 32 bytes of the alphabet the encoder claims", () => {
		const issued = createSessionToken();
		const decoded = Buffer.from(issued.token, "base64url");

		expect(decoded).toHaveLength(32);
		expect(Buffer.from(decoded).toString("base64url")).toBe(issued.token);
	});
});

describe("what leaves the process (S-TIM-4, architecture 3.5)", () => {
	it("hands out the SHA-256 of the token text, so only the hash can be stored", () => {
		const issued = createSessionToken();
		const expected = createHash("sha256").update(issued.token, "utf8").digest();

		expect(Buffer.from(issued.tokenHash)).toEqual(expected);
	});

	it("hashes the same token to the same 32 bytes and different tokens apart", () => {
		const first = createSessionToken();
		const second = createSessionToken();

		expect(sessionTokenHash(first.token)).toEqual(first.tokenHash);
		expect(first.tokenHash).toHaveLength(32);
		expect(Buffer.from(first.tokenHash)).not.toEqual(Buffer.from(second.tokenHash));
	});

	it("keeps nothing beside the token and its hash", () => {
		const issued: IssuedSessionToken = createSessionToken();
		const plaintext: SessionToken = issued.token;

		expect(Object.keys(issued)).toEqual(["token", "tokenHash"]);
		expect(Buffer.from(issued.tokenHash).toString("utf8")).not.toBe(plaintext);
	});
});
