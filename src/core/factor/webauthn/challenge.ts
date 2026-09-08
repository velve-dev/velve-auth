import type { Driver } from "../../db/driver.js";
import { qualifiedTableName } from "../../db/identifier.js";
import { decodeBase64Url } from "../../keys/base64url.js";
import {
	createSecretToken,
	hashSecretToken,
	type SecretToken,
	toSecretToken,
} from "../../token/index.js";

export const WEBAUTHN_CHALLENGE_PURPOSES = ["register", "authenticate"] as const;

export type WebAuthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

// S-REPLAY-5, architecture 3.6: five minutes, and no configuration widens it.
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
}

/**
 * The token is the challenge: `challengeToken` is the base64url of the 32 random bytes the
 * authenticator signs, so the value the client returns and the value the ceremony was built
 * from are one string and cannot drift apart.
 */
function challengeBytesOf(challengeToken: SecretToken): Uint8Array<ArrayBuffer> {
	const bytes = decodeBase64Url(challengeToken);
	if (bytes === null) {
		throw new Error("a freshly minted secret token is not base64url");
	}
	return bytes;
}

export function createWebAuthnChallenges(
	options: WebAuthnChallengeRepositoryOptions,
): WebAuthnChallenges {
	const table = qualifiedTableName(options.schema, "webauthn_challenge");

	const issueStatement = `INSERT INTO ${table} (challenge_sha256, purpose, user_id, expires_at)
VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision))`;

	/* S-REPLAY-5: the delete is the check. Purpose and subject stand in the predicate, so a
	   challenge minted for one ceremony cannot be spent in another and none of the three
	   rejections leaves a row behind for a second attempt. */
	const consumeStatement = `DELETE FROM ${table}
WHERE challenge_sha256 = $1
  AND purpose = $2
  AND user_id IS NOT DISTINCT FROM $3::uuid
  AND expires_at > now()
RETURNING challenge_sha256`;

	return {
		async issue({ purpose, userId }) {
			// S-RAND-4: 32 bytes from the module every secret of the library is drawn in.
			const challengeToken = createSecretToken();
			await options.driver.query(issueStatement, [
				hashSecretToken(challengeToken),
				purpose,
				userId,
				WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
			]);
			return { challengeToken, challengeBytes: challengeBytesOf(challengeToken) };
		},

		async consume({ challengeToken, purpose, userId }) {
			/* Deliberately unchecked shape: a rejected spelling would be a second answer beside
			   "no row", and the three rejections S-REPLAY-5 names have to look alike. */
			const rows = await options.driver.query(consumeStatement, [
				hashSecretToken(toSecretToken(challengeToken)),
				purpose,
				userId,
			]);
			return rows.length === 1;
		},
	};
}
