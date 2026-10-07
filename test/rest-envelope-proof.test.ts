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

const BOUND_FORM = 0x02;

/** the row a ciphertext is bound to, read from the row itself */
interface StoredBinding {
	readonly column: string;
	readonly owner: string | null;
	readonly row: string | Uint8Array;
}

function field(type: number, bytes: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([Buffer.from([type]), length, Buffer.from(bytes)]);
}

function uuidField(uuid: string): Buffer {
	return field(0x02, Buffer.from(uuid.replaceAll("-", ""), "hex"));
}

//the row of a flow is its state hash and the columns that steer it, each a typed field (E-3123)
function flowRowOf(parts: readonly (Uint8Array | string | null)[]): Uint8Array {
	return Buffer.concat(
		parts.map((part) =>
			part === null
				? field(0x00, new Uint8Array(0))
				: typeof part === "string"
					? field(0x01, Buffer.from(part, "utf8"))
					: field(0x03, part),
		),
	);
}

//written here from the reference rather than imported so the format is checked and not restated (S-INTEG-1)
function additionalDataFor(binding: StoredBinding, keyVersion: number): Uint8Array<ArrayBuffer> {
	const version = Buffer.alloc(4);
	version.writeInt32BE(keyVersion);
	return new Uint8Array(
		Buffer.concat([
			field(0x01, Buffer.from("velve-auth/envelope/v2", "utf8")),
			field(0x01, Buffer.from(ALGORITHM, "ascii")),
			field(0x04, version),
			field(0x01, Buffer.from(binding.column, "utf8")),
			binding.owner === null ? field(0x00, new Uint8Array(0)) : uuidField(binding.owner),
			typeof binding.row === "string" ? uuidField(binding.row) : field(0x03, binding.row),
		]),
	);
}

async function opened(
	purpose: EncryptionKeyPurpose,
	keyVersion: number,
	stored: Uint8Array,
	binding: StoredBinding,
): Promise<Buffer> {
	const key = await driven.keys.byVersion(purpose, keyVersion);
	if (key === null) {
		throw new Error(`no ${purpose} key of version ${keyVersion}`);
	}
	const bytes = new Uint8Array(stored);
	if (bytes[0] !== BOUND_FORM) {
		throw new Error("the stored value is not in the bound form");
	}
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bytes.subarray(1, 1 + NONCE_BYTES),
			additionalData: additionalDataFor(binding, keyVersion),
		},
		key,
		bytes.subarray(1 + NONCE_BYTES),
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
		select: (schema) =>
			`SELECT secret_enc AS stored, key_version, user_id AS owner, user_id::text AS row_uuid, NULL::bytea AS row_bytes FROM ${schema}.totp_credential`,
		input: () => Buffer.from(secretBytesOfBase32(driven.totpSecretBase32)),
	},
	{
		name: "oauth_flow.pkce_verifier_enc",
		purpose: "pkce-enc",
		wrongPurpose: "oauth-token-enc",
		select: (schema) =>
			`SELECT pkce_verifier_enc AS stored, key_version, link_to_user_id AS owner, NULL::text AS row_uuid,
			  state_sha256 AS row_bytes, provider, nonce, redirect_path, link_from_session_id::text
			  FROM ${schema}.oauth_flow`,
		input: () => Buffer.from(driven.secrets.find((s) => s.name === "PKCE verifier")?.value ?? ""),
	},
	{
		name: "identity.access_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "totp-enc",
		select: (schema) =>
			`SELECT access_token_enc AS stored, token_key_version AS key_version, user_id AS owner, id::text AS row_uuid, NULL::bytea AS row_bytes FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.accessToken),
	},
	{
		name: "identity.refresh_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "password-enc",
		select: (schema) =>
			`SELECT refresh_token_enc AS stored, token_key_version AS key_version, user_id AS owner, id::text AS row_uuid, NULL::bytea AS row_bytes FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.refreshToken),
	},
	{
		name: "identity.id_token_enc",
		purpose: "oauth-token-enc",
		wrongPurpose: "pkce-enc",
		select: (schema) =>
			`SELECT id_token_enc AS stored, token_key_version AS key_version, user_id AS owner, id::text AS row_uuid, NULL::bytea AS row_bytes FROM ${schema}.identity`,
		input: () => Buffer.from(driven.providerTokens.idToken),
	},
];

interface StoredValue {
	readonly stored: Uint8Array;
	readonly keyVersion: number;
	readonly binding: StoredBinding;
}

async function storedOf(column: EncryptedColumn): Promise<StoredValue> {
	const rows = await driven.mounted.connection.query<{
		stored: Uint8Array;
		key_version: number;
		owner: string | null;
		row_uuid: string | null;
		row_bytes: Uint8Array | null;
		provider?: string;
		nonce?: string | null;
		redirect_path?: string | null;
		link_from_session_id?: string | null;
	}>(column.select(driven.mounted.schema), []);
	const [row] = rows;
	if (rows.length !== 1 || row === undefined || row.stored === null) {
		throw new Error(`${column.name} holds ${rows.length} rows rather than one written value`);
	}
	return {
		stored: row.stored,
		keyVersion: row.key_version,
		binding: {
			column: column.name,
			owner: row.owner,
			row:
				row.row_uuid ??
				flowRowOf([
					new Uint8Array(row.row_bytes ?? new Uint8Array(0)),
					row.provider ?? null,
					row.nonce ?? null,
					row.redirect_path ?? null,
					row.link_from_session_id ?? null,
				]),
		},
	};
}

const cases = COLUMNS.map((column) => [column.name, column] as const);

describe("T-REST-4: what the server needs back lies AES-256-GCM encrypted (S-REST-4)", () => {
	it.each(cases)("opens %s with its purpose key to exactly the input", async (_name, column) => {
		const { stored, keyVersion, binding } = await storedOf(column);
		const input = column.input();

		expect(input.length).toBeGreaterThan(0);
		expect(stored.length).toBe(1 + NONCE_BYTES + input.length + TAG_BYTES);
		expect(await opened(column.purpose, keyVersion, stored, binding)).toStrictEqual(input);
	});

	it.each(cases)("refuses %s under another purpose's key", async (_name, column) => {
		const { stored, keyVersion, binding } = await storedOf(column);

		await expect(opened(column.wrongPurpose, keyVersion, stored, binding)).rejects.toThrow();
	});

	it.each(cases)("does not hold the input of %s as a subsequence", async (_name, column) => {
		const { stored } = await storedOf(column);

		expect(Buffer.from(stored).indexOf(column.input())).toBe(-1);
	});

	//the verifier the test never sees is held against the challenge the provider saw
	it("decrypts the PKCE verifier the authorization request committed to", async () => {
		const pkce = COLUMNS.find((column) => column.purpose === "pkce-enc");
		const { stored, keyVersion, binding } = await storedOf(pkce as EncryptedColumn);
		const verifier = await opened("pkce-enc", keyVersion, stored, binding);

		expect(driven.openFlow.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(sha256Base64Url(verifier)).toBe(driven.openFlow.codeChallenge);
	});
});
