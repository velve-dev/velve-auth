import type { EmailConfig } from "../auth/config.js";
import { type Actor, actorOfConsumedRecoveryCode } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { pepperRecoveryCode, pepperRecoveryCodeUnder } from "../factor/recovery/pepper.js";
import { createRecoveryCodeRepository } from "../factor/recovery/repository.js";
import { ConcealedError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import { comparisonFormOf } from "../identity/fold.js";
import { normaliseEmail } from "../identity/normalise.js";
import { findUserByIdentifier } from "../identity/resolution.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { mintArtefact, redeemOrRefuse, sendOrUndo, subjectOfAddress } from "./artefact.js";
import { type DerivedPassword, derivePassword, writePassword } from "./credential.js";
import { accountOfRedemption, type FlowEnvironment, mailerOf, observedIn } from "./environment.js";
import type { SetPasswordResult } from "./results.js";

//an unknown identifier must run the statements a resolved account runs (S-TIM-6)
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
	//the unknown branch must mint a row too and call send exactly once (E-597)
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

//revocation, new session and credential are one transaction and the revocation comes first (E-610)
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
	const { schema, keys, sessions, pluginRuntime } = environment.services;
	//the account row is locked first as a first confirmation writes these tables reversed (E-1602)
	await lockAccountRow(input.transaction, schema, input.userId);
	const sessionRows = createSessionRepository({ driver: input.transaction, schema });
	//a reset learns its account inside the transaction so a refusal rolls the redemption back too (E-2580)
	if (pluginRuntime.listensTo("beforeSessionRevoke")) {
		await announceEachRevocation(
			pluginRuntime,
			{
				userId: input.userId,
				sessionIds: await sessionRows.listEverySessionIdOwnedBy({ actor: input.actor }),
				reason: "password_reset",
			},
			input.transaction,
		);
	}
	const revokedOtherSessionsCount = await sessionRows.deleteEverySessionOwnedBy({
		actor: input.actor,
	});
	const issued = await sessions.boundTo(input.transaction).issueReplacingPresented({
		presentedToken: context.sessionToken,
		userId: input.userId,
		factors: ["password"],
		observed: observedIn(context),
	});
	//the storing session must be written with the password in one statement (E-626)
	await writePassword(
		{ driver: input.transaction, keys, schema, password: environment.services.password },
		{ actor: input.actor, derived: input.derived, setBySessionId: issued.session.id },
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
	//the policy, validate and the kdf need only the input and run before the token is spent (S-DOS-2)
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

//a consumed recovery code must not be replaced by a newly generated one
export async function redeemResetWithRecoveryCode(
	environment: FlowEnvironment,
	context: RequestContext,
	input: {
		readonly identifier: string;
		readonly recoveryCode: string;
		readonly newPassword: string;
	},
): Promise<SetPasswordResult> {
	//an attempt the account bucket refuses must derive nothing (S-RATE-7)
	await context.enforceAccountRateLimit(comparisonFormOf(input.identifier));
	const derived = await derivePassword(
		input.newPassword,
		environment.services.password,
		environment.semaphore,
	);
	const { driver, schema, identity, keys } = environment.services;

	const found = await findUserByIdentifier({
		driver,
		schema,
		configuration: identity,
		identifier: input.identifier,
	});
	const userId = found === null ? AN_ACCOUNT_THAT_CANNOT_EXIST : found.id;

	const codes = createRecoveryCodeRepository({ driver, schema });
	const versions = await codes.pepperVersionsOf({ userId });
	//an account with no codes must still cost one hmac (S-TIM-6)
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
		//the account row must be locked before the code is consumed or it closes a cycle (E-1601)
		await lockAccountRow(transaction, schema, userId);
		const consumed = await createRecoveryCodeRepository({
			driver: transaction,
			schema,
		}).consumeCode({ userId, candidateHmacs: candidates });
		if (consumed === null || found === null) {
			throw new ConcealedError("recovery_code_not_found");
		}
		//a disabled account must answer as a wrong code does and the code is still spent
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
