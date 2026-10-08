import type { Driver } from "../../db/driver.js";
import { qualifiedTableName } from "../../db/identifier.js";
import { decodeBase64Url } from "../../keys/base64url.js";
import type { KeyProvider } from "../../keys/provider.js";
import {
	bindToken,
	checkTokenBinding,
	reportRefusedTokenRow,
	type TokenBinding,
	type TokenBindingOccasion,
	type TokenBindingRefusalReport,
} from "../../token/binding.js";
import {
	createSecretToken,
	hashSecretToken,
	type SecretToken,
	toSecretToken,
} from "../../token/index.js";

export const WEBAUTHN_CHALLENGE_PURPOSES = ["register", "authenticate"] as const;

export type WebAuthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

//a challenge lives five minutes and no configuration widens it (S-REPLAY-5)
export const WEBAUTHN_CHALLENGE_LIFETIME_SECONDS = 5 * 60;

export interface IssuedWebAuthnChallenge {
	readonly challengeToken: SecretToken;
	readonly challengeBytes: Uint8Array<ArrayBuffer>;
}

export interface WebAuthnChallengeRequest {
	readonly purpose: WebAuthnChallengePurpose;
	readonly userId: string | null;
}

export interface WebAuthnChallengeConsumption {
	readonly purpose: WebAuthnChallengePurpose;
	readonly userId: string | null;
	readonly challengeToken: string;
}

export interface WebAuthnChallenges {
	issue(request: WebAuthnChallengeRequest): Promise<IssuedWebAuthnChallenge>;
	consume(attempt: WebAuthnChallengeConsumption): Promise<boolean>;
}

export interface WebAuthnChallengeRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

//the ceremony is bound so a challenge cannot be moved to the other purpose (S-INTEG-9)
function challengeBinding(
	challengeSha256: Uint8Array,
	purpose: WebAuthnChallengePurpose,
	userId: string | null,
): TokenBinding {
	return {
		purpose: "webauthn_challenge",
		ownerId: userId,
		tokenSha256: challengeSha256,
		content: { ceremony: purpose },
	};
}

//the token is the challenge so the returned value and the signed bytes cannot drift apart
function challengeBytesOf(challengeToken: SecretToken): Uint8Array<ArrayBuffer> {
	const bytes = decodeBase64Url(challengeToken);
	if (bytes === null) {
		throw new Error("a freshly minted secret token is not base64url");
	}
	return bytes;
}

interface ConsumedChallengeRow {
	readonly user_id: string | null;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
}

//a refused challenge is reported under the ceremony it was presented in (E-3482)
function occasionOfCeremony(
	purpose: WebAuthnChallengePurpose,
	userId: string | null,
): TokenBindingOccasion {
	if (purpose === "register") {
		return "change";
	}
	return userId === null ? "sign_in" : "factor_check";
}

export function createWebAuthnChallenges(
	options: WebAuthnChallengeRepositoryOptions,
): WebAuthnChallenges {
	const table = qualifiedTableName(options.schema, "webauthn_challenge");

	const issueStatement = `INSERT INTO ${table}
  (challenge_sha256, purpose, user_id, expires_at, token_mac, token_mac_key_version)
VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision), $5, $6)`;

	//a challenge minted for one ceremony cannot be spent in another (S-REPLAY-5)
	const consumeStatement = `DELETE FROM ${table}
WHERE challenge_sha256 = $1
  AND purpose = $2
  AND user_id IS NOT DISTINCT FROM $3::uuid
  AND expires_at > now()
RETURNING user_id, token_mac, token_mac_key_version`;

	return {
		async issue({ purpose, userId }) {
			//every secret is drawn from the one random module (S-RAND-4)
			const challengeToken = createSecretToken();
			const challengeSha256 = hashSecretToken(challengeToken);
			const mac = await bindToken(options.keys, challengeBinding(challengeSha256, purpose, userId));
			await options.driver.query(issueStatement, [
				challengeSha256,
				purpose,
				userId,
				WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
				mac.tokenMac,
				mac.tokenMacKeyVersion,
			]);
			return { challengeToken, challengeBytes: challengeBytesOf(challengeToken) };
		},

		async consume({ challengeToken, purpose, userId }) {
			//the shape is unchecked so every rejection looks like no row (S-REPLAY-5)
			const challengeSha256 = hashSecretToken(toSecretToken(challengeToken));
			//a consumption whose miss is read as an unknown challenge runs at read committed (E-3486)
			const [row] = await options.driver.transaction((tx) =>
				tx.query<ConsumedChallengeRow>(consumeStatement, [challengeSha256, purpose, userId]),
			);
			if (row === undefined) {
				return false;
			}
			const verdict = await checkTokenBinding(
				options.keys,
				challengeBinding(challengeSha256, purpose, row.user_id),
				{ tokenMac: row.token_mac, tokenMacKeyVersion: row.token_mac_key_version },
			);
			if (verdict !== "valid") {
				reportRefusedTokenRow(options.reportTokenBindingRefusal, {
					userId: row.user_id,
					occasion: occasionOfCeremony(purpose, userId),
					verdict,
				});
			}
			return verdict === "valid";
		},
	};
}
