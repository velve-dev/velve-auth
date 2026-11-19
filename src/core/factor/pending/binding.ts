import { sha256 } from "@noble/hashes/sha2.js";
import type { EnvelopeBinding } from "../../keys/envelope-binding.js";
import type { TokenBinding } from "../../token/binding.js";

//the row is the token hash so the envelope opens in no other pending row and in no credential (S-INTEG-1)
export function newPasswordBindingOf(userId: string, tokenHash: Uint8Array): EnvelopeBinding {
	return { column: "pending_authentication.new_password_phc", owner: userId, row: tokenHash };
}

/** the sealed new password a pending row stores, as its two columns hold it */
export interface StoredNewPassword {
	readonly ciphertext: Uint8Array;
	readonly keyVersion: number;
}

/** the new password the two columns hold, none where both are null, malformed where only one is */
export function newPasswordOfColumns(
	ciphertext: Uint8Array | null | undefined,
	keyVersion: number | null | undefined,
): StoredNewPassword | null | "malformed" {
	const sealed = ciphertext ?? null;
	const version = keyVersion ?? null;
	if (sealed === null && version === null) {
		return null;
	}
	return sealed === null || version === null
		? "malformed"
		: { ciphertext: sealed, keyVersion: version };
}

//a writer who resets the attempt counter or writes back an older row must be refused like a forged row (S-INTEG-9)
export function pendingBinding(
	userId: string,
	tokenHash: Uint8Array,
	factorsCompleted: readonly string[],
	counted: {
		readonly attempts: number;
		readonly sessionEpoch: number;
		readonly attemptGeneration: number;
	},
	newPassword: StoredNewPassword | null = null,
): TokenBinding {
	return {
		purpose: "pending_authentication",
		ownerId: userId,
		tokenSha256: tokenHash,
		content: {
			factors: factorsCompleted,
			attempts: counted.attempts,
			sessionEpoch: counted.sessionEpoch,
			attemptGeneration: counted.attemptGeneration,
			//a writer who empties or swaps the held back new password is refused like a forged row (S-FIX-7)
			newPassword:
				newPassword === null
					? null
					: {
							ciphertextSha256: sha256(new Uint8Array(newPassword.ciphertext)),
							keyVersion: newPassword.keyVersion,
						},
		},
	};
}
