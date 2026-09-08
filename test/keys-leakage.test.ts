import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { nobleAesGcm } from "../src/core/keys/aes-gcm.js";
import {
	decryptWithPurposeKey,
	encryptWithPurposeKey,
	KEY_PURPOSES,
	openEnvelope,
	rootKeyProvider,
	sealEnvelope,
} from "../src/core/keys/index.js";
import { MAXIMUM_KEY_VERSION } from "../src/core/keys/key-version.js";
import { randomBytes } from "../src/core/token/index.js";
import {
	asEncryptionPurpose,
	encodeBase64Url,
	generateRootKey,
	withLastBitFlipped,
} from "./keys-fixtures.js";

const NO_HEADER = new Uint8Array(0);

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Everything an operator or a log aggregator could ever see of a thrown value.
function everythingVisibleOf(thrown: unknown): string {
	const error = thrown as Error & Record<string, unknown>;

	return [
		String(thrown),
		error.message ?? "",
		error.stack ?? "",
		error.name ?? "",
		JSON.stringify(thrown),
		JSON.stringify(Object.getOwnPropertyNames(Object(thrown)).map((name) => error[name])),
		inspect(thrown, { depth: 8, showHidden: true }),
	].join("\n");
}

async function thrownBy(work: () => unknown | Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}

	return expect.fail("the operation succeeded where the test needs it to fail");
}

describe("no key material reaches an error (S-KEY-6, section 2.7)", () => {
	const rootKeyBytes = randomBytes(32);
	const rootKey = encodeBase64Url(rootKeyBytes);
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: rootKey } });

	async function forbiddenNeedles(): Promise<readonly string[]> {
		const derived = await Promise.all(
			KEY_PURPOSES.filter((purpose) => purpose.endsWith("-enc")).map(async (purpose) => {
				const { key } = await keys.current(purpose);
				return new Uint8Array(await crypto.subtle.exportKey("raw", key));
			}),
		);

		return [
			rootKey,
			hex(rootKeyBytes),
			rootKeyBytes.join(","),
			...derived.map(hex),
			...derived.map((bytes) => bytes.join(",")),
			...derived.map(encodeBase64Url),
		];
	}

	async function failingOperations(): Promise<readonly unknown[]> {
		const envelope = await sealEnvelope(keys, "totp-enc", randomBytes(32));
		const stored = await encryptWithPurposeKey(keys, "totp-enc", randomBytes(32));
		const signingKey = (await keys.current("cookie-sig")).key;

		return await Promise.all([
			thrownBy(() => rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: "!!!!" } })),
			thrownBy(() =>
				rootKeyProvider({
					currentVersion: 1,
					keysByVersion: { 1: encodeBase64Url(randomBytes(31)) },
				}),
			),
			thrownBy(() => rootKeyProvider({ currentVersion: 2, keysByVersion: { 1: rootKey } })),
			thrownBy(() =>
				rootKeyProvider({ currentVersion: 0, keysByVersion: { 0: encodeBase64Url(rootKeyBytes) } }),
			),
			thrownBy(() => openEnvelope(keys, "pkce-enc", envelope)),
			thrownBy(() => openEnvelope(keys, "totp-enc", withLastBitFlipped(envelope))),
			thrownBy(() => openEnvelope(keys, "totp-enc", new Uint8Array(3))),
			thrownBy(() => openEnvelope(keys, "totp-enc", envelope.subarray(0, 20))),
			thrownBy(() => sealEnvelope(keys, asEncryptionPurpose("cookie-sig"), randomBytes(16))),
			thrownBy(() =>
				decryptWithPurposeKey(keys, "totp-enc", MAXIMUM_KEY_VERSION, stored.ciphertext),
			),
			thrownBy(() => nobleAesGcm.encrypt(signingKey, randomBytes(12), NO_HEADER, randomBytes(16))),
			thrownBy(() => nobleAesGcm.decrypt(signingKey, randomBytes(12), NO_HEADER, randomBytes(32))),
		]);
	}

	it("keeps root and derived key material out of every failure path", async () => {
		const needles = await forbiddenNeedles();

		for (const thrown of await failingOperations()) {
			const visible = everythingVisibleOf(thrown);

			for (const needle of needles) {
				expect(visible).not.toContain(needle);
			}
		}
	});

	it("keeps every eight-byte run of the root key out of every failure path", async () => {
		const runs = Array.from({ length: rootKeyBytes.length - 8 }, (_unused, offset) =>
			hex(rootKeyBytes.subarray(offset, offset + 8)),
		);

		for (const thrown of await failingOperations()) {
			const visible = everythingVisibleOf(thrown);

			for (const run of runs) {
				expect(visible).not.toContain(run);
			}
		}
	});

	it("carries no payload beyond a code and a name on a KeyError", async () => {
		const thrown = await thrownBy(() =>
			rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: "!!!!" } }),
		);

		expect(Object.keys(thrown as object).sort()).toStrictEqual(["code", "name"]);
		expect(Object.getOwnPropertyNames(thrown as object).sort()).toStrictEqual([
			"code",
			"message",
			"name",
			"stack",
		]);
	});

	it("gives one fixed message per code, independent of the value that failed", async () => {
		const first = await thrownBy(() =>
			rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: "!!!!" } }),
		);
		const second = await thrownBy(() =>
			rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: "????????????????????????" } }),
		);

		expect((first as Error).message).toBe((second as Error).message);
	});
});

describe("no key material is committed to the tree", () => {
	it("draws a different root key on every call of the fixture", () => {
		const drawn = new Set(Array.from({ length: 32 }, () => generateRootKey()));
		expect(drawn.size).toBe(32);
	});

	it("makes the fixture key long enough to be accepted", () => {
		expect(() =>
			rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } }),
		).not.toThrow();
	});
});
