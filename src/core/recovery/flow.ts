import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import {
	type Actor,
	actorOfConsumedRecoveryChallenge,
	actorOfRedeemedOneTimeToken,
} from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import {
	attestedAaguidOfRegistered,
	type RegisteredWebAuthnCredential,
	refuseAnAuthenticatorOutsideTheList,
	type WebAuthnRegistrationChallenge,
	type WebAuthnService,
} from "../factor/webauthn/service.js";
import {
	mintArtefact,
	movesOfSpentToken,
	ownerAMailedLinkMayReach,
	redeemOrRefuse,
	refuseATokenWrittenBack,
	refuseUnlessTheAddressIsStillTheAccounts,
	sendOrUndo,
	subjectOfAddress,
} from "../flows/artefact.js";
import { mailerOf } from "../flows/environment.js";
import { asAFailedRecoveryStep, ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import type { KeyProvider } from "../keys/provider.js";
import type { SecurityStateRead } from "../security-state/read.js";
import { checkAccount, recordSealLater, sealChange } from "../security-state/runtime.js";
import {
	componentsAfter,
	SealingRefusedError,
	type SealWritten,
} from "../security-state/sealing.js";
import {
	activateDueRecovery,
	componentsWithOnly,
	confirmTheRecovery,
	EVERY_WAY_IN_THAT_WAS_MAILED_OR_PENDING,
	insertRecoveredPasskey,
	type PasskeyRecoveryActivation,
	replaceEveryWayIn,
} from "./activation.js";
import { type PasskeyRecoveryConfig, waitingPeriodWithinBounds } from "./config.js";
import {
	createPasskeyRecoveryRepository,
	type HeldPasskey,
	type MovedPasskey,
} from "./repository.js";

/** what the recovery flows reach besides the activation: the one WebAuthn service and the waiting period */
export interface PasskeyRecoveryEnvironment extends PasskeyRecoveryActivation {
	readonly webauthn: WebAuthnService;
	readonly config: PasskeyRecoveryConfig;
}

/** what the registration that ends a recovery answers, with the activation time while the new passkey waits */
export type FinishPasskeyRecoveryResult =
	| { readonly status: "pending"; readonly activatesAt: Date }
	| { readonly status: "completed" };

/** a recovery to a new passkey that waits for its activation time, as a session of its account sees it */
export interface PendingPasskeyRecovery {
	readonly activatesAt: Date;
}

//an address without an account and an account that turned recovery off take one path (S-ENUM-10)
export async function requestPasskeyRecovery(
	environment: PasskeyRecoveryEnvironment,
	context: RequestContext,
	input: { readonly email: string },
): Promise<void> {
	const normalised = normaliseEmail(input.email);
	const address = normalised.accepted ? normalised.value : "";
	await context.enforceAccountRateLimit(address);

	const { services } = environment.flow;
	const owner = ownerAMailedLinkMayReach(await services.users.findUserByEmail(address));
	//the unknown branch must mint a row too and call send exactly once (E-597)
	const minted = await services.driver.transaction((transaction) =>
		mintArtefact(transaction, services, {
			purpose: "passkey_recovery",
			subject: subjectOfAddress(owner, address),
			accountEmail: owner?.email ?? address,
		}),
	);
	await sendOrUndo(
		mailerOf(environment.flow, environment.email),
		minted,
		owner === null
			? { kind: "request_for_unknown_address", to: input.email, requested: "passkey_recovery" }
			: {
					kind: "passkey_recovery",
					to: address,
					userId: owner.id,
					token: minted.token,
					expiresAt: minted.expiresAt,
				},
	);
}

//a step after the request names no factor it found wrong and only the log keeps which (S-ENUM-10)
async function answeredAsOneFailure<T>(step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (failure) {
		throw asAFailedRecoveryStep(failure);
	}
}

//an account with no codes must still cost one hmac (S-TIM-6)
async function candidateHmacsOf(
	keys: KeyProvider,
	versions: readonly number[],
	code: string,
): Promise<readonly Uint8Array<ArrayBuffer>[]> {
	if (versions.length === 0) {
		return [(await pepperRecoveryCode(keys, code)).codeHmac];
	}
	const peppered = await Promise.all(
		versions.map((version) => pepperRecoveryCodeUnder(keys, version, code)),
	);
	return peppered.filter((each) => each !== null).map((each) => each.codeHmac);
}

//a disabled, switched-off or already recovering account must cost what a wrong code costs (S-ENUM-10)
function refuseUnlessTheAccountMayBeRecovered(read: SecurityStateRead): void {
	if (read.disabled || read.recoveryDisabled || read.passkeyRecovery !== null) {
		throw new ConcealedError("passkey_recovery_refused_for_account");
	}
}

function withoutTheSpentCode(read: SecurityStateRead, spent: Uint8Array<ArrayBuffer>) {
	let removed = false;
	return read.recoveryCodes.filter((code) => {
		if (!removed && equalsInConstantTime(code.codeHmac, spent)) {
			removed = true;
			return false;
		}
		return true;
	});
}

//the code is consumed under the account lock and must be one of the codes the seal covers (S-RACE-7)
async function spendOneCodeOf(
	tx: Driver,
	schema: string,
	read: SecurityStateRead,
	candidates: readonly Uint8Array<ArrayBuffer>[],
): Promise<Uint8Array<ArrayBuffer>> {
	const spent = await createRecoveryCodeRepository({ driver: tx, schema }).consumeCode({
		userId: read.userId,
		candidateHmacs: candidates,
	});
	if (spent === null) {
		throw new ConcealedError("recovery_code_not_found");
	}
	if (!read.recoveryCodes.some((code) => equalsInConstantTime(code.codeHmac, spent.codeHmac))) {
		throw new SealingRefusedError("seal_mismatch");
	}
	return spent.codeHmac;
}

//the mailed link and one recovery code are spent together or neither is (S-RACE-7)
export function startPasskeyRecovery(
	environment: PasskeyRecoveryEnvironment,
	context: RequestContext,
	input: { readonly token: string; readonly recoveryCode: string },
): Promise<WebAuthnRegistrationChallenge> {
	return answeredAsOneFailure(async () => {
		//the account bucket counts the attempts made with one link, which names one account (E-3772)
		await context.enforceAccountRateLimit(input.token);
		const { services } = environment.flow;
		const { driver, schema, keys, securityState } = services;
		const started = await driver.transaction(async (transaction) => {
			const redeemed = await redeemOrRefuse(transaction, services, {
				token: input.token,
				purpose: "passkey_recovery",
			});
			const actor = actorOfRedeemedOneTimeToken(redeemed);
			const candidates = await candidateHmacsOf(
				keys,
				await createRecoveryCodeRepository({ driver: transaction, schema }).pepperVersionsOf({
					userId: redeemed.userId,
				}),
				input.recoveryCode,
			);
			return sealChange(
				securityState,
				actor,
				{
					epoch: "keep",
					moves: () => movesOfSpentToken(redeemed.spent),
					write: async (tx, read) => {
						refuseUnlessTheAddressIsStillTheAccounts(services, redeemed, read.email);
						refuseATokenWrittenBack(services, redeemed.userId, redeemed.spent, read);
						const spentCode = await spendOneCodeOf(tx, schema, read, candidates);
						refuseUnlessTheAccountMayBeRecovered(read);
						const challenge = await environment.webauthn.recovery.start({
							transaction: tx,
							actor,
							userName: read.email ?? actor,
							authenticatorAllowlist: read.authenticatorAllowlist,
						});
						return { spentCode, challenge };
					},
					after: (read, written) =>
						componentsAfter(read, { recoveryCodes: withoutTheSpentCode(read, written.spentCode) }),
				},
				{
					driver: transaction,
					refusal: "broken_state_on_passkey_recovery",
					occasion: "token_redemption",
				},
			);
		});
		recordSealLater(securityState, started, "token_redemption");
		return started.written.challenge;
	});
}

type RegistrationWritten =
	| { readonly kind: "replaced"; readonly moved: MovedPasskey }
	| { readonly kind: "held"; readonly held: HeldPasskey };

interface Registered {
	readonly address: string | null;
	readonly held: HeldPasskey | null;
	readonly sealed: SealWritten<RegistrationWritten>;
}

function waitingPeriodFor(environment: PasskeyRecoveryEnvironment, actor: Actor): number {
	return waitingPeriodWithinBounds(environment.config.waitingPeriodInSeconds({ userId: actor }));
}

//no passkey a recovery registers may sign in before the seal covers it (S-INTEG-12)
async function registerUnderTheSeal(
	environment: PasskeyRecoveryEnvironment,
	transaction: Driver,
	actor: Actor,
	input: {
		readonly credential: RegisteredWebAuthnCredential;
		readonly label: string;
		readonly waitingPeriodInSeconds: number;
	},
): Promise<Registered> {
	const { securityState, schema } = environment.flow.services;
	const immediate = input.waitingPeriodInSeconds === 0;
	const sealed = await sealChange(
		securityState,
		actor,
		{
			epoch: immediate ? "raise" : "keep",
			moves: () => (immediate ? EVERY_WAY_IN_THAT_WAS_MAILED_OR_PENDING : {}),
			write: async (tx, read): Promise<RegistrationWritten> => {
				refuseUnlessTheAccountMayBeRecovered(read);
				refuseAnAuthenticatorOutsideTheList(read, input.credential);
				if (immediate) {
					const moved = await replaceEveryWayIn(environment, tx, actor, () =>
						insertRecoveredPasskey(tx, schema, { actor, ...input }),
					);
					return { kind: "replaced", moved };
				}
				const held = await createPasskeyRecoveryRepository({ driver: tx, schema }).holdNewPasskey({
					actor,
					...input,
				});
				if (held === null) {
					throw new ConcealedError("passkey_recovery_registration_refused");
				}
				return { kind: "held", held };
			},
			after: (read, written) =>
				written.kind === "replaced"
					? componentsWithOnly(read, written.moved)
					: componentsAfter(read, {
							passkeyRecovery: {
								activatesAtMicros: written.held.activatesAtMicros,
								credentialId: input.credential.credentialId,
								publicKey: input.credential.publicKey,
								attestedAaguid: attestedAaguidOfRegistered(input.credential),
								due: false,
							},
						}),
		},
		{ driver: transaction, refusal: "broken_state_on_passkey_recovery" },
	);
	const { written } = sealed;
	return {
		address: sealed.read.email,
		held: written.kind === "held" ? written.held : null,
		sealed,
	};
}

//a refusing plugin must not keep the address from being told, and a failed notice fails the answer (E-3773)
async function tellOfThePendingRecovery(
	environment: PasskeyRecoveryEnvironment,
	actor: Actor,
	pending: { readonly address: string | null; readonly activatesAt: Date },
): Promise<void> {
	const address = pending.address;
	const unsent =
		address === null
			? null
			: await sendOrUndo(mailerOf(environment.flow, environment.email), null, {
					kind: "passkey_recovery_started",
					to: address,
					userId: actor,
					activatesAt: pending.activatesAt,
				}).then(
					() => null,
					(failure: unknown) => ({ failure }),
				);
	await environment.flow.services.pluginRuntime.hooks.afterPasskeyRecoveryStart({ userId: actor });
	if (unsent !== null) {
		throw unsent.failure;
	}
}

export async function finishPasskeyRecovery(
	environment: PasskeyRecoveryEnvironment,
	input: {
		readonly challengeToken: string;
		readonly response: RegistrationResponseJSON;
		readonly label: string;
	},
): Promise<FinishPasskeyRecoveryResult> {
	const { driver, securityState } = environment.flow.services;
	//a waiting period that throws must leave the challenge unspent (E-3782)
	const registered = await answeredAsOneFailure(() =>
		driver.transaction(async (transaction) => {
			const recovered = await environment.webauthn.recovery.finish({
				transaction,
				challengeToken: input.challengeToken,
				response: input.response,
			});
			const actor = actorOfConsumedRecoveryChallenge(recovered.owner);
			const waitingPeriodInSeconds = waitingPeriodFor(environment, actor);
			const outcome = await registerUnderTheSeal(environment, transaction, actor, {
				credential: recovered.credential,
				label: input.label,
				waitingPeriodInSeconds,
			});
			return { actor, ...outcome };
		}),
	);
	recordSealLater(securityState, registered.sealed, "change");
	if (registered.held === null) {
		await confirmTheRecovery(environment, {
			userId: registered.actor,
			address: registered.address,
		});
		return { status: "completed" };
	}
	await tellOfThePendingRecovery(environment, registered.actor, {
		address: registered.address,
		activatesAt: registered.held.activatesAt,
	});
	return { status: "pending", activatesAt: registered.held.activatesAt };
}

//a cancel that comes after the waiting period activates the recovery and is itself signed out by it (S-INTEG-12)
async function refuseOnceActivated(
	environment: PasskeyRecoveryEnvironment,
	actor: Actor,
): Promise<void> {
	if (await activateDueRecovery(environment, actor, "broken_state_on_change")) {
		throw new ConcealedError("session_not_found");
	}
}

//a reading route changes no row even once the recovery is due (S-CSRF-4)
export async function readPendingPasskeyRecovery(
	environment: PasskeyRecoveryEnvironment,
	actor: Actor,
): Promise<PendingPasskeyRecovery | null> {
	const check = await checkAccount(environment.flow.services.securityState, actor, "change");
	if (check.kind !== "usable") {
		throw new ConcealedError("broken_state_on_change");
	}
	const sealed = check.read.passkeyRecovery;
	if (sealed === null) {
		return null;
	}
	//the time is the driver's date of the row whose microseconds the verified read sealed (E-3775)
	const held = await createPasskeyRecoveryRepository({
		driver: environment.flow.services.driver,
		schema: environment.flow.services.schema,
	}).heldPasskeyOf({ actor });
	return held === null || held.activatesAtMicros !== sealed.activatesAtMicros
		? null
		: { activatesAt: held.activatesAt };
}

//cancelling voids the held back passkey and gives back no code and no link (S-INTEG-12)
export async function cancelPasskeyRecovery(
	environment: PasskeyRecoveryEnvironment,
	actor: Actor,
): Promise<void> {
	await refuseOnceActivated(environment, actor);
	const { securityState, schema, driver } = environment.flow.services;
	//every challenge row is ordered before the account row (E-3781)
	const sealed = await driver.transaction(async (transaction) => {
		await environment.webauthn.recovery.withdraw({ transaction, actor });
		return sealChange(
			securityState,
			actor,
			{
				epoch: "keep",
				write: async (tx, read) => {
					if (read.passkeyRecovery === null) {
						return;
					}
					const withdrawn = await createPasskeyRecoveryRepository({
						driver: tx,
						schema,
					}).withdrawHeldPasskey({ actor });
					if (withdrawn !== 1) {
						throw new SealingRefusedError("seal_mismatch");
					}
				},
				after: (read) => componentsAfter(read, { passkeyRecovery: null }),
			},
			{ driver: transaction },
		);
	});
	recordSealLater(securityState, sealed, "change");
}
