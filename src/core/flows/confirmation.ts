import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { lockAccountRow } from "../db/lock.js";
import { ConcealedError } from "../http/error-map.js";
import type { PluginRuntime } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import type { SessionService } from "../session/service.js";
import { createPasswordProvenance } from "./credential.js";

interface ConfirmationOutcome {
	readonly wasTheFirstConfirmation: boolean;
	readonly passwordCredentialDeleted: boolean;
	readonly revokedSessionCount: number;
}

interface AddressConfirmation {
	readonly transaction: Driver;
	readonly schema: string;
	readonly pluginRuntime: PluginRuntime;
	readonly sessions: SessionService;
	readonly actor: Actor;
	readonly confirmingSessionId: string | null;
	readonly newEmail: string | null;
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

//the deletion is unconditional as a guard would spare a pre-registered account (S-LINK-4)
export async function confirmAddress(input: AddressConfirmation): Promise<ConfirmationOutcome> {
	//the account row is locked first to order this against a password replacement (E-1602)
	await lockAccountRow(input.transaction, input.schema, input.actor);
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
	}).deleteUnlessSetInSession({ actor: input.actor, sessionId: input.confirmingSessionId });

	//an account that had no password loses nothing and keeps its sessions (E-608)
	if (!passwordCredentialDeleted) {
		return { wasTheFirstConfirmation, passwordCredentialDeleted, revokedSessionCount: 0 };
	}

	const sessionRows = input.sessions.repositoryOn(input.transaction);
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
