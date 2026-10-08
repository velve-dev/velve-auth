import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import { lockAccountRow } from "../db/lock.js";
import { withReadCommittedTransactions } from "../db/read-committed.js";
import { encodeBase64Url } from "../keys/base64url.js";
import type { KeyProvider } from "../keys/provider.js";
import { randomBytes } from "../token/random.js";
import type { SecurityStateAlarmReason, SecurityStateAlarms } from "./alarm.js";
import {
	type AnchorReading,
	compareWithAnchors,
	consultAnchors,
	recordSealWithAnchors,
	type SecurityStateAnchorPort,
} from "./anchor.js";
import type { SealedComponents } from "./encoding.js";
import {
	checkSecurityState,
	readSecurityState,
	type SealingMode,
	type SecurityStateRead,
	sealedComponentsOf,
	securityStateReadStatement,
} from "./read.js";
import { computeSeal } from "./seal.js";

/** one legitimate change of an account's sign-in methods, written and sealed under the account lock */
export interface SealingChange<T> {
	/** whether the change draws a new session epoch, which every mass revocation does */
	readonly epoch: "keep" | "raise";
	/** writes the change over the locked transaction, which refuses a second read of the state */
	write(tx: Driver, read: SecurityStateRead): Promise<T>;
	/** the components after the change, computed from the verified read and what the write returned */
	after(read: SecurityStateRead, written: T): SealedComponents;
}

/** what a sealing transaction needs besides its change */
interface SealingContext {
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly sealing: SealingMode;
	/** rewrites an unsealed account's old-form envelopes and returns the read with their new ciphertexts */
	readonly convertUnsealed?: (tx: Driver, read: SecurityStateRead) => Promise<SecurityStateRead>;
}

/** the seal a change wrote, with the verified read it was computed from */
interface SealWritten<T> {
	readonly userId: string;
	readonly version: number;
	readonly sessionEpoch: number;
	readonly keyVersion: number;
	readonly digest: Uint8Array<ArrayBuffer>;
	readonly firstSeal: boolean;
	readonly read: SecurityStateRead;
	readonly written: T;
}

/** why a sealing transaction refused, a broken state named as the alarm names it */
type SealingRefusal =
	| Exclude<SecurityStateAlarmReason, "token_binding_mismatch" | "envelope_binding_mismatch">
	| "account_missing"
	| "version_exhausted";

/** the outcome of a sealing change as the path that asked for it sees it */
type SealingOutcome<T> =
	| { readonly kind: "sealed"; readonly sealed: SealWritten<T> }
	| { readonly kind: "refused"; readonly reason: SealingRefusal };

/** a sealing transaction refused the change and rolled it back */
export class SealingRefusedError extends Error {
	readonly reason: SealingRefusal;

	constructor(reason: SealingRefusal) {
		super(`the sealing transaction refused the change: ${reason}`);
		this.name = "SealingRefusedError";
		this.reason = reason;
	}
}

/** a change read the account's state a second time inside its sealing transaction */
class SecondStateReadError extends Error {
	constructor() {
		super("a sealing transaction read the security state a second time");
		this.name = "SecondStateReadError";
	}
}

class FirstSealConflict extends Error {
	constructor(cause: unknown) {
		super("a seal row appeared under the first seal's insert", { cause });
		this.name = "FirstSealConflict";
	}
}

const ATTEMPTS = 3;
const MAXIMUM_SEAL_NUMBER = Number.MAX_SAFE_INTEGER;
const EPOCH_MASK = (1n << 53n) - 1n;
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
	const fields = error as { readonly sqlState?: unknown; readonly code?: unknown } | null;
	return fields?.sqlState === UNIQUE_VIOLATION || fields?.code === UNIQUE_VIOLATION;
}

//an epoch is compared for equality only and is drawn rather than counted (E-3351)
export function drawSessionEpochOtherThan(current: number): number {
	for (;;) {
		const drawn = randomBytes(8).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
		const epoch = Number(drawn & EPOCH_MASK);
		if (epoch >= 1 && epoch !== current) {
			return epoch;
		}
	}
}

//the new seal is computed from the one verified read and never from a second one (E-3280)
function refusingSecondRead(tx: Driver, statement: string): Driver {
	return {
		query<R>(sql: string, params: unknown[]): Promise<R[]> {
			if (sql === statement) {
				return Promise.reject(new SecondStateReadError());
			}
			return tx.query<R>(sql, params);
		},
		transaction<R>(work: (inner: Driver) => Promise<R>): Promise<R> {
			return tx.transaction((inner) => work(refusingSecondRead(inner, statement)));
		},
	};
}

function brokenVerdictOf(
	verdict: Awaited<ReturnType<typeof checkSecurityState>>["verdict"],
): SealingRefusal | null {
	return verdict === "valid" || verdict === "unsealed" ? null : verdict;
}

async function writeSealRow(
	tx: Driver,
	schema: string,
	read: SecurityStateRead,
	seal: {
		readonly version: number;
		readonly sessionEpoch: number;
		readonly keyVersion: number;
		readonly digest: Uint8Array<ArrayBuffer>;
	},
): Promise<void> {
	const table = qualifiedTableName(schema, "security_state");
	if (read.seal === null) {
		await tx
			.query(
				`INSERT INTO ${table} (user_id, version, digest, key_version, session_epoch)
VALUES ($1, $2, $3, $4, $5)`,
				[read.userId, seal.version, seal.digest, seal.keyVersion, seal.sessionEpoch],
			)
			.catch((error: unknown) => {
				throw isUniqueViolation(error) ? new FirstSealConflict(error) : error;
			});
		return;
	}
	//a seal row rewritten past the lock since the read is a broken state and is not overwritten (S-INTEG-3)
	const updated = await tx.query<{ updated: number }>(
		`UPDATE ${table}
SET version = $2, digest = $3, key_version = $4, session_epoch = $5, sealed_at = now()
WHERE user_id = $1 AND version = $6 AND digest = $7 AND key_version = $8 AND session_epoch = $9
RETURNING 1 AS updated`,
		[
			read.userId,
			seal.version,
			seal.digest,
			seal.keyVersion,
			seal.sessionEpoch,
			read.seal.version,
			read.seal.digest,
			read.seal.keyVersion,
			read.seal.sessionEpoch,
		],
	);
	if (updated.length !== 1) {
		throw new SealingRefusedError("seal_mismatch");
	}
}

//a change must verify the state it read under the lock before it writes or seals (S-INTEG-3)
export async function sealUnderAccountLock<T>(
	tx: Driver,
	userId: string,
	context: SealingContext,
	anchorReading: AnchorReading,
	change: SealingChange<T>,
): Promise<SealWritten<T>> {
	const statement = securityStateReadStatement(context.schema);
	await lockAccountRow(tx, context.schema, userId);
	const verifiedRead = await readSecurityState(tx, context.schema, userId);
	if (verifiedRead === null) {
		throw new SealingRefusedError("account_missing");
	}
	const { verdict } = await checkSecurityState(context.keys, verifiedRead, context.sealing);
	const broken = brokenVerdictOf(verdict);
	if (broken !== null) {
		throw new SealingRefusedError(broken);
	}
	const anchorVerdict = compareWithAnchors(verifiedRead.seal, anchorReading);
	if (
		anchorVerdict === "version_below_anchor" ||
		anchorVerdict === "anchor_mismatch" ||
		anchorVerdict === "anchor_unavailable"
	) {
		throw new SealingRefusedError(anchorVerdict);
	}
	const guarded = refusingSecondRead(tx, statement);
	const read =
		verifiedRead.seal === null && context.convertUnsealed !== undefined
			? await context.convertUnsealed(guarded, verifiedRead)
			: verifiedRead;
	const current = read.seal;
	if (current !== null && current.version >= MAXIMUM_SEAL_NUMBER) {
		throw new SealingRefusedError("version_exhausted");
	}
	const written = await change.write(guarded, read);
	const version = current === null ? 1 : current.version + 1;
	const currentEpoch = current === null ? 1 : current.sessionEpoch;
	const sessionEpoch =
		change.epoch === "raise" ? drawSessionEpochOtherThan(currentEpoch) : currentEpoch;
	const { keyVersion, digest } = await computeSeal(context.keys, {
		userId: read.userId,
		version,
		sessionEpoch,
		...change.after(read, written),
	});
	await writeSealRow(tx, context.schema, read, { version, sessionEpoch, keyVersion, digest });
	return {
		userId: read.userId,
		version,
		sessionEpoch,
		keyVersion,
		digest,
		firstSeal: current === null,
		read,
		written,
	};
}

//sign-up creates the account row instead of locking it and no other transaction can hold it yet (E-3364)
export async function sealCreatedAccount(
	tx: Driver,
	userId: string,
	context: Pick<SealingContext, "schema" | "keys">,
): Promise<SealWritten<null>> {
	const read = await readSecurityState(tx, context.schema, userId);
	if (read === null) {
		throw new SealingRefusedError("account_missing");
	}
	if (read.seal !== null) {
		throw new SealingRefusedError("seal_mismatch");
	}
	const { keyVersion, digest } = await computeSeal(context.keys, {
		userId: read.userId,
		version: 1,
		sessionEpoch: 1,
		...sealedComponentsOf(read),
	});
	await writeSealRow(tx, context.schema, read, { version: 1, sessionEpoch: 1, keyVersion, digest });
	return {
		userId: read.userId,
		version: 1,
		sessionEpoch: 1,
		keyVersion,
		digest,
		firstSeal: true,
		read,
		written: null,
	};
}

//only a seal row a writer inserted past the library can collide with a first seal (E-3297)
export async function runSealingTransaction<T>(
	driver: Driver,
	work: (tx: Driver) => Promise<T>,
): Promise<T> {
	const readCommitted = withReadCommittedTransactions(driver);
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await readCommitted.transaction(work);
		} catch (error) {
			if (!(error instanceof FirstSealConflict)) {
				throw error;
			}
			if (attempt >= ATTEMPTS) {
				throw new SealingRefusedError("seal_mismatch");
			}
		}
	}
}

/** what a sealing change reaches outside its transaction */
interface SealingServices extends SealingContext {
	readonly driver: Driver;
	readonly anchors: readonly SecurityStateAnchorPort[];
	readonly alarms: SecurityStateAlarms;
}

function isAlarmReason(
	refusal: SealingRefusal,
): refusal is Extract<SealingRefusal, SecurityStateAlarmReason> {
	return refusal !== "account_missing" && refusal !== "version_exhausted";
}

//the anchor is asked before the lock and learns the seal after commit (E-3304)
export async function sealAccount<T>(
	services: SealingServices,
	userId: string,
	change: SealingChange<T>,
): Promise<SealingOutcome<T>> {
	const anchorReading = await consultAnchors(services.anchors, userId);
	let sealed: SealWritten<T>;
	try {
		sealed = await runSealingTransaction(services.driver, (tx) =>
			sealUnderAccountLock(tx, userId, services, anchorReading, change),
		);
	} catch (error) {
		if (!(error instanceof SealingRefusedError)) {
			throw error;
		}
		if (isAlarmReason(error.reason)) {
			services.alarms.raise({ userId, occasion: "change", reason: error.reason });
		}
		return { kind: "refused", reason: error.reason };
	}
	void recordSealWithAnchors(
		services.anchors,
		{ userId, version: sealed.version, digest: encodeBase64Url(sealed.digest) },
		() => services.alarms.raise({ userId, occasion: "change", reason: "anchor_unavailable" }),
	);
	return { kind: "sealed", sealed };
}
