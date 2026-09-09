import type { EmailConfig, EmailMessage } from "../auth/config.js";
import type { SignUpResult } from "../auth/results.js";
import { createUserRepository, type User } from "../auth/user.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { VelveError } from "../http/error-map.js";
import type { RequestContext } from "../http/route.js";
import type { IdentifierRejection, IdentityColumns } from "../identity/columns.js";
import { identityColumns } from "../identity/columns.js";
import { randomBytes } from "../token/random.js";
import { type MintedArtefact, mintArtefact, sendOrUndo } from "./artefact.js";
import { type DerivedPassword, derivePassword, writePassword } from "./credential.js";
import { type FlowEnvironment, observedIn } from "./environment.js";

interface SignUpAttempt {
	readonly identifiers: { readonly email?: string; readonly username?: string };
	readonly password: string | null;
}

interface SignUpFlow {
	readonly environment: FlowEnvironment;
	/** Absent in mode `username`, where 3.4 says there is no address and therefore no message. */
	readonly email: EmailConfig | undefined;
}

interface Registration {
	readonly result: SignUpResult;
	readonly artefact: MintedArtefact | null;
	readonly userId: string;
}

/**
 * The registration that ran and was thrown away. It carries its own result, because a transaction is
 * undone by raising and the answer S-ENUM-3 needs was produced inside it. It does not extend `Error`
 * on purpose: capturing a stack for a control-flow signal is work the committing branch does not do,
 * and the whole point of the branch is to do the same work (E-627, E-629).
 */
class DiscardedRegistration {
	readonly registration: Registration;

	constructor(registration: Registration) {
		this.registration = registration;
	}
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

/**
 * Whether an address is taken, as one row of one column either way. `findUserByEmail` answers with a
 * row on the taken branch and with none on the free one, and a row that has to be decoded is work
 * the other branch does not do — which at this endpoint is the whole measurable difference, because
 * there is no KDF to drown it in (E-629).
 */
function addressOwnerStatement(schema: string): string {
	return `SELECT (SELECT owner.id FROM ${qualifiedTableName(schema, "user")} owner
	WHERE owner.email = $1) AS taken_by`;
}

const HEXADECIMAL = "0123456789abcdef";

/** Sixty-four bits is the floor at which a local part drawn at random cannot be one already taken. */
const UNTAKEN_LOCAL_PART_LENGTH = 16;

function randomLocalPart(length: number): string {
	const drawn = randomBytes(Math.max(length, UNTAKEN_LOCAL_PART_LENGTH));
	return Array.from(drawn, (byte) => HEXADECIMAL[byte % HEXADECIMAL.length]).join("");
}

/**
 * The address the cover registration is written under. It cannot be the one the caller sent — that
 * one is taken, and inserting it would raise where the free path inserts — so the domain the caller
 * sent is kept and the local part is drawn. Nothing is invented: no domain is made up and no literal
 * address appears here, which is what S-LINK-5's scan is about. The drawn part is the caller's own
 * length or the sixty-four-bit floor, whichever is longer, so a local part under sixteen characters
 * gets a cover longer than the address the caller sent (E-628, E-931).
 */
function coverColumns(columns: IdentityColumns): IdentityColumns {
	if (columns.email === null) {
		return columns;
	}
	const separator = columns.email.indexOf("@");
	return {
		...columns,
		email: randomLocalPart(separator) + columns.email.slice(separator),
	};
}

/**
 * S-ENUM-3 and 3.13: a taken address answers as a free one does. It does so by **being** a
 * registration — the same statements in the same order, against a cover address — which is then
 * rolled back. Nothing is fabricated, so nothing can disagree with what a success answers: the
 * instants come from the database's clock, the session metadata from the mode the instance runs
 * under, and `isCurrent` from the row the repository built (E-627).
 *
 * What the rollback cannot hide is the caller's next request: the session token names no row. That
 * residual is E-602's and it is unchanged.
 */
async function register(
	flow: SignUpFlow,
	context: RequestContext,
	columns: IdentityColumns,
	derived: DerivedPassword | null,
	discard: boolean,
): Promise<Registration> {
	const { driver, schema, keys, sessions } = flow.environment.services;
	const written = discard ? coverColumns(columns) : columns;

	const run = async (transaction: Driver): Promise<Registration> => {
		const created = await createUserRepository({ driver: transaction, schema }).createUser({
			...written,
			emailVerifiedAt: null,
		});
		const issued = await sessions.issue({
			userId: created.id,
			factors: derived === null ? [] : ["password"],
			observed: observedIn(context),
			transaction,
		});
		if (derived !== null) {
			await writePassword(
				{ driver: transaction, keys, schema },
				{ userId: created.id, derived, setBySessionId: issued.session.id },
			);
		}
		const artefact =
			written.email === null
				? null
				: await mintArtefact(transaction, schema, {
						purpose: "email_verify",
						userId: created.id,
					});
		return {
			// The answer names what the caller sent, never the cover address the row carries.
			result: {
				user: { ...created, email: columns.email, hasPassword: derived !== null },
				sessionToken: issued.token,
				session: issued.session,
			},
			artefact,
			userId: created.id,
		};
	};

	return driver
		.transaction(async (transaction) => {
			const registration = await run(transaction);
			if (discard) {
				throw new DiscardedRegistration(registration);
			}
			return registration;
		})
		.catch((failure: unknown) => {
			if (failure instanceof DiscardedRegistration) {
				return failure.registration;
			}
			throw failure;
		});
}

function confirmationOf(user: User, address: string, artefact: MintedArtefact): EmailMessage {
	return {
		kind: "email_verification",
		to: address,
		userId: user.id,
		token: artefact.token,
		expiresAt: artefact.expiresAt,
	};
}

/**
 * A.7: the fifth kind deliberately carries no token. The library builds no URL on any path — a
 * confirmation link is the application's too — so a sign-in link is a link to the application's
 * sign-in page and needs no artefact minting for a requester who has proved nothing (E-619).
 */
function noticeOf(existingUserId: string, address: string): EmailMessage {
	return { kind: "sign_up_attempt_on_existing_account", to: address, userId: existingUserId };
}

async function removeTheAccountNobodyWasToldAbout(flow: SignUpFlow, userId: string): Promise<void> {
	const { driver, schema } = flow.environment.services;
	await createUserRepository({ driver, schema })
		.deleteUser(userId)
		.catch(() => undefined);
}

/**
 * What the address turned out to be. A lost insert race leaves `taken` with no owner: the unique
 * index says the address is held, and the account holding it was gone again by the time it was
 * looked for, so there is nobody to write to (E-930).
 */
type AddressOccupancy =
	| { readonly kind: "free" }
	| { readonly kind: "taken"; readonly owner: string | null };

/**
 * The one message either branch sends, after the transaction has committed and the account's row
 * lock has gone (E-630). A `send` that throws undoes what stands: the artefact on the free branch
 * and the account with it. The cover branch has nothing committed to undo.
 */
async function announce(
	flow: SignUpFlow,
	registration: Registration,
	address: string | null,
	occupancy: AddressOccupancy,
): Promise<void> {
	// An address means an artefact: `register` mints one whenever it writes a row carrying an
	// address, and the cover writes one too — which is what makes the two branches the same length.
	const minted = registration.artefact;
	if (flow.email === undefined || address === null || minted === null) {
		return;
	}
	const { driver, schema } = flow.environment.services;
	const mailer = { driver, schema, email: flow.email };
	if (occupancy.kind === "taken") {
		if (occupancy.owner !== null) {
			await sendOrUndo(mailer, null, noticeOf(occupancy.owner, address));
		}
		return;
	}
	try {
		await sendOrUndo(mailer, minted, confirmationOf(registration.result.user, address, minted));
	} catch (failure) {
		await removeTheAccountNobodyWasToldAbout(flow, registration.userId);
		throw failure;
	}
}

async function addressOwner(
	environment: FlowEnvironment,
	address: string | null,
): Promise<string | null> {
	if (address === null) {
		return null;
	}
	const { driver, schema } = environment.services;
	const [row] = await driver.query<{ taken_by: string | null }>(addressOwnerStatement(schema), [
		address,
	]);
	return row?.taken_by ?? null;
}

const UNIQUE_VIOLATION = "23505";

/** `pg` and `postgres.js` name it `code`, the test connection names it `sqlState`; both carry the
 * five characters PostgreSQL sent. */
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

/**
 * Which unique index a lost race hit is not in the error every driver hands over, so it is asked
 * for: a name that is now taken is told so (3.4), an address that is now taken is answered by the
 * cover, and a violation neither of them explains is not this function's to translate (E-930).
 */
async function whatTookTheIdentifiers(
	environment: FlowEnvironment,
	columns: IdentityColumns,
): Promise<AddressOccupancy | null> {
	if (columns.usernameKey !== null) {
		const named = await environment.services.users.findUserByUsernameKey(columns.usernameKey);
		if (named !== null) {
			throw new VelveError("username_taken");
		}
	}
	if (columns.email === null) {
		return null;
	}
	return { kind: "taken", owner: await addressOwner(environment, columns.email) };
}

/**
 * 3.13 fixes what a taken address is answered with, and occupancy is read before the transaction
 * that inserts — so a concurrent registration can take the address in between and the unique index
 * is the only thing that says so. A caller that loses that race is a caller registering a taken
 * address, and gets what one gets; `/sign-up` declares no code for the failure and 3.15 D.1 makes
 * that declaration a contract (E-930).
 */
async function registerAgainst(
	flow: SignUpFlow,
	context: RequestContext,
	columns: IdentityColumns,
	derived: DerivedPassword | null,
	owner: string | null,
): Promise<{ readonly registration: Registration; readonly occupancy: AddressOccupancy }> {
	const discarding = async (
		occupancy: AddressOccupancy,
	): Promise<{ registration: Registration; occupancy: AddressOccupancy }> => ({
		registration: await register(flow, context, columns, derived, true),
		occupancy,
	});
	if (owner !== null) {
		return discarding({ kind: "taken", owner });
	}
	try {
		return {
			registration: await register(flow, context, columns, derived, false),
			occupancy: { kind: "free" },
		};
	} catch (failure) {
		const winner = isUniqueViolation(failure)
			? await whatTookTheIdentifiers(flow.environment, columns)
			: null;
		if (winner === null) {
			throw failure;
		}
		return discarding(winner);
	}
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

	const attempted = await registerAgainst(
		flow,
		context,
		columns,
		derived,
		await addressOwner(environment, columns.email),
	);
	context.cookies.setSession(attempted.registration.result.sessionToken);
	await announce(flow, attempted.registration, columns.email, attempted.occupancy);
	return attempted.registration.result;
}
