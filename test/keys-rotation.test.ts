import { describe, expect, it } from "vitest";
import {
	decryptWithPurposeKey,
	encryptWithPurposeKey,
	KeyError,
	type KeyProvider,
	openEnvelope,
	randomBytes,
	rootKeyProvider,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { MAXIMUM_KEY_VERSION } from "../src/core/keys/key-version.js";
import { generateRootKey } from "./keys-fixtures.js";

const VERSION_OFFSET = 1 + "A256GCM".length;

function envelopeKeyVersion(envelope: Uint8Array<ArrayBuffer>): number {
	return new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getInt32(
		VERSION_OFFSET,
	);
}

async function keyErrorCodeOf(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(KeyError);
		return (error as KeyError).code;
	}

	return expect.fail("the operation succeeded where the requirement demands a failure");
}

// T-KEY-5 walks the ring through v1, then v2+v1, then v2, restarting the process at each step.
// A fresh `rootKeyProvider` is that restart: it shares nothing with its predecessor but the
// configured root keys.
describe("rotation across process restarts (S-KEY-5, T-KEY-5)", () => {
	const first = generateRootKey();
	const second = generateRootKey();

	const beforeRotation = () => rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: first } });
	const duringRotation = () =>
		rootKeyProvider({ currentVersion: 2, keysByVersion: { 1: first, 2: second } });
	const afterRotation = () => rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: second } });

	it("opens a v1 value after the restart that added v2", async () => {
		const plaintext = randomBytes(64);
		const written = await sealEnvelope(beforeRotation(), "totp-enc", plaintext);

		expect(envelopeKeyVersion(written)).toBe(1);
		expect(await openEnvelope(duringRotation(), "totp-enc", written)).toStrictEqual(plaintext);
	});

	it("writes new values under v2 as soon as v2 is current", async () => {
		const written = await sealEnvelope(duringRotation(), "totp-enc", randomBytes(16));
		expect(envelopeKeyVersion(written)).toBe(2);

		const stored = await encryptWithPurposeKey(duringRotation(), "totp-enc", randomBytes(16));
		expect(stored.keyVersion).toBe(2);
	});

	it("still opens a v1 value written before the ring grew, in the column shape too", async () => {
		const plaintext = randomBytes(48);
		const stored = await encryptWithPurposeKey(beforeRotation(), "password-enc", plaintext);

		expect(stored.keyVersion).toBe(1);
		expect(
			await decryptWithPurposeKey(duringRotation(), "password-enc", 1, stored.ciphertext),
		).toStrictEqual(plaintext);
	});

	it("names the version once it has left the ring, in both shapes", async () => {
		const plaintext = randomBytes(48);
		const envelope = await sealEnvelope(beforeRotation(), "pkce-enc", plaintext);
		const stored = await encryptWithPurposeKey(beforeRotation(), "pkce-enc", plaintext);

		expect(await keyErrorCodeOf(openEnvelope(afterRotation(), "pkce-enc", envelope))).toBe(
			"key_version_unknown",
		);
		expect(
			await keyErrorCodeOf(
				decryptWithPurposeKey(afterRotation(), "pkce-enc", stored.keyVersion, stored.ciphertext),
			),
		).toBe("key_version_unknown");
	});

	it("keeps v2 values readable after the ring shrank", async () => {
		const plaintext = randomBytes(64);
		const written = await sealEnvelope(duringRotation(), "oauth-token-enc", plaintext);

		expect(await openEnvelope(afterRotation(), "oauth-token-enc", written)).toStrictEqual(
			plaintext,
		);
	});
});

// The derivation has to be a function of the root key alone; otherwise a value written by one
// process would be unreadable in the next.
describe("determinism across provider instances (S-KEY-1)", () => {
	const rootKey = generateRootKey();

	it("opens in a second instance what a first instance sealed", async () => {
		const plaintext = randomBytes(96);
		const writer = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });
		const reader = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });

		expect(
			await openEnvelope(reader, "totp-enc", await sealEnvelope(writer, "totp-enc", plaintext)),
		).toStrictEqual(plaintext);
	});

	it("derives byte-identical encryption keys in two instances", async () => {
		const first = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });
		const second = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });

		for (const purpose of ["totp-enc", "oauth-token-enc", "pkce-enc", "password-enc"] as const) {
			const fromFirst = await crypto.subtle.exportKey("raw", (await first.current(purpose)).key);
			const fromSecond = await crypto.subtle.exportKey("raw", (await second.current(purpose)).key);
			expect(new Uint8Array(fromFirst)).toStrictEqual(new Uint8Array(fromSecond));
		}
	});

	it("derives byte-identical signatures from the two signing purposes in two instances", async () => {
		const message = randomBytes(32);
		const first = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });
		const second = rootKeyProvider({ currentVersion: 5, keysByVersion: { 5: rootKey } });

		for (const purpose of ["cookie-sig", "token-pepper"] as const) {
			const bySecond = await crypto.subtle.sign(
				"HMAC",
				(await second.current(purpose)).key,
				message,
			);
			expect(
				await crypto.subtle.verify("HMAC", (await first.current(purpose)).key, bySecond, message),
			).toBe(true);
		}
	});

	it("keeps the version out of the derivation, so two versions of one root key agree", async () => {
		const provider = rootKeyProvider({
			currentVersion: 2,
			keysByVersion: { 1: rootKey, 2: rootKey },
		});

		const fromOne = await crypto.subtle.exportKey(
			"raw",
			(await provider.byVersion("totp-enc", 1)) as CryptoKey,
		);
		const fromTwo = await crypto.subtle.exportKey(
			"raw",
			(await provider.byVersion("totp-enc", 2)) as CryptoKey,
		);

		expect(new Uint8Array(fromOne)).toStrictEqual(new Uint8Array(fromTwo));
	});
});

describe("byVersion resolves rather than throws (S-KEY-4)", () => {
	const keys: KeyProvider = rootKeyProvider({
		currentVersion: 3,
		keysByVersion: { 1: generateRootKey(), 3: generateRootKey() },
	});

	it.each([2, 0, -1, 4, MAXIMUM_KEY_VERSION, MAXIMUM_KEY_VERSION + 1, 1.5, Number.NaN])(
		"returns null for version %s",
		async (version) => {
			await expect(keys.byVersion("password-enc", version)).resolves.toBeNull();
		},
	);

	it("returns a key for every version the ring holds, for every purpose", async () => {
		for (const version of [1, 3]) {
			for (const purpose of [
				"cookie-sig",
				"token-pepper",
				"totp-enc",
				"oauth-token-enc",
				"pkce-enc",
				"password-enc",
			] as const) {
				expect(await keys.byVersion(purpose, version)).not.toBeNull();
			}
		}
	});
});

// L-2 and L-3 put the version in a PostgreSQL `integer` column; the envelope has to agree with
// that column over the whole range, not only for small numbers.
describe("the envelope version agrees with the column version (S-KEY-3, L-2, L-3)", () => {
	it.each([1, 2, 1000, 2_147_483_646, MAXIMUM_KEY_VERSION])(
		"round-trips version %s through both shapes",
		async (version) => {
			const rootKey = generateRootKey();
			const keys = rootKeyProvider({
				currentVersion: version,
				keysByVersion: { [version]: rootKey },
			});
			const plaintext = randomBytes(24);

			const stored = await encryptWithPurposeKey(keys, "password-enc", plaintext);
			const envelope = await sealEnvelope(keys, "password-enc", plaintext);

			expect(stored.keyVersion).toBe(version);
			expect(envelopeKeyVersion(envelope)).toBe(version);
			expect(await openEnvelope(keys, "password-enc", envelope)).toStrictEqual(plaintext);
			expect(
				await decryptWithPurposeKey(keys, "password-enc", stored.keyVersion, stored.ciphertext),
			).toStrictEqual(plaintext);
		},
	);

	it("refuses to write a version the column could not hold", () => {
		expect(() =>
			rootKeyProvider({
				currentVersion: MAXIMUM_KEY_VERSION + 1,
				keysByVersion: { [MAXIMUM_KEY_VERSION + 1]: generateRootKey() },
			}),
		).toThrow(KeyError);
	});
});
