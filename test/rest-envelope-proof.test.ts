import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EncryptionKeyPurpose } from "../src/core/keys/purpose.js";
import { type DrivenUser, driveOneUserThroughEveryFlow } from "./rest-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

let driven: DrivenUser;

beforeAll(async () => {
	driven = await driveOneUserThroughEveryFlow("restenvelope");
}, 60_000);

afterAll(async () => {
	await driven.close();
});

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "A256GCM";

//the stored form is a nonce then ciphertext and tag sealed with the algorithm and version header as additional data (E-65)
function additionalDataFor(keyVersion: number): Uint8Array<ArrayBuffer> {
	const header = new Uint8Array(1 + ALGORITHM.length + 4);
	header[0] = ALGORITHM.length;
	header.set(Buffer.from(ALGORITHM, "ascii"), 1);
	new DataView(header.buffer).setInt32(1 + ALGORITHM.length, keyVersion);
	return header;
}

async function opened(
	purpose: EncryptionKeyPurpose,
	keyVersion: number,
	stored: Uint8Array,
): Promise<Buffer> {
	const key = await driven.keys.byVersion(purpose, keyVersion);
	if (key === null) {
		throw new Error(`no ${purpose} key of version ${keyVersion}`);
	}
	const bytes = new Uint8Array(stored);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bytes.subarray(0, NONCE_BYTES),
			additionalData: additionalDataFor(keyVersion),
		},
		key,
		bytes.subarray(NONCE_BYTES),
	);
	return Buffer.from(plaintext);
}

interface EncryptedColumn {
	readonly name: string;
	readonly purpose: EncryptionKeyPurpose;
	readonly wrongPurpose: EncryptionKeyPurpose;
	readonly select: (schema: string) => string;
	readonly input: () => Buffer;
}

function sha256Base64Url(value: Buffer): string {
	return createHash("sha256").update(value).digest("base64url");
}

const COLUMNS: readonly EncryptedColumn[] = [
	{
		name: "totp_credential.secret_enc",
		purpose: "totp-enc",
		wrongPurpose: "pkce-enc",
		select: (schema) => `SELECT secret_enc AS stored, key_version FROM ${schema}.totp_credential`,
		input: () => Buffer.from(secretBytesOfBase32(driven.totpSecretBase32)),
	},
	{
		name: "oauth_flow.pkce_verifier_enc",
		purpose: "pkce-enc",
		wrongPurpose: "oauth-token-enc",
		select: (schema) => `SELECT pkce_verifier_enc AS stored, key_version FROM ${schema}.oauth_flow`,
		input: () => Buffer.from(driven.secrets.find((s) => s.name === "PKCE verifier")?.value ?? ""),
	},
	{
		name: "identity.access_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "totp-enc",
		select: (schema) =>
			`SELECT access_token_enc AS stored, token_key_version AS key_version FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.accessToken),
	},
	{
		name: "identity.refresh_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "password-enc",
		select: (schema) =>
			`SELECT refresh_token_enc AS stored, token_key_version AS key_version FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.refreshToken),
	},
	{
		name: "identity.id_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "pkce-enc",
		select: (schema) =>
			`SELECT id_token_enc AS stored, token_key_version AS key_version FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.idToken),
	},
];

async function storedOf(
	column: EncryptedColumn,
): Promise<{ stored: Uint8Array; keyVersion: number }> {
	const rows = await driven.mounted.connection.query<{ stored: Uint8Array; key_version: number }>(
		column.select(driven.mounted.schema),
		[],
	);
	const [row] = rows;
	if (rows.length !== 1 || row === undefined || row.stored === null) {
		throw new Error(`${column.name} holds ${rows.length} rows rather than one written value`);
	}
	return { stored: row.stored, keyVersion: row.key_version };
}

const cases = COLUMNS.map((column) => [column.name, column] as const);

describe("T-REST-4: what the server needs back lies AES-256-GCM encrypted (S-REST-4)", () => {
	it.each(cases)("opens %s with its purpose key to exactly the input", async (_name, column) => {
		const { stored, keyVersion } = await storedOf(column);
		const input = column.input();

		expect(input.length).toBeGreaterThan(0);
		expect(stored.length).toBe(NONCE_BYTES + input.length + TAG_BYTES);
		expect(await opened(column.purpose, keyVersion, stored)).toStrictEqual(input);
	});

	it.each(cases)("refuses %s under another purpose's key", async (_name, column) => {
		const { stored, keyVersion } = await storedOf(column);

		await expect(opened(column.wrongPurpose, keyVersion, stored)).rejects.toThrow();
	});

	it.each(cases)("does not hold the input of %s as a subsequence", async (_name, column) => {
		const { stored } = await storedOf(column);

		expect(Buffer.from(stored).indexOf(column.input())).toBe(-1);
	});

	//the verifier the test never sees is held against the challenge the provider saw
	it("decrypts the PKCE verifier the authorization request committed to", async () => {
		const pkce = COLUMNS.find((column) => column.purpose === "pkce-enc");
		const { stored, keyVersion } = await storedOf(pkce as EncryptedColumn);
		const verifier = await opened("pkce-enc", keyVersion, stored);

		expect(driven.openFlow.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sha256Base64Url(verifier)).toBe(driven.openFlow.codeChallenge);
	});
});
