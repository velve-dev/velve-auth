import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { bindToken, type TokenBinding } from "../src/core/token/binding.js";

// E-3131 freezes the storage format of the token MAC. A frozen format is held by an answer that
// does not come from the code under test: the encoding is rebuilt here from its description (a
// type byte, a four-byte length, the bytes) and the MAC from the root key by HKDF-SHA256.

const ROOT_KEY = Buffer.alloc(32, 7);
const TEXT = 1;
const BYTES = 2;
const LIST = 3;
const INTEGER = 4;
const ABSENT = 0;

function tlv(type: number, length: number, body: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32BE(length, 1);
	return Buffer.concat([head, body]);
}
const text = (value: string) => tlv(TEXT, Buffer.byteLength(value), Buffer.from(value, "utf8"));
const optionalText = (value: string | null) =>
	value === null ? tlv(ABSENT, 0, Buffer.alloc(0)) : text(value);
const integer = (value: number) => {
	const body = Buffer.alloc(8);
	body.writeBigInt64BE(BigInt(value));
	return tlv(INTEGER, 8, body);
};
const list = (items: readonly string[]) =>
	Buffer.concat([tlv(LIST, items.length, Buffer.alloc(0)), ...items.map(text)]);

function referenceEncoding(binding: TokenBinding): Buffer {
	const content = binding.content;
	const tail =
		"payload" in content
			? optionalText(content.payload === null ? null : JSON.stringify(content.payload))
			: "ceremony" in content
				? text(content.ceremony)
				: "sessionEpoch" in content
					? Buffer.concat([
							text(content.sessionId),
							list(content.factors),
							integer(content.sessionEpoch),
							integer(content.createdAtMicros),
						])
					: Buffer.concat([list(content.factors), integer(content.attempts)]);
	return Buffer.concat([
		text("velve-auth/token-binding/v1"),
		text(binding.purpose),
		optionalText(binding.ownerId),
		tlv(BYTES, binding.tokenSha256.length, Buffer.from(binding.tokenSha256)),
		tail,
	]);
}

function referenceMac(binding: TokenBinding): Buffer {
	const key = Buffer.from(
		hkdfSync(
			"sha256",
			ROOT_KEY,
			Buffer.from("velve-auth/hkdf-sha256/v1"),
			Buffer.from("velve-auth/key/token-mac"),
			32,
		),
	);
	return createHmac("sha256", key).update(referenceEncoding(binding)).digest();
}

const hash = new Uint8Array(32).fill(9);
const BINDINGS: readonly [string, TokenBinding][] = [
	[
		"a session",
		{
			purpose: "session",
			ownerId: "0f0e0d0c-0b0a-4908-8706-050403020100",
			tokenSha256: hash,
			content: {
				sessionId: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
				factors: ["password", "totp"],
				sessionEpoch: 3,
				createdAtMicros: 1_767_225_600_123_456,
			},
		},
	],
	[
		"a pending authentication",
		{
			purpose: "pending_authentication",
			ownerId: "0f0e0d0c-0b0a-4908-8706-050403020100",
			tokenSha256: hash,
			content: { factors: ["password"], attempts: 2 },
		},
	],
	[
		"a one-time token with a payload",
		{
			purpose: "email_change",
			ownerId: "0f0e0d0c-0b0a-4908-8706-050403020100",
			tokenSha256: hash,
			content: { payload: { newEmail: "a@example.com" } },
		},
	],
	[
		"a WebAuthn challenge without an owner",
		{
			purpose: "webauthn_challenge",
			ownerId: null,
			tokenSha256: hash,
			content: { ceremony: "authenticate" },
		},
	],
	[
		"a one-time token without owner or payload",
		{ purpose: "magic_link", ownerId: null, tokenSha256: hash, content: { payload: null } },
	],
];

describe("the token MAC is the one the frozen format describes (E-3131, S-INTEG-9)", () => {
	it.each(BINDINGS)("matches an independent computation for %s", async (_name, binding) => {
		const keys = rootKeyProvider({
			currentVersion: 1,
			keysByVersion: { 1: ROOT_KEY.toString("base64url") },
		});

		const stored = await bindToken(keys, binding);

		expect(Buffer.from(stored.tokenMac).toString("hex")).toBe(
			referenceMac(binding).toString("hex"),
		);
	});
});
