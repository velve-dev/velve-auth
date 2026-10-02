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
	readonly email: EmailConfig | undefined;
}

interface Registration {
	readonly result: SignUpResult;
	readonly artefact: MintedArtefact | null;
	readonly userId: string;
}

//the discard signal must not capture a stack the committing branch never captures (E-629)
class DiscardedRegistration {
	readonly registration: Registration;

	constructor(registration: Registration) {
		this.registration = registration;
	}
}

//only a malformed name has its own code and a malformed address is ordinary bad input
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

//both branches must read one row of one column with nothing extra to decode (E-629)
function addressOwnerStatement(schema: string): string {
	return `SELECT (SELECT owner.id FROM ${qualifiedTableName(schema, "user")} owner
	WHERE owner.email = $1) AS taken_by`;
}

const HEXADECIMAL = "0123456789abcdef";

//a local part drawn below sixty-four bits could collide with one already taken (E-939)
const UNTAKEN_LOCAL_PART_LENGTH = 16;

function randomLocalPart(length: number): string {
	const drawn = randomBytes(Math.max(length, UNTAKEN_LOCAL_PART_LENGTH));
	return Array.from(drawn, (byte) => HEXADECIMAL[byte % HEXADECIMAL.length]).join("");
}

//the cover address keeps the caller's domain and draws only the local part (E-628)
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

//a taken address must answer by running a registration that is then rolled back (E-627)
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
		const issued = await sessions.boundTo(transaction).issue({
			userId: created.id,
			factors: derived === null ? [] : ["password"],
			observed: observedIn(context),
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
						subject: { userId: created.id },
					});
		return {
			//the answer must name the address the caller sent and never the cover (S-ENUM-3)
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

//the notice carries no token as a requester who proved nothing gets no artefact (E-619)
function noticeOf(existingUserId: string, address: string): EmailMessage {
	return { kind: "sign_up_attempt_on_existing_account", to: address, userId: existingUserId };
}

async function removeTheAccountNobodyWasToldAbout(flow: SignUpFlow, userId: string): Promise<void> {
	const { driver, schema } = flow.environment.services;
	await createUserRepository({ driver, schema })
		.deleteUser(userId)
		.catch(() => undefined);
}

//a lost insert race may leave the address taken with no owner left to write to (E-930)
type AddressOccupancy =
	| { readonly kind: "free" }
	| { readonly kind: "taken"; readonly owner: string | null };

interface Attempt {
	readonly registration: Registration;
	readonly occupancy: AddressOccupancy;
}

//the one message must be sent only after the transaction has committed (E-630)
async function announce(
	flow: SignUpFlow,
	registration: Registration,
	address: string | null,
	occupancy: AddressOccupancy,
): Promise<void> {
	//the cover mints an artefact too and keeps both branches the same length (E-627)
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

//drivers disagree on the name of the sqlstate field and both names must be read
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

//a lost race on the name index must be told as a taken name (E-947)
async function refuseTheNameIfItWasTheName(
	environment: FlowEnvironment,
	columns: IdentityColumns,
): Promise<void> {
	if (columns.usernameKey === null) {
		return;
	}
	const named = await environment.services.users.findUserByUsernameKey(columns.usernameKey);
	if (named !== null || columns.email === null) {
		throw new VelveError("username_taken");
	}
}

//a third draw at sixty-four bits would be arguing with the arithmetic (E-947)
const COVER_DRAWS = 2;

//a cover insert that collided must be drawn again or told as a taken name (E-947)
async function cover(
	flow: SignUpFlow,
	context: RequestContext,
	columns: IdentityColumns,
	derived: DerivedPassword | null,
	occupancy: AddressOccupancy,
): Promise<Attempt> {
	let collided: unknown;
	for (let draw = 0; draw < COVER_DRAWS; draw += 1) {
		try {
			return { registration: await register(flow, context, columns, derived, true), occupancy };
		} catch (failure) {
			if (!isUniqueViolation(failure)) {
				throw failure;
			}
			await refuseTheNameIfItWasTheName(flow.environment, columns);
			collided = failure;
		}
	}
	throw collided;
}

//a caller that loses the insert race must get the answer of a taken address (E-930)
async function registerOrCover(
	flow: SignUpFlow,
	context: RequestContext,
	columns: IdentityColumns,
	derived: DerivedPassword | null,
	owner: string | null,
): Promise<Attempt> {
	if (owner !== null) {
		return cover(flow, context, columns, derived, { kind: "taken", owner });
	}
	try {
		return {
			registration: await register(flow, context, columns, derived, false),
			occupancy: { kind: "free" },
		};
	} catch (failure) {
		if (!isUniqueViolation(failure)) {
			throw failure;
		}
		await refuseTheNameIfItWasTheName(flow.environment, columns);
		return cover(flow, context, columns, derived, {
			kind: "taken",
			owner: await addressOwner(flow.environment, columns.email),
		});
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

	//the kdf must run before any lookup or a taken address would skip the costliest step (S-TIM-6)
	const derived =
		attempt.password === null
			? null
			: await derivePassword(
					attempt.password,
					environment.services.password,
					environment.semaphore,
				);

	//a taken username may be told as usernames are declared enumerable (S-ENUM-8)
	if (columns.usernameKey !== null) {
		const named = await environment.services.users.findUserByUsernameKey(columns.usernameKey);
		if (named !== null) {
			throw new VelveError("username_taken");
		}
	}

	const attempted = await registerOrCover(
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
