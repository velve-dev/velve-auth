import type { EmailConfig } from "../auth/config.js";
import type { SignUpResult } from "../auth/results.js";
import { createUserRepository, type User } from "../auth/user.js";
import type { Driver } from "../db/driver.js";
import { VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import type { IdentifierRejection, IdentityColumns } from "../identity/columns.js";
import { identityColumns } from "../identity/columns.js";
import { DEFAULT_SESSION_METADATA_MODE, sessionMetadataFor } from "../session/metadata.js";
import { createSessionToken } from "../session/token.js";
import { mintAndMail } from "./artefact.js";
import {
	createPasswordProvenance,
	type DerivedPassword,
	derivePassword,
	writePassword,
} from "./credential.js";
import { type FlowEnvironment, observedIn } from "./environment.js";

const MILLISECONDS_IN_A_SECOND = 1000;

interface SignUpAttempt {
	readonly identifiers: { readonly email?: string; readonly username?: string };
	readonly password: string | null;
}

interface SignUpFlow {
	readonly environment: FlowEnvironment;
	/** Absent in mode `username`, where 3.4 says there is no address and therefore no message. */
	readonly email: EmailConfig | undefined;
}

/** 3.15 B.9 lists `username_invalid` for sign-up; a malformed address is ordinary bad input. */
function refuse(rejection: IdentifierRejection): never {
	throw new VelveError(rejection.identifier === "email" ? "invalid_input" : "username_invalid");
}

function columnsOf(environment: FlowEnvironment, attempt: SignUpAttempt): IdentityColumns {
	const resolved = identityColumns(environment.services.identity, attempt.identifiers);
	if (!resolved.accepted) {
		refuse(resolved.rejection);
	}
	return resolved.value;
}

interface CoverDeadlines {
	readonly created_at: unknown;
	readonly idle_expires_at: unknown;
	readonly absolute_expires_at: unknown;
}

/**
 * The three timestamps a real session carries, read from the clock a real session reads them from.
 * `services.clock` is the process clock and the row's are the database's, so a cover built from the
 * former would differ from a success by whatever the two disagree by (E-603).
 */
const COVER_DEADLINES = `SELECT now() AS created_at,
	now() + make_interval(secs => $1::double precision) AS idle_expires_at,
	now() + make_interval(secs => $2::double precision) AS absolute_expires_at`;

function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

/**
 * S-ENUM-3 and 3.13: a taken address answers as a free one does. The answer is built to the shape a
 * success has, from values that are random on both paths, and nothing of it reaches the database —
 * the session token names no row. That the token then resolves to `null` is the residual this cover
 * cannot close, and E-602 states it rather than leaving it to be found.
 */
async function coverSignUpResult(
	environment: FlowEnvironment,
	context: RequestContext,
	columns: IdentityColumns,
	hasPassword: boolean,
): Promise<SignUpResult> {
	const settings = environment.services.sessions.settings;
	const [deadlines] = await environment.services.driver.query<CoverDeadlines>(COVER_DEADLINES, [
		settings.idleTimeoutMs / MILLISECONDS_IN_A_SECOND,
		settings.absoluteTimeoutMs / MILLISECONDS_IN_A_SECOND,
	]);
	if (deadlines === undefined) {
		throw new TypeError("the database answered no row for its own clock");
	}
	const createdAt = toDate(deadlines.created_at);
	const metadata = sessionMetadataFor(DEFAULT_SESSION_METADATA_MODE, observedIn(context));
	const userId = crypto.randomUUID();
	const issued = createSessionToken();
	context.cookies.setSession(issued.token);
	return {
		user: {
			id: userId,
			createdAt,
			updatedAt: createdAt,
			email: columns.email,
			emailVerifiedAt: null,
			username: columns.username,
			disabledAt: null,
			hasPassword,
			importedFrom: null,
		},
		sessionToken: issued.token,
		session: {
			id: crypto.randomUUID(),
			userId,
			createdAt,
			lastUsedAt: createdAt,
			idleExpiresAt: toDate(deadlines.idle_expires_at),
			absoluteExpiresAt: toDate(deadlines.absolute_expires_at),
			factors: hasPassword ? ["password"] : [],
			ipAddress: metadata.ipAddress,
			userAgent: metadata.userAgent,
			isCurrent: true,
		},
	};
}

async function mailTheConfirmation(
	flow: SignUpFlow,
	transaction: Driver,
	user: User,
): Promise<void> {
	const address = user.email;
	if (flow.email === undefined || address === null) {
		return;
	}
	await mintAndMail(
		{ driver: transaction, schema: flow.environment.services.schema, email: flow.email },
		{
			purpose: "email_verify",
			userId: user.id,
			message: (issued) => ({
				kind: "email_verification",
				to: address,
				userId: user.id,
				token: issued.token,
				expiresAt: issued.expiresAt,
			}),
		},
	);
}

/**
 * 3.15 B.1 puts the account and its credential in one transaction. A.7 puts the confirmation
 * message in it too: a `send` that throws rolls the whole registration back, so no account is left
 * behind that no one was told about. The session is issued after the commit, because issuing one is
 * reachable only through the service the assembly built over the outer driver (E-599).
 */
async function createAccount(
	flow: SignUpFlow,
	context: RequestContext,
	columns: IdentityColumns,
	derived: DerivedPassword | null,
): Promise<SignUpResult> {
	const { driver, schema, keys, sessions } = flow.environment.services;

	const user = await driver.transaction(async (transaction) => {
		const created = await createUserRepository({ driver: transaction, schema }).createUser({
			...columns,
			emailVerifiedAt: null,
		});
		if (derived !== null) {
			await writePassword({ driver: transaction, keys, schema }, { userId: created.id, derived });
		}
		await mailTheConfirmation(flow, transaction, created);
		return created;
	});

	const issued = await sessions.issue({
		userId: user.id,
		factors: derived === null ? [] : ["password"],
		observed: observedIn(context),
	});
	if (derived !== null) {
		// L-12: the session the password was set in, so a confirmation redeemed from it keeps it.
		await createPasswordProvenance({ driver, schema }).recordSessionThatSetIt({
			userId: user.id,
			sessionId: issued.session.id,
		});
	}
	context.cookies.setSession(issued.token);
	return {
		user: { ...user, hasPassword: derived !== null },
		sessionToken: issued.token,
		session: issued.session,
	};
}

async function announceToTheExistingAccount(flow: SignUpFlow, existing: User): Promise<void> {
	const address = existing.email;
	// A.7: the fifth kind deliberately carries no token — it leads to a sign-in, not to a
	// confirmation nobody asked for (E-601).
	if (flow.email === undefined || address === null) {
		return;
	}
	await flow.email.send({
		kind: "sign_up_attempt_on_existing_account",
		to: address,
		userId: existing.id,
	});
}

export async function signUp(
	flow: SignUpFlow,
	context: RequestContext,
	attempt: SignUpAttempt,
): Promise<SignUpResult> {
	const { environment } = flow;
	const columns = columnsOf(environment, attempt);
	await context.enforceAccountRateLimit(columns.email ?? columns.usernameKey ?? "");

	// S-TIM-6: the KDF runs before anything is looked up, so a taken address cannot be told from a
	// free one by the absence of the most expensive step on the path.
	const derived =
		attempt.password === null
			? null
			: await derivePassword(
					attempt.password,
					environment.services.password,
					environment.semaphore,
				);

	// 3.4 and S-ENUM-8: a name is enumerable by construction and is told so; an address is not, and
	// answers as a free one does.
	if (columns.usernameKey !== null) {
		const named = await environment.services.users.findUserByUsernameKey(columns.usernameKey);
		if (named !== null) {
			throw new VelveError("username_taken");
		}
	}

	const taken =
		columns.email === null ? null : await environment.services.users.findUserByEmail(columns.email);
	if (taken !== null) {
		await announceToTheExistingAccount(flow, taken);
		return coverSignUpResult(environment, context, columns, derived !== null);
	}

	return createAccount(flow, context, columns, derived);
}
