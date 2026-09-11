import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { lockAccountRow } from "../db/lock.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { ConcealedError } from "../http/error-map.js";
import { createPasswordProvenance } from "./credential.js";

interface ConfirmationOutcome {
	readonly wasTheFirstConfirmation: boolean;
	readonly passwordCredentialDeleted: boolean;
	readonly revokedSessionCount: number;
}

interface AddressConfirmation {
	readonly transaction: Driver;
	readonly schema: string;
	readonly actor: Actor;
	/** The session the confirming request arrived with, or `null` when it carried none (L-12). */
	readonly confirmingSessionId: string | null;
	/** The address the account moves to, or `null` when the account keeps the one it has. */
	readonly newEmail: string | null;
}

function markFirstConfirmationStatement(schema: string): string {
	/* One statement rather than a read and a write, so two redemptions arriving together cannot
	   both find the address unconfirmed and both run S-LINK-4's deletion. */
	return `UPDATE ${qualifiedTableName(schema, "user")}
/* no owner predicate: S-OWNER-2, velve.user is the owned row and id is its owner column */
SET email_verified_at = now(), updated_at = now()
WHERE id = $1 AND email_verified_at IS NULL
RETURNING id`;
}

function moveAddressStatement(schema: string): string {
	const users = qualifiedTableName(schema, "user");
	/* S-ENUM-5: the collision is a row count, not a raised unique violation, so a taken address
	   and an invented token leave the same trace — no rows changed — and answer alike. */
	return `UPDATE ${users} AS owned
/* no owner predicate: S-OWNER-2, velve.user is the owned row and id is its owner column */
SET email = $2, email_verified_at = now(), updated_at = now()
WHERE owned.id = $1
  AND NOT EXISTS (SELECT 1 FROM ${users} other WHERE other.email = $2 AND other.id <> owned.id)
RETURNING owned.id`;
}

/**
 * S-LINK-4 and L-12. A first confirmation of an address deletes a password credential that was set
 * in any other session and revokes every session of the account. The deletion is unconditional:
 * L-13's last-way-in count guards `factor.webauthn.remove` and `identity.unlink` and neither of
 * them is this, and a guard here would fail closed on exactly the pre-registered account
 * GHSA-qq9h-g4jm-xgf3 describes.
 */
export async function confirmAddress(input: AddressConfirmation): Promise<ConfirmationOutcome> {
	// CLAUDE.md §7: three user-owned tables are written below, so the account's row is taken first and
	// unconditionally — the statement after it takes the same mode but only where it matches a row,
	// and a password replacement beside this one has to be ordered against every path (E-1602).
	await lockAccountRow(input.transaction, input.schema, input.actor);
	const marked = await input.transaction.query(markFirstConfirmationStatement(input.schema), [
		input.actor,
	]);
	const wasTheFirstConfirmation = marked.length === 1;

	if (input.newEmail !== null) {
		const moved = await input.transaction.query(moveAddressStatement(input.schema), [
			input.actor,
			input.newEmail,
		]);
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

	/* Nothing was taken away from an account that had no password, so nothing is closed off either:
	   an account that reached its first confirmation without one has proved no less than before. */
	if (!passwordCredentialDeleted) {
		return { wasTheFirstConfirmation, passwordCredentialDeleted, revokedSessionCount: 0 };
	}

	const revokedSessionCount = await createSessionRepository({
		driver: input.transaction,
		schema: input.schema,
	}).deleteEverySessionOwnedBy({ actor: input.actor });

	return { wasTheFirstConfirmation, passwordCredentialDeleted, revokedSessionCount };
}
