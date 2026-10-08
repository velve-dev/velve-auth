import type { Actor, ConsumedOAuthFlow } from "../db/actor.js";
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
	readonly expiresAtMicros: string;
}

//a link must replace the session it started in, which this row carries (S-FIX-1)
export interface OAuthLinkStart {
	readonly actor: Actor;
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
	/** the stored deadline as whole microseconds since the epoch, in decimal */
	readonly expiresAtMicros: string;
}

interface OAuthFlowRepository {
	//the verifier is bound to a deadline that exists before the insert (E-3128)
	deadlineOfANewFlow(): Promise<string>;
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
	readonly expires_at_micros: string;
}

//the brand is asserted where the row was removed and nowhere else
function linkTargetOf(userId: string | null): ConsumedOAuthFlow | null {
	return userId === null ? null : ({ userId: toEntityId<"user">(userId) } as ConsumedOAuthFlow);
}

//a deadline is carried as the decimal of its whole microseconds so no driver rounds it
function deadlineOf(value: unknown): string {
	if (typeof value === "string" && /^[0-9]+$/.test(value)) {
		return value;
	}
	throw new TypeError("a deadline must be read as the decimal of its microseconds");
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
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, timestamptz 'epoch' + $9::bigint * interval '1 microsecond')`;

	const deadlineStatement = `SELECT (extract(epoch FROM now() + make_interval(secs => $1::double precision)) * 1000000)::bigint::text AS expires_at_micros`;

	const consumeStatement = `DELETE FROM ${flows}
/* no owner predicate: S-CSRF-5, the row is reached by its state hash and the pointer cookie is
   what proves the caller may spend it */
WHERE state_sha256 = $1 AND expires_at > now()
RETURNING provider, pkce_verifier_enc, key_version, nonce, redirect_path, link_to_user_id,
	link_from_session_id, (extract(epoch FROM expires_at) * 1000000)::bigint::text AS expires_at_micros`;

	return {
		async deadlineOfANewFlow() {
			const [row] = await options.driver.query<{ expires_at_micros: unknown }>(deadlineStatement, [
				OAUTH_FLOW_LIFETIME_IN_SECONDS,
			]);
			return deadlineOf(row?.expires_at_micros);
		},

		async insertFlow(input) {
			await options.driver.query(insertStatement, [
				input.stateSha256,
				input.provider,
				input.pkceVerifierEnc,
				input.keyVersion,
				input.nonce,
				input.redirectPath,
				input.linkTo?.actor ?? null,
				input.linkTo?.sessionId ?? null,
				input.expiresAtMicros,
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
				expiresAtMicros: deadlineOf(row.expires_at_micros),
			};
		},
	};
}
