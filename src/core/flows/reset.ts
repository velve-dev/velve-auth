import type { EmailConfig } from "../auth/config.js";
import { type Actor, actorOfConsumedRecoveryCode } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import { ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { toSecretToken } from "../token/secret-token.js";
import { mintAndMail, redeemOrRefuse } from "./artefact.js";
import {
	createPasswordProvenance,
	type DerivedPassword,
	derivePassword,
	writePassword,
} from "./credential.js";
import { accountOfRedemption, type FlowEnvironment, mailerOf, observedIn } from "./environment.js";
import type { SetPasswordResult } from "./results.js";

/** No account has this identifier, so the statements a resolved account runs are run for one that resolved to nobody (S-TIM-1's reasoning). */
const AN_ACCOUNT_THAT_CANNOT_EXIST = "00000000-0000-0000-0000-000000000000";

export async function requestReset(
	environment: FlowEnvironment,
	email: EmailConfig,
	context: RequestContext,
	input: { readonly email: string },
): Promise<void> {
	const normalised = normaliseEmail(input.email);
	const address = normalised.accepted ? normalised.value : "";
	await context.enforceAccountRateLimit(address);

	const owner = await environment.services.users.findUserByEmail(address);
	// S-TIM-6: the cover artefact of E-597 makes the unknown branch mint a row too, so both branches
	// run the same statements and call `send` exactly once.
	await mintAndMail(mailerOf(environment, email), {
		purpose: "password_reset",
		userId: owner === null ? null : owner.id,
		message: (issued) =>
			owner === null
				? { kind: "request_for_unknown_address", to: input.email, requested: "password_reset" }
				: {
						kind: "password_reset",
						to: address,
						userId: owner.id,
						token: issued.token,
						expiresAt: issued.expiresAt,
					},
	});
}

/**
 * S-FIX-6 and S-DEFAULT-2: the revocation and the new credential are one transaction, so a failure
 * between them leaves neither. The revocation is written first, so the one order a partial failure
 * can leave behind is the safe one — signed out everywhere with the old password still standing,
 * and the spent token forcing a fresh request (E-610).
 */
async function replacePassword(
	environment: FlowEnvironment,
	input: {
		readonly transaction: Driver;
		readonly actor: Actor;
		readonly userId: string;
		readonly derived: DerivedPassword;
	},
): Promise<number> {
	const { schema, keys } = environment.services;
	const revokedOtherSessionsCount = await createSessionRepository({
		driver: input.transaction,
		schema,
	}).deleteEverySessionOwnedBy({ actor: input.actor });
	await writePassword(
		{ driver: input.transaction, keys, schema },
		{ userId: input.userId, derived: input.derived },
	);
	return revokedOtherSessionsCount;
}

async function signInOnTheNewPassword(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly userId: string; readonly revokedOtherSessionsCount: number },
): Promise<SetPasswordResult> {
	const { driver, schema, sessions } = environment.services;
	const issued = await sessions.issue({
		userId: input.userId,
		factors: ["password"],
		observed: observedIn(context),
	});
	// L-12: the session this password was set in, so confirming the address from it keeps it.
	await createPasswordProvenance({ driver, schema }).recordSessionThatSetIt({
		userId: input.userId,
		sessionId: issued.session.id,
	});
	context.cookies.setSession(issued.token);
	return {
		sessionToken: issued.token,
		session: issued.session,
		revokedOtherSessionsCount: input.revokedOtherSessionsCount,
	};
}

export async function redeemReset(
	environment: FlowEnvironment,
	context: RequestContext,
	input: { readonly token: string; readonly newPassword: string },
): Promise<SetPasswordResult> {
	// The length policy and `validate` depend on the input alone, and the KDF is too long to hold a
	// transaction open for, so both run before the token is spent (3.3 step 1, S-DOS-2).
	const derived = await derivePassword(
		input.newPassword,
		environment.services.password,
		environment.semaphore,
	);
	const { driver, schema } = environment.services;

	const outcome = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, schema, {
			token: toSecretToken(input.token),
			purpose: "password_reset",
		});
		const account = await accountOfRedemption(environment, transaction, redeemed);
		return {
			userId: account.user.id,
			revokedOtherSessionsCount: await replacePassword(environment, {
				transaction,
				actor: account.actor,
				userId: account.user.id,
				derived,
			}),
		};
	});

	return signInOnTheNewPassword(environment, context, outcome);
}

/**
 * 3.4 and S-DEFAULT-4: the way back into an account that has no address. The code is consumed by
 * `DELETE … RETURNING` and none is generated in its place (3.15 B.4).
 */
export async function redeemResetWithRecoveryCode(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly identifier: string;
		readonly recoveryCode: string;
		readonly newPassword: string;
	},
): Promise<SetPasswordResult> {
	const derived = await derivePassword(
		input.newPassword,
		environment.services.password,
		environment.semaphore,
	);
	const { driver, schema, identity, keys } = environment.services;
	await context.enforceAccountRateLimit(input.identifier);

	const found = await findUserByIdentifier({
		driver,
		schema,
		configuration: identity,
		identifier: input.identifier,
	});
	const userId = found === null ? AN_ACCOUNT_THAT_CANNOT_EXIST : found.id;

	const codes = createRecoveryCodeRepository({ driver, schema });
	const versions = await codes.pepperVersionsOf({ userId });
	// An account with no codes still costs one HMAC, so the absent-account branch does the work the
	// present one does (S-TIM-1, L-1).
	const candidates =
		versions.length === 0
			? [(await pepperRecoveryCode(keys, input.recoveryCode)).codeHmac]
			: (
					await Promise.all(
						versions.map((version) => pepperRecoveryCodeUnder(keys, version, input.recoveryCode)),
					)
				)
					.filter((peppered) => peppered !== null)
					.map((peppered) => peppered.codeHmac);

	const outcome = await driver.transaction(async (transaction) => {
		const consumed = await createRecoveryCodeRepository({
			driver: transaction,
			schema,
		}).consumeCode({ userId, candidateHmacs: candidates });
		if (consumed === null || found === null) {
			throw new ConcealedError("recovery_code_not_found");
		}
		// L-4: a disabled account answers as a wrong code does, and the code is spent all the same.
		if (found.disabled) {
			throw new ConcealedError("recovery_code_not_found");
		}
		return {
			userId: found.id,
			revokedOtherSessionsCount: await replacePassword(environment, {
				transaction,
				actor: actorOfConsumedRecoveryCode(consumed),
				userId: found.id,
				derived,
			}),
		};
	});

	return signInOnTheNewPassword(environment, context, outcome);
}
