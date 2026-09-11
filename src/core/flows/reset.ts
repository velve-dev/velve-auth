import type { EmailConfig } from "../auth/config.js";
import { type Actor, actorOfConsumedRecoveryCode } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import { ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { normaliseEmail } from "../identity/normalise.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo, subjectOfAddress } from "./artefact.js";
import { type DerivedPassword, derivePassword, writePassword } from "./credential.js";
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
	const { driver, schema } = environment.services;
	// S-TIM-6: the cover artefact of E-597 makes the unknown branch mint a row too, so both branches
	// run the same statements and call `send` exactly once.
	const minted = await driver.transaction((transaction) =>
		mintArtefact(transaction, schema, {
			purpose: "password_reset",
			subject: subjectOfAddress(owner, address),
		}),
	);
	await sendOrUndo(
		mailerOf(environment, email),
		minted,
		owner === null
			? { kind: "request_for_unknown_address", to: input.email, requested: "password_reset" }
			: {
					kind: "password_reset",
					to: address,
					userId: owner.id,
					token: minted.token,
					expiresAt: minted.expiresAt,
				},
	);
}

/**
 * S-FIX-6 and S-DEFAULT-2: the revocation, the new session and the new credential are one
 * transaction, so a failure among them leaves none of the three. The revocation is written first, so
 * the one order a partial failure can leave behind is the safe one — signed out everywhere with the
 * old password still standing, and the spent token forcing a fresh request (E-610).
 */
async function replacePassword(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly transaction: Driver;
		readonly actor: Actor;
		readonly userId: string;
		readonly derived: DerivedPassword;
	},
): Promise<SetPasswordResult> {
	const { schema, keys, sessions } = environment.services;
	// CLAUDE.md §7: the session table and the credential table are both written below, and a first
	// address confirmation writes the same two in the other order (E-1602).
	await lockAccountRow(input.transaction, schema, input.userId);
	const revokedOtherSessionsCount = await createSessionRepository({
		driver: input.transaction,
		schema,
	}).deleteEverySessionOwnedBy({ actor: input.actor });
	const issued = await sessions.boundTo(input.transaction).issue({
		userId: input.userId,
		factors: ["password"],
		observed: observedIn(context),
	});
	// L-12: the session this password was stored by, written with it in one statement (E-626).
	await writePassword(
		{ driver: input.transaction, keys, schema },
		{ userId: input.userId, derived: input.derived, setBySessionId: issued.session.id },
	);
	return {
		sessionToken: issued.token,
		session: issued.session,
		revokedOtherSessionsCount,
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

	const result = await driver.transaction(async (transaction) => {
		const redeemed = await redeemOrRefuse(transaction, schema, {
			token: input.token,
			purpose: "password_reset",
		});
		const account = await accountOfRedemption(environment, transaction, redeemed);
		return replacePassword(environment, context, {
			transaction,
			actor: account.actor,
			userId: account.user.id,
			derived,
		});
	});

	context.cookies.setSession(result.sessionToken);
	return result;
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

	const result = await driver.transaction(async (transaction) => {
		// The account is known before this transaction opens, so its row is taken before the code is
		// consumed rather than after: taken afterwards it would be the second lock of this transaction
		// and the first of the regeneration it races, which is the cycle itself (E-1601).
		await lockAccountRow(transaction, schema, userId);
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
		return replacePassword(environment, context, {
			transaction,
			actor: actorOfConsumedRecoveryCode(consumed),
			userId: found.id,
			derived,
		});
	});

	context.cookies.setSession(result.sessionToken);
	return result;
}
