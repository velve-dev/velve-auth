import { createUserRepository } from "../auth/user.js";
import { actorOfRecoverySwitch } from "../db/actor.js";
import { isRowIdentifier } from "../db/row-identifier.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import { VelveError } from "../http/error-map.js";
import { createPasskeyRecoveryRepository } from "../recovery/repository.js";
import { LINKS_INTO_THE_ACCOUNT } from "./read.js";
import { type SecurityStateRuntime, sealChange } from "./runtime.js";
import { componentsAfter } from "./sealing.js";

//turning recovery off deletes the codes and retires every mailed link in the one sealing transaction (S-INTEG-11)
export async function setRecoveryDisabled(
	runtime: SecurityStateRuntime,
	input: { readonly userId: string; readonly disabled: boolean },
): Promise<void> {
	if (!isRowIdentifier(input.userId)) {
		throw new VelveError("invalid_input");
	}
	const actor = actorOfRecoverySwitch(input.userId);
	await sealChange(
		runtime,
		actor,
		{
			//the switch removes ways back in and leaves who is signed in as it was (E-3735)
			epoch: "keep",
			//a link or held back reset from either side of the switch never outlives a change of it (E-3747)
			moves: () =>
				input.disabled
					? { retire: LINKS_INTO_THE_ACCOUNT, retirePending: true }
					: { retire: LINKS_INTO_THE_ACCOUNT },
			write: async (tx) => {
				await createUserRepository({ driver: tx, schema: runtime.schema }).setRecoveryDisabledAt({
					actor,
					disabled: input.disabled,
				});
				if (input.disabled) {
					await createRecoveryCodeRepository({
						driver: tx,
						schema: runtime.schema,
					}).deleteEveryCode({ actor });
					//a recovery still waiting when the switch goes on is cancelled with it (E-3774)
					await createPasskeyRecoveryRepository({
						driver: tx,
						schema: runtime.schema,
					}).withdrawHeldPasskey({ actor });
				}
			},
			after: (read) =>
				componentsAfter(
					read,
					input.disabled
						? { recoveryDisabled: true, recoveryCodes: [], passkeyRecovery: null }
						: { recoveryDisabled: false },
				),
		},
		{ accountMissing: () => new VelveError("invalid_input") },
	);
}
