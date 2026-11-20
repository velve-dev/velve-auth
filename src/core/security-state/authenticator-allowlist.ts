import { createUserRepository } from "../auth/user.js";
import { actorOfAuthenticatorAllowlist } from "../db/actor.js";
import { isRowIdentifier } from "../db/row-identifier.js";
import { VelveError } from "../http/error-map.js";
import { createPasskeyRecoveryRepository } from "../recovery/repository.js";
import { type SecurityStateRead, satisfiesTheAllowlist } from "./read.js";
import { type SecurityStateRuntime, sealChange } from "./runtime.js";
import { componentsAfter } from "./sealing.js";

const AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNNAMED_AAGUID = "00000000-0000-0000-0000-000000000000";

/** the list in the one spelling the seal covers, or null where the input is no list of named AAGUIDs */
export function normalisedAllowlistOf(aaguids: unknown): readonly string[] | null {
	if (!Array.isArray(aaguids) || aaguids.length === 0) {
		return null;
	}
	const spelled = aaguids.map((aaguid: unknown) =>
		typeof aaguid === "string" ? aaguid.toLowerCase() : "",
	);
	if (spelled.some((aaguid) => !AAGUID.test(aaguid) || aaguid === UNNAMED_AAGUID)) {
		return null;
	}
	return [...new Set(spelled)].sort();
}

//an account the list would leave without any way in is refused unless the caller asks for it (E-3850)
function refuseLeavingNoUsableSignInMethod(
	read: SecurityStateRead,
	allowlist: readonly string[],
): void {
	const usable =
		read.password !== null ||
		read.identities.length > 0 ||
		read.passkeys.some((passkey) => satisfiesTheAllowlist(allowlist, passkey.attestedAaguid));
	if (!usable) {
		throw new VelveError("last_sign_in_method");
	}
}

//setting or lifting the list is one sealed change and a held back passkey outside it is withdrawn with it (S-INTEG-13)
export async function setAuthenticatorAllowlist(
	runtime: SecurityStateRuntime,
	input: {
		readonly userId: string;
		readonly allowlist: readonly string[] | null;
		readonly allowNoUsableSignInMethod: boolean;
	},
): Promise<void> {
	if (!isRowIdentifier(input.userId)) {
		throw new VelveError("invalid_input");
	}
	const { allowlist } = input;
	const actor = actorOfAuthenticatorAllowlist(input.userId);
	await sealChange(
		runtime,
		actor,
		{
			//the list changes which passkey may sign in and leaves who is signed in as it was (E-3850)
			epoch: "keep",
			write: async (tx, read) => {
				if (allowlist !== null && !input.allowNoUsableSignInMethod) {
					refuseLeavingNoUsableSignInMethod(read, allowlist);
				}
				await createUserRepository({
					driver: tx,
					schema: runtime.schema,
				}).setAuthenticatorAllowlist({ actor, aaguids: allowlist });
				const held = read.passkeyRecovery;
				if (held === null || satisfiesTheAllowlist(allowlist, held.attestedAaguid)) {
					return false;
				}
				await createPasskeyRecoveryRepository({
					driver: tx,
					schema: runtime.schema,
				}).withdrawHeldPasskey({ actor });
				return true;
			},
			after: (read, withdrawn) =>
				componentsAfter(read, {
					authenticatorAllowlist: allowlist,
					...(withdrawn ? { passkeyRecovery: null } : {}),
				}),
		},
		{ accountMissing: () => new VelveError("invalid_input") },
	);
}
