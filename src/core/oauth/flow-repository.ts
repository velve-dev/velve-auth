import type { ConsumedOAuthFlow } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { toEntityId } from "../db/entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";

//ten minutes is longer than any consent screen
const OAUTH_FLOW_LIFETIME_IN_SECONDS = 600;

interface OAuthFlowInsert {
	readonly stateSha256: Uint8Array;
	readonly provider: string;
	readonly pkceVerifierEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly nonce: string | null;
	readonly redirectPath: string | null;
	readonly linkTo: OAuthLinkStart | null;
}

//a link must replace the session it started in, which this row carries (S-FIX-1)
export interface OAuthLinkStart {
	readonly userId: string;
	readonly sessionId: string;
}

export interface ConsumedOAuthFlowRow {
	readonly provider: string;
	readonly pkceVerifierEnc: Uint8Array<ArrayBuffer>;
	readonly keyVersion: number;
	readonly nonce: string | null;
	readonly redirectPath: string | null;
	//the account a link flow names is proved by the removal of this row (E-234)
	readonly linkTo: ConsumedOAuthFlow | null;
	//the link must replace the session it began in (E-588)
	readonly linkFromSessionId: string | null;
}

interface OAuthFlowRepository {
	insertFlow(input: OAuthFlowInsert): Promise<void>;
	//the removal is the check, so a state cannot be spent twice (S-REPLAY-6)
	consumeFlow(input: { readonly stateSha256: Uint8Array }): Promise<ConsumedOAuthFlowRow | null>;
}

interface FlowRow {
	readonly provider: string;
	readonly pkce_verifier_enc: Uint8Array;
	readonly key_version: number;
	readonly nonce: string | null;
	readonly redirect_path: string | null;
	readonly link_to_user_id: string | null;
	readonly link_from_session_id: string | null;
}

//the brand is asserted where the row was removed and nowhere else
function linkTargetOf(userId: string | null): ConsumedOAuthFlow | null {
	return userId === null ? null : ({ userId: toEntityId<"user">(userId) } as ConsumedOAuthFlow);
}

export function createOAuthFlowRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
}): OAuthFlowRepository {
	const schema = assertSchemaName(options.schema);
	const flows = qualifiedTableName(schema, "oauth_flow");

	const insertStatement = `INSERT INTO ${flows}
(state_sha256, provider, pkce_verifier_enc, key_version, nonce, redirect_path, link_to_user_id,
 link_from_session_id, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9::double precision))`;

	const consumeStatement = `DELETE FROM ${flows}
/* no owner predicate: S-CSRF-5, the row is reached by its state hash and the pointer cookie is
   what proves the caller may spend it */
WHERE state_sha256 = $1 AND expires_at > now()
RETURNING provider, pkce_verifier_enc, key_version, nonce, redirect_path, link_to_user_id,
	link_from_session_id`;

	return {
		async insertFlow(input) {
			await options.driver.query(insertStatement, [
				input.stateSha256,
				input.provider,
				input.pkceVerifierEnc,
				input.keyVersion,
				input.nonce,
				input.redirectPath,
				input.linkTo?.userId ?? null,
				input.linkTo?.sessionId ?? null,
				OAUTH_FLOW_LIFETIME_IN_SECONDS,
			]);
		},

		async consumeFlow({ stateSha256 }) {
			const [row] = await options.driver.query<FlowRow>(consumeStatement, [stateSha256]);
			if (row === undefined) {
				return null;
			}
			return {
				provider: row.provider,
				pkceVerifierEnc: Uint8Array.from(row.pkce_verifier_enc),
				keyVersion: row.key_version,
				nonce: row.nonce,
				redirectPath: row.redirect_path,
				linkTo: linkTargetOf(row.link_to_user_id),
				linkFromSessionId: row.link_from_session_id,
			};
		},
	};
}
