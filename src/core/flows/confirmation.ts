import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { SecondFactor } from "../factor/pending/repository.js";
import { ConcealedError } from "../http/error-map.js";
import type { PluginRuntime } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import type { SecurityStateRead } from "../security-state/read.js";
import {
	type SecurityStateRuntime,
	sealChange,
	secondFactorsOf,
} from "../security-state/runtime.js";
import { componentsAfter, type SealTarget, type SealWritten } from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import type { SessionService } from "../session/service.js";
import type { SpentToken } from "../token/one-time-token.js";
import { movesOfSpentToken, refuseATokenWrittenBack } from "./artefact.js";
import { createPasswordProvenance } from "./credential.js";
import type { ConfirmingSession } from "./environment.js";

interface ConfirmationWrite {
	readonly wasTheFirstConfirmation: boolean;
	readonly passwordCredentialDeleted: boolean;
	readonly revokedSessionCount: number;
}

interface ConfirmationOutcome extends ConfirmationWrite {
	/** the version and epoch the confirmation sealed, which a session it leads to is bound to */
	readonly sealed: SealTarget;
	/** the second factors the confirmation's verified read held */
	readonly secondFactors: readonly SecondFactor[];
	/** the seal written in the caller's transaction, which the caller records once that commits */
	readonly toRecord: SealWritten<unknown>;
}

interface AddressConfirmation {
	readonly transaction: Driver;
	readonly schema: string;
	readonly pluginRuntime: PluginRuntime;
	readonly sessions: SessionService;
	readonly actor: Actor;
	readonly confirmingSession: ConfirmingSession | null;
	readonly newEmail: string | null;
	readonly securityState: SecurityStateRuntime;
	/** the token whose redemption confirms the address, which moves the account's token generation */
	readonly spent: SpentToken;
}

function markFirstConfirmationStatement(schema: string): string {
	//two concurrent redemptions must not both find the address unconfirmed (S-LINK-4)
	return `UPDATE ${qualifiedTableName(schema, "user")}
/* no owner predicate: S-OWNER-2, velve.user is the owned row and id is its owner column */
SET email_verified_at = now(), updated_at = now()
WHERE id = $1 AND email_verified_at IS NULL
RETURNING id`;
}

function moveAddressStatement(schema: string): string {
	const users = qualifiedTableName(schema, "user");
	//a taken address must leave the same trace as an invented token (S-ENUM-5)
	return `UPDATE ${users} AS owned
/* no owner predicate: S-OWNER-2, velve.user is the owned row and id is its owner column */
SET email = $2, email_verified_at = now(), updated_at = now()
WHERE owned.id = $1
  AND NOT EXISTS (SELECT 1 FROM ${users} other WHERE other.email = $2 AND other.id <> owned.id)
RETURNING owned.id`;
}

const UNIQUE_VIOLATION = "23505";

//an address another change took after the check must answer as a taken one does (S-ENUM-5)
function refuseAnAddressTakenMeanwhile(cause: unknown): never {
	const fields = typeof cause === "object" && cause !== null ? cause : {};
	const { code, sqlState } = fields as { readonly code?: unknown; readonly sqlState?: unknown };
	if (code === UNIQUE_VIOLATION || sqlState === UNIQUE_VIOLATION) {
		throw new ConcealedError("email_taken_on_change");
	}
	throw cause;
}

//a session of another account counts as one the password was not set in (S-LINK-4)
function sessionIdOnTheAccount(session: ConfirmingSession | null, actor: Actor): string | null {
	return session !== null && session.userId === actor ? session.sessionId : null;
}

function passwordSetInTheConfirmingSession(
	read: SecurityStateRead,
	sessionId: string | null,
): boolean {
	return sessionId !== null && read.password?.setBySessionId === sessionId;
}

//the deletion is unconditional as a guard would spare a pre-registered account (S-LINK-4)
export async function confirmAddress(input: AddressConfirmation): Promise<ConfirmationOutcome> {
	const sessionId = sessionIdOnTheAccount(input.confirmingSession, input.actor);
	//the first confirmation that removes a password is a mass revocation and draws a new epoch (S-INTEG-3)
	const sealed = await sealChange(
		input.securityState,
		input.actor,
		{
			epoch: (read) =>
				!read.emailVerified &&
				read.password !== null &&
				!passwordSetInTheConfirmingSession(read, sessionId)
					? "raise"
					: "keep",
			moves: () => movesOfSpentToken(input.spent),
			write: (tx, read) => {
				refuseATokenWrittenBack(input.securityState, input.actor, input.spent, read);
				return confirmUnderTheLock({ ...input, transaction: tx }, sessionId);
			},
			after: (read, outcome) =>
				componentsAfter(read, {
					email: input.newEmail ?? read.email,
					emailVerified: true,
					password: outcome.passwordCredentialDeleted ? null : read.password,
				}),
		},
		{
			driver: input.transaction,
			refusal: "broken_state_on_token_redemption",
			occasion: "token_redemption",
		},
	);
	return {
		...sealed.written,
		sealed: { version: sealed.version, sessionEpoch: sealed.sessionEpoch, ...sealed.generations },
		secondFactors: secondFactorsOf(sealed.read),
		toRecord: sealed,
	};
}

async function confirmUnderTheLock(
	input: AddressConfirmation,
	sessionId: string | null,
): Promise<ConfirmationWrite> {
	const marked = await input.transaction.query(markFirstConfirmationStatement(input.schema), [
		input.actor,
	]);
	const wasTheFirstConfirmation = marked.length === 1;

	if (input.newEmail !== null) {
		const moved = await input.transaction
			.query(moveAddressStatement(input.schema), [input.actor, input.newEmail])
			.catch(refuseAnAddressTakenMeanwhile);
		if (moved.length !== 1) {
			throw new ConcealedError("email_taken_on_change");
		}
	}

	if (!wasTheFirstConfirmation) {
		return { wasTheFirstConfirmation, passwordCredentialDeleted: false, revokedSessionCount: 0 };
	}

	const passwordCredentialDeleted = await createPasswordProvenance({
		driver: input.transaction,
		schema: input.schema,
	}).deleteUnlessSetInSession({ actor: input.actor, sessionId });

	//an account that had no password loses nothing and keeps its sessions (E-608)
	if (!passwordCredentialDeleted) {
		return { wasTheFirstConfirmation, passwordCredentialDeleted, revokedSessionCount: 0 };
	}

	const sessionRows = sessionRowsOn(input.sessions, input.transaction);
	//a refusal must roll the redemption and the deleted password back with it (E-2730)
	if (input.pluginRuntime.listensTo("beforeSessionRevoke")) {
		await announceEachRevocation(
			input.pluginRuntime,
			{
				userId: input.actor,
				sessionIds: await sessionRows.listEverySessionIdOwnedBy({ actor: input.actor }),
				reason: "email_verified",
			},
			input.transaction,
		);
	}
	const revokedSessionCount = await sessionRows.deleteEverySessionOwnedBy({ actor: input.actor });

	return { wasTheFirstConfirmation, passwordCredentialDeleted, revokedSessionCount };
}
