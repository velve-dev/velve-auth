import type { TokenBinding } from "../../token/binding.js";

//a writer who resets the attempt counter must be refused like a forged row (S-INTEG-9)
export function pendingBinding(
	userId: string,
	tokenHash: Uint8Array,
	factorsCompleted: readonly string[],
	counted: { readonly attempts: number; readonly sessionEpoch: number },
): TokenBinding {
	return {
		purpose: "pending_authentication",
		ownerId: userId,
		tokenSha256: tokenHash,
		content: {
			factors: factorsCompleted,
			attempts: counted.attempts,
			sessionEpoch: counted.sessionEpoch,
		},
	};
}
