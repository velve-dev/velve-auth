import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { macUnderCurrentKey } from "../src/core/keys/mac.js";
import { encodeSecurityState, type SecurityState } from "../src/core/security-state/encoding.js";
import { computeSeal, verifySeal } from "../src/core/security-state/seal.js";
import { generateRootKey, withLastBitFlipped } from "./keys-fixtures.js";

//the encoding of T-INTEG-2 is pinned byte for byte and the digest checked against a second implementation (E-3151)

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function filled(length: number, value: number): Uint8Array<ArrayBuffer> {
	return new Uint8Array(length).fill(value);
}

const EMPTY_STATE: SecurityState = {
	userId: USER_ID,
	version: 1,
	sessionEpoch: 1,
	email: null,
	emailVerified: false,
	disabled: false,
	password: null,
	passwordResetRequired: false,
	totp: null,
	passkeys: [],
	identities: [],
	recoveryCodes: [],
};

const FULL_STATE: SecurityState = {
	userId: USER_ID,
	version: 7,
	sessionEpoch: 4_503_599_627_370_497,
	email: "a@b.example",
	emailVerified: true,
	disabled: true,
	password: { phcSha256: filled(32, 0x11), keyVersion: 2, setBySessionId: SESSION_ID },
	passwordResetRequired: true,
	totp: { confirmed: true, secretSha256: filled(32, 0x22), keyVersion: 3 },
	passkeys: [
		{ credentialId: new Uint8Array([0xbb]), publicKey: new Uint8Array([0x01, 0x02]) },
		{ credentialId: new Uint8Array([0xaa]), publicKey: new Uint8Array([0x03]) },
	],
	identities: [{ provider: "github", subject: "42" }],
	recoveryCodes: [
		{ keyVersion: 1, codeHmac: new Uint8Array([0x09]) },
		{ keyVersion: 1, codeHmac: new Uint8Array([0x08]) },
	],
};

function text(value: string): string {
	return `01${value.length.toString(16).padStart(8, "0")}${hex(new TextEncoder().encode(value))}`;
}

const CONTEXT = text("velve-auth/security-state/v1");
const ACCOUNT = "0600000010" + "00000000000040008000000000000001";
const ABSENT = "0000000000";
const FALSE = "050000000100";
const TRUE = "050000000101";
const EMPTY_LIST = "0300000000";

function integer(value: bigint): string {
	return `0400000008${value.toString(16).padStart(16, "0")}`;
}

describe("the canonical encoding of a security state, byte for byte", () => {
	it("encodes an account with nothing but its id", () => {
		const expected =
			CONTEXT +
			ACCOUNT +
			integer(1n) +
			integer(1n) +
			ABSENT +
			FALSE +
			FALSE +
			ABSENT +
			FALSE +
			ABSENT +
			EMPTY_LIST +
			EMPTY_LIST +
			EMPTY_LIST;

		expect(hex(encodeSecurityState(EMPTY_STATE))).toBe(expected);
	});

	it("encodes every component, each list sorted by the encoding of its elements", () => {
		const password = `0700000047${"0200000020"}${"11".repeat(32)}${integer(2n)}${"0600000010"}0f0e0d0c0b0a49088706050403020100`;
		const totp = `0700000038${TRUE}${"0200000020"}${"22".repeat(32)}${integer(3n)}`;
		const passkeys =
			"0300000002" +
			`070000000c${"0200000001aa"}${"020000000103"}` +
			`070000000d${"0200000001bb"}${"02000000020102"}`;
		const identities = `0300000001${"0700000012"}${text("github")}${text("42")}`;
		const recoveryCodes =
			"0300000002" +
			`0700000013${integer(1n)}${"020000000108"}` +
			`0700000013${integer(1n)}${"020000000109"}`;
		const expected =
			CONTEXT +
			ACCOUNT +
			integer(7n) +
			integer(4_503_599_627_370_497n) +
			text("a@b.example") +
			TRUE +
			TRUE +
			password +
			TRUE +
			totp +
			passkeys +
			identities +
			recoveryCodes;

		expect(hex(encodeSecurityState(FULL_STATE))).toBe(expected);
	});

	it("does not depend on the order the rows arrive in", () => {
		const reordered: SecurityState = {
			...FULL_STATE,
			passkeys: [...FULL_STATE.passkeys].reverse(),
			recoveryCodes: [...FULL_STATE.recoveryCodes].reverse(),
		};

		expect(hex(encodeSecurityState(reordered))).toBe(hex(encodeSecurityState(FULL_STATE)));
	});

	it("encodes an identifier spelled in upper case as the same identifier", () => {
		const shouted = { ...FULL_STATE, userId: USER_ID.toUpperCase() };

		expect(hex(encodeSecurityState(shouted))).toBe(hex(encodeSecurityState(FULL_STATE)));
	});

	it("keeps a repeated row as two elements", () => {
		const repeated = {
			...FULL_STATE,
			recoveryCodes: [...FULL_STATE.recoveryCodes, ...FULL_STATE.recoveryCodes.slice(0, 1)],
		};

		expect(hex(encodeSecurityState(repeated))).not.toBe(hex(encodeSecurityState(FULL_STATE)));
	});

	it("refuses a value it cannot encode exactly instead of encoding something else", () => {
		expect(() => encodeSecurityState({ ...EMPTY_STATE, version: 2 ** 53 })).toThrow(RangeError);
		expect(() => encodeSecurityState({ ...EMPTY_STATE, sessionEpoch: 1.5 })).toThrow(RangeError);
		expect(() => encodeSecurityState({ ...EMPTY_STATE, userId: "not-a-uuid" })).toThrow(RangeError);
		expect(() =>
			encodeSecurityState({
				...EMPTY_STATE,
				password: { phcSha256: filled(31, 1), keyVersion: 1, setBySessionId: null },
			}),
		).toThrow(RangeError);
	});
});

describe("the seal digest under state-mac", () => {
	const rootKey = generateRootKey();
	const keys = rootKeyProvider({ currentVersion: 3, keysByVersion: { 3: rootKey } });

	it("is HMAC-SHA256 under the HKDF key of state-mac over the encoding, as a second implementation computes it", async () => {
		const stateMacKey = Buffer.from(
			hkdfSync(
				"sha256",
				Buffer.from(rootKey, "base64url"),
				"velve-auth/hkdf-sha256/v1",
				"velve-auth/key/state-mac",
				32,
			),
		);
		const expected = createHmac("sha256", stateMacKey)
			.update(encodeSecurityState(FULL_STATE))
			.digest("hex");

		const sealed = await computeSeal(keys, FULL_STATE);

		expect(sealed.keyVersion).toBe(3);
		expect(hex(sealed.digest)).toBe(expected);
	});

	it("verifies the state it was taken over", async () => {
		const sealed = await computeSeal(keys, FULL_STATE);

		expect(await verifySeal(keys, FULL_STATE, sealed)).toBe("valid");
	});

	it("names a changed state and a changed digest a seal mismatch", async () => {
		const sealed = await computeSeal(keys, FULL_STATE);

		expect(await verifySeal(keys, { ...FULL_STATE, version: 8 }, sealed)).toBe("seal_mismatch");
		expect(
			await verifySeal(keys, FULL_STATE, { ...sealed, digest: withLastBitFlipped(sealed.digest) }),
		).toBe("seal_mismatch");
	});

	it("names a version the ring does not hold, and does not read it as a mismatch", async () => {
		const sealed = await computeSeal(keys, FULL_STATE);

		expect(await verifySeal(keys, FULL_STATE, { ...sealed, keyVersion: 2 })).toBe(
			"key_version_unknown",
		);
	});

	it("names a key of the stored version that cannot take the MAC", async () => {
		const sealed = await computeSeal(keys, FULL_STATE);
		const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
		]);
		const wrongKind = {
			current: keys.current,
			byVersion: async () => aesKey,
		};

		expect(await verifySeal(wrongKind, FULL_STATE, sealed)).toBe("key_unusable");
	});

	it("is a MAC no other integrity purpose gives for the same encoding", async () => {
		const sealed = await computeSeal(keys, FULL_STATE);
		const underTokenMac = await macUnderCurrentKey(
			keys,
			"token-mac",
			encodeSecurityState(FULL_STATE),
		);

		expect(hex(underTokenMac.mac)).not.toBe(hex(sealed.digest));
		expect(await verifySeal(keys, FULL_STATE, { keyVersion: 3, digest: underTokenMac.mac })).toBe(
			"seal_mismatch",
		);
	});
});
