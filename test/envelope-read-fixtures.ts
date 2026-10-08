import {
	type OpenTransaction,
	rebindEnvelopesOfAccount,
	type VerifiedEnvelopeRead,
} from "../src/core/auth/account-envelopes.js";
import {
	type SealingMode,
	sealRowPresenceOf,
	sealRowPresentFor,
} from "../src/core/auth/security-state.js";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRow } from "../src/core/db/lock.js";
import type { KeyProvider } from "../src/core/keys/provider.js";

interface StoredTokensAsJson {
	readonly id: string;
	readonly access: string | null;
	readonly refresh: string | null;
	readonly idToken: string | null;
	readonly keyVersion: number | null;
}

interface EnvelopeReadRow {
	readonly sealed: boolean;
	readonly phc: Uint8Array | null;
	readonly phc_key_version: number | null;
	readonly secret_enc: Uint8Array | null;
	readonly secret_key_version: number | null;
	readonly identities: unknown;
}

function bytesOfHex(hex: string | null): Uint8Array<ArrayBuffer> | null {
	return hex === null ? null : Uint8Array.from(Buffer.from(hex, "hex"));
}

function envelopeOf(bytes: Uint8Array | null, keyVersion: number | null) {
	return bytes === null || keyVersion === null
		? null
		: { ciphertext: Uint8Array.from(bytes), keyVersion };
}

//the seal row and every envelope come from one statement as the seal branch reads them (S-INTEG-3)
export async function verifiedEnvelopeReadOf(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<VerifiedEnvelopeRead> {
	const [row] = await driver.query<EnvelopeReadRow>(
		`SELECT ${sealRowPresentFor(schema, "$1::uuid")} AS sealed,
		        password.phc, password.key_version AS phc_key_version,
		        totp.secret_enc, totp.key_version AS secret_key_version,
		        COALESCE((
		          SELECT json_agg(json_build_object(
		            'id', identity.id,
		            'access', encode(identity.access_token_enc, 'hex'),
		            'refresh', encode(identity.refresh_token_enc, 'hex'),
		            'idToken', encode(identity.id_token_enc, 'hex'),
		            'keyVersion', identity.token_key_version) ORDER BY identity.id)
		          FROM ${schema}.identity identity WHERE identity.user_id = $1::uuid
		        ), '[]'::json) AS identities
		 FROM (SELECT 1) AS account
		 LEFT JOIN ${schema}.password_credential password ON password.user_id = $1::uuid
		 LEFT JOIN ${schema}.totp_credential totp ON totp.user_id = $1::uuid`,
		[userId],
	);
	const identities = (
		typeof row?.identities === "string" ? JSON.parse(row.identities) : row?.identities
	) as StoredTokensAsJson[];
	return {
		sealRow: sealRowPresenceOf(row?.sealed),
		password: envelopeOf(row?.phc ?? null, row?.phc_key_version ?? null),
		totpSecret: envelopeOf(row?.secret_enc ?? null, row?.secret_key_version ?? null),
		identities: identities.map((identity) => ({
			identityId: identity.id,
			accessTokenEnc: bytesOfHex(identity.access),
			refreshTokenEnc: bytesOfHex(identity.refresh),
			idTokenEnc: bytesOfHex(identity.idToken),
			tokenKeyVersion: identity.keyVersion,
		})),
	};
}

//the read follows the account lock in the transaction that rewrites, as a change of section 3.18 orders it (S-INTEG-3)
export async function rebindAfterOneRead(input: {
	readonly driver: OpenTransaction;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly actor: Actor;
	readonly sealing: SealingMode;
}): ReturnType<typeof rebindEnvelopesOfAccount> {
	await lockAccountRow(input.driver, input.schema, input.actor);
	const read = await verifiedEnvelopeReadOf(input.driver, input.schema, input.actor);
	return rebindEnvelopesOfAccount({ ...input, read });
}
