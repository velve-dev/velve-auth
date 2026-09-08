import { describe, expect, it } from "vitest";
import { NONCE_BYTES } from "../src/core/keys/aes-gcm.js";
import {
	type EncryptionKeyPurpose,
	KEY_PURPOSES,
	type KeyPurpose,
	openEnvelope,
	rootKeyProvider,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { randomBytes } from "../src/core/token/index.js";
import { generateRootKey } from "./keys-fixtures.js";

// T-KEY-2 fixes the threshold as all 30 ordered pairs of the six purposes failing. Two purposes
// sign and four encrypt, so "produce and consume" is spelled out for each combination rather than
// only for the four encryption purposes.

const SIGNING_PURPOSES: readonly KeyPurpose[] = ["cookie-sig", "token-pepper"];

const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

const MESSAGE = new TextEncoder().encode("a value produced under exactly one purpose");
const NONCE = randomBytes(NONCE_BYTES);

function isSigningPurpose(purpose: KeyPurpose): boolean {
	return SIGNING_PURPOSES.includes(purpose);
}

async function produceUnder(purpose: KeyPurpose): Promise<Uint8Array<ArrayBuffer>> {
	const { key } = await keys.current(purpose);

	if (isSigningPurpose(purpose)) {
		return new Uint8Array(await crypto.subtle.sign("HMAC", key, MESSAGE));
	}

	return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE }, key, MESSAGE));
}

async function readsUnder(
	purpose: KeyPurpose,
	artifact: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	const { key } = await keys.current(purpose);

	try {
		if (isSigningPurpose(purpose)) {
			return await crypto.subtle.verify("HMAC", key, artifact, MESSAGE);
		}

		const opened = new Uint8Array(
			await crypto.subtle.decrypt({ name: "AES-GCM", iv: NONCE }, key, artifact),
		);
		return opened.length === MESSAGE.length;
	} catch {
		return false;
	}
}

const ORDERED_PAIRS = KEY_PURPOSES.flatMap((produced) =>
	KEY_PURPOSES.filter((consumed) => consumed !== produced).map((consumed) => ({
		produced,
		consumed,
	})),
);

describe("cross-purpose use of a purpose key (S-KEY-2)", () => {
	it("enumerates every ordered pair of the six purposes", () => {
		expect(ORDERED_PAIRS).toHaveLength(30);
	});

	it("reads back a value under the purpose that produced it", async () => {
		for (const purpose of KEY_PURPOSES) {
			expect(await readsUnder(purpose, await produceUnder(purpose))).toBe(true);
		}
	});

	it.each(ORDERED_PAIRS)(
		"does not read a $produced value under $consumed",
		async ({ produced, consumed }) => {
			expect(await readsUnder(consumed, await produceUnder(produced))).toBe(false);
		},
	);
});

describe("cross-purpose use through the envelope (S-KEY-2)", () => {
	const ENCRYPTION_PURPOSES = KEY_PURPOSES.filter(
		(purpose): purpose is EncryptionKeyPurpose => !isSigningPurpose(purpose),
	);

	it.each(
		ENCRYPTION_PURPOSES.flatMap((produced) =>
			ENCRYPTION_PURPOSES.filter((consumed) => consumed !== produced).map((consumed) => ({
				produced,
				consumed,
			})),
		),
	)("does not open a $produced envelope under $consumed", async ({ produced, consumed }) => {
		const envelope = await sealEnvelope(keys, produced, MESSAGE);

		await expect(openEnvelope(keys, consumed, envelope)).rejects.toThrow();
	});

	it("keeps the key material of the two signing purposes unexportable", async () => {
		for (const purpose of SIGNING_PURPOSES) {
			const { key } = await keys.current(purpose);
			expect(key.extractable).toBe(false);
			await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
		}
	});
});
