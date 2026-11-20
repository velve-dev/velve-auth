import type { EmailConfig } from "../auth/config.js";
import type { Actor } from "../db/actor.js";
import { actorOfDuePasskeyRecovery } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import {
	createWebAuthnCredentialRepository,
	DuplicateWebAuthnCredentialError,
} from "../factor/webauthn/credential-repository.js";
import type { RegisteredWebAuthnCredential } from "../factor/webauthn/service.js";
import { sendOrUndo } from "../flows/artefact.js";
import { type FlowEnvironment, mailerOf } from "../flows/environment.js";
import { ConcealedError } from "../http/error-map.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import type { SecurityStateRead } from "../security-state/read.js";
import { sealChange } from "../security-state/runtime.js";
import {
	componentsAfter,
	type GenerationMoves,
	SealingRefusedError,
} from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import { ONE_TIME_TOKEN_PURPOSES } from "../token/purpose.js";
import { createPasskeyRecoveryRepository, type MovedPasskey } from "./repository.js";

/** what an activation reaches: the services every flow takes and the mail it confirms with */
export interface PasskeyRecoveryActivation {
	readonly flow: FlowEnvironment;
	readonly email: EmailConfig;
}

//an activation ends every link and every pending authentication that went to the account before (E-3769)
export const EVERY_WAY_IN_THAT_WAS_MAILED_OR_PENDING: GenerationMoves = {
	retire: ONE_TIME_TOKEN_PURPOSES,
	retirePending: true,
};

function isActivatable(read: SecurityStateRead): boolean {
	return read.passkeyRecovery?.due === true && !read.disabled && !read.recoveryDisabled;
}

function isTheSealedPasskey(read: SecurityStateRead, moved: MovedPasskey): boolean {
	const sealed = read.passkeyRecovery;
	return (
		sealed !== null &&
		equalsInConstantTime(sealed.credentialId, moved.credentialId) &&
		equalsInConstantTime(sealed.publicKey, moved.publicKey)
	);
}

/** the components an account holds once a recovery replaced every way in with its one passkey */
export function componentsWithOnly(read: SecurityStateRead, passkey: MovedPasskey) {
	return componentsAfter(read, {
		password: null,
		passwordResetRequired: false,
		totp: null,
		passkeys: [passkey],
		identities: [],
		recoveryCodes: [],
		passkeyRecovery: null,
	});
}

//the revocations are announced before any row goes so a refusing hook leaves the account as it was (E-758)
export async function replaceEveryWayIn(
	activation: PasskeyRecoveryActivation,
	tx: Driver,
	actor: Actor,
	newPasskey: () => Promise<MovedPasskey>,
): Promise<MovedPasskey> {
	const { sessions, pluginRuntime, schema } = activation.flow.services;
	const sessionRows = sessionRowsOn(sessions, tx);
	if (pluginRuntime.listensTo("beforeSessionRevoke")) {
		await announceEachRevocation(
			pluginRuntime,
			{
				userId: actor,
				sessionIds: await sessionRows.listEverySessionIdOwnedBy({ actor }),
				reason: "passkey_recovery",
			},
			tx,
		);
	}
	await sessionRows.deleteEverySessionOwnedBy({ actor });
	await createPasskeyRecoveryRepository({ driver: tx, schema }).removeEverySignInMethod({ actor });
	return newPasskey();
}

//a passkey registered with no waiting period is written as an activated recovery would move it (E-3770)
export async function insertRecoveredPasskey(
	tx: Driver,
	schema: string,
	input: {
		readonly actor: Actor;
		readonly credential: RegisteredWebAuthnCredential;
		readonly label: string;
	},
): Promise<MovedPasskey> {
	const inserted = await createWebAuthnCredentialRepository({ driver: tx, schema })
		.insertCredential({ actor: input.actor, ...input.credential, label: input.label })
		.catch((cause: unknown) => {
			throw cause instanceof DuplicateWebAuthnCredentialError
				? new ConcealedError("passkey_recovery_registration_refused")
				: cause;
		});
	return {
		id: inserted.id,
		credentialId: input.credential.credentialId,
		publicKey: input.credential.publicKey,
		signCount: input.credential.signCount,
	};
}

//the address told is the one the activation read under the account lock (E-3771)
export async function confirmTheRecovery(
	activation: PasskeyRecoveryActivation,
	confirmed: { readonly userId: string; readonly address: string | null },
): Promise<void> {
	if (confirmed.address === null) {
		return;
	}
	await sendOrUndo(mailerOf(activation.flow, activation.email), null, {
		kind: "passkey_recovery_completed",
		to: confirmed.address,
		userId: confirmed.userId,
	});
}

//a due recovery is activated under the account lock and only once it is still due there (S-INTEG-12)
export async function activateDueRecovery(
	activation: PasskeyRecoveryActivation,
	actor: Actor,
	refusal: "broken_state_on_passkey_sign_in" | "broken_state_on_change",
): Promise<boolean> {
	const { securityState, schema } = activation.flow.services;
	const sealed = await sealChange(
		securityState,
		actor,
		{
			epoch: (read) => (isActivatable(read) ? "raise" : "keep"),
			moves: (read) => (isActivatable(read) ? EVERY_WAY_IN_THAT_WAS_MAILED_OR_PENDING : {}),
			write: async (tx, read) => {
				if (!isActivatable(read)) {
					return null;
				}
				return replaceEveryWayIn(activation, tx, actor, async () => {
					const moved = await createPasskeyRecoveryRepository({
						driver: tx,
						schema,
					}).moveHeldPasskeyIntoCredentials({ actor });
					if (moved === null || !isTheSealedPasskey(read, moved)) {
						throw new SealingRefusedError("seal_mismatch");
					}
					return moved;
				});
			},
			after: (read, moved) =>
				moved === null ? componentsAfter(read, {}) : componentsWithOnly(read, moved),
		},
		{ refusal },
	);
	if (sealed.written === null) {
		return false;
	}
	await confirmTheRecovery(activation, { userId: actor, address: sealed.read.email });
	return true;
}

//a broken state met while activating must answer as a rejected passkey (E-3768)
export async function activateDueRecoveryOfCredential(
	activation: PasskeyRecoveryActivation,
	credentialId: Uint8Array<ArrayBuffer>,
): Promise<void> {
	const { driver, schema } = activation.flow.services;
	const due = await createPasskeyRecoveryRepository({
		driver,
		schema,
	}).findDueRecoveryOfCredential({ credentialId });
	if (due === null) {
		return;
	}
	await activateDueRecovery(
		activation,
		actorOfDuePasskeyRecovery(due),
		"broken_state_on_passkey_sign_in",
	);
}
