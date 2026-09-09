import type { ConsumedOAuthFlow } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { toEntityId } from "../db/entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";

/** 3.10: the flow row is what secures the callback, and ten minutes is longer than any consent screen. */
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

/** 3.15 B.7 fixes the account server-side at the start; S-FIX-1 needs the row that will be replaced. */
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
	/** E-234's second provenance: the account a link flow names, proved by this row's removal. */
	readonly linkTo: ConsumedOAuthFlow | null;
	/** The session `identity.link.start` ran in, which is the row S-FIX-1 replaces (E-588). */
	readonly linkFromSessionId: string | null;
}

interface OAuthFlowRepository {
	insertFlow(input: OAuthFlowInsert): Promise<void>;
	/** S-REPLAY: the removal is the check, so a state cannot be spent twice. */
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

/** E-93: the brand is asserted where the row was removed, and in no other place. */
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
