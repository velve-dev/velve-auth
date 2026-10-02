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
}

//the token is the challenge so the returned value and the signed bytes cannot drift apart
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

	//a challenge minted for one ceremony cannot be spent in another (S-REPLAY-5)
	const consumeStatement = `DELETE FROM ${table}
WHERE challenge_sha256 = $1
  AND purpose = $2
  AND user_id IS NOT DISTINCT FROM $3::uuid
  AND expires_at > now()
RETURNING challenge_sha256`;

	return {
		async issue({ purpose, userId }) {
			//every secret is drawn from the one random module (S-RAND-4)
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
			//the shape is unchecked so every rejection looks like no row (S-REPLAY-5)
			const rows = await options.driver.query(consumeStatement, [
				hashSecretToken(toSecretToken(challengeToken)),
				purpose,
				userId,
			]);
			return rows.length === 1;
		},
	};
}
