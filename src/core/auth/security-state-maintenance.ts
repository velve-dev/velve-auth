import { type Actor, actorOfMaintenance } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import { lockAccountRow } from "../db/lock.js";
import { isRowIdentifier } from "../db/row-identifier.js";
import type { LogLevel } from "../http/environment.js";
import { ConcealedError } from "../http/error-map.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { KeyError } from "../keys/errors.js";
import {
	type AnchorReading,
	consultAnchors,
	recordSealWithAnchors,
} from "../security-state/anchor.js";
import {
	FIRST_GENERATIONS,
	type SealedComponents,
	type SealedGenerations,
} from "../security-state/encoding.js";
import { readSecurityState, type SecurityStateRead } from "../security-state/read.js";
import {
	envelopesOf,
	readWithEnvelopes,
	type SecurityStateRuntime,
	sealChange,
} from "../security-state/runtime.js";
import { computeSeal } from "../security-state/seal.js";
import {
	componentsAfter,
	drawGenerationOtherThan,
	drawSessionEpochOtherThan,
	type SealingChange,
} from "../security-state/sealing.js";
import { rebindTokenRowsUnderCurrentKey, type TokenTable } from "../token/rebind.js";
import {
	inOneTransaction,
	type OpenTransaction,
	rebindEnvelopesOfAccount,
} from "./account-envelopes.js";
import type { SealRowPresence } from "./security-state.js";

/** what one key version still holds after a maintenance run */
export interface RowsUnderSecurityStateKeyVersion {
	readonly seals: number;
	readonly tokens: number;
	/** token rows the run refused and left standing, which do not keep the version in the ring */
	readonly traces: number;
}

/** what a maintenance run did to the accounts, and what every key version holds after it */
export interface SecurityStateReport {
	readonly sealed: number;
	readonly rekeyed: number;
	readonly refused: number;
	readonly unchanged: number;
	/** every account the run refused and left as it was, whether broken or with an envelope it could not open */
	readonly refusedUserIds: readonly string[];
	readonly rowsByKeyVersion: Readonly<Record<number, RowsUnderSecurityStateKeyVersion>>;
}

/** what an administrator reseal ratified, which the application reads to see what it confirmed */
export interface SealedSecurityState {
	readonly version: number;
	readonly sessionEpoch: number;
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly disabled: boolean;
	readonly password: boolean;
	readonly passwordSetBySession: string | null;
	readonly passwordResetRequired: boolean;
	readonly totp: "none" | "unconfirmed" | "confirmed";
	/** the credential id of every passkey, in base64url */
	readonly passkeyCredentialIds: readonly string[];
	readonly identities: readonly { readonly provider: string; readonly subject: string }[];
	readonly recoveryCodeCount: number;
}

type SecurityStateMaintenanceErrorCode =
	| "security_state_reason_missing"
	| "security_state_account_missing"
	| "security_state_anchor_unavailable"
	| "security_state_version_exhausted"
	| "security_state_changed_during_reseal"
	| "security_state_envelope_unreadable"
	| "security_state_account_failed";

/** a maintenance call refused, with a stable code and the account it was about where there is one */
export class SecurityStateMaintenanceError extends Error {
	readonly code: SecurityStateMaintenanceErrorCode;
	readonly userId: string | null;

	constructor(
		code: SecurityStateMaintenanceErrorCode,
		userId: string | null,
		options?: { readonly cause?: unknown },
	) {
		super(
			userId === null ? code : `${code}: ${userId}`,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "SecurityStateMaintenanceError";
		this.code = code;
		this.userId = userId;
	}
}

type MaintenanceLog = (
	level: LogLevel,
	message: string,
	fields?: Readonly<Record<string, unknown>>,
) => void;

const ACCOUNT_BATCH = 100;
const TOKEN_BATCH = 100;
const FIRST_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const TOKEN_TABLES: readonly TokenTable[] = [
	"session",
	"one_time_token",
	"pending_authentication",
	"webauthn_challenge",
];

class AccountGoneError extends Error {
	constructor() {
		super("the account was deleted between the listing and its sealing transaction");
		this.name = "AccountGoneError";
	}
}

async function rewriteEnvelopes(
	runtime: SecurityStateRuntime,
	tx: Driver,
	actor: Actor,
	read: SecurityStateRead,
	sealRow: SealRowPresence,
): Promise<SecurityStateRead> {
	const rewrite = await rebindEnvelopesOfAccount({
		//the guarded driver is the sealing transaction the account lock was taken in (E-3293)
		driver: tx as OpenTransaction,
		schema: runtime.schema,
		keys: runtime.keys,
		actor,
		sealing: runtime.sealing,
		read: { ...envelopesOf(read), sealRow },
	});
	return readWithEnvelopes(read, rewrite.envelopes);
}

//a sealed account is rewritten under the current key as a reseal of unchanged components (S-INTEG-3)
function rekeying(runtime: SecurityStateRuntime, actor: Actor): SealingChange<SecurityStateRead> {
	return {
		epoch: "keep",
		write: (tx, read) => rewriteEnvelopes(runtime, tx, actor, read, "present"),
		after: (read, rewritten): SealedComponents => componentsAfter(read, rewritten),
	};
}

async function nextAccountIds(
	driver: Driver,
	users: string,
	after: string,
): Promise<readonly string[]> {
	const rows = await driver.query<{ id: string }>(
		`SELECT id::text AS id FROM ${users} /* no owner predicate: the maintenance step visits every account */
WHERE id > $1::uuid ORDER BY id LIMIT $2`,
		[after, ACCOUNT_BATCH],
	);
	return rows.map((row) => row.id);
}

type AccountOutcome = "sealed" | "rekeyed" | "unchanged" | "refused" | "gone";

async function sealOneAccount(
	runtime: SecurityStateRuntime,
	userId: string,
): Promise<AccountOutcome> {
	const actor = actorOfMaintenance(userId);
	try {
		const sealed = await sealChange(runtime, actor, rekeying(runtime, actor), {
			occasion: "maintenance",
			accountMissing: () => new AccountGoneError(),
		});
		if (sealed.firstSeal) {
			return "sealed";
		}
		return sealed.version === sealed.read.seal?.version ? "unchanged" : "rekeyed";
	} catch (error) {
		if (error instanceof AccountGoneError) {
			return "gone";
		}
		//a broken state is reported by its alarm and left as it is (S-INTEG-7)
		if (error instanceof ConcealedError) {
			return "refused";
		}
		//an envelope that cannot be opened fails its account and not the run (E-3181)
		if (error instanceof KeyError) {
			runtime.alarms.raise({
				userId,
				occasion: "maintenance",
				reason: "envelope_binding_mismatch",
			});
			return "refused";
		}
		throw new SecurityStateMaintenanceError("security_state_account_failed", userId, {
			cause: error,
		});
	}
}

async function sealRowsByKeyVersion(
	driver: Driver,
	states: string,
): Promise<ReadonlyMap<number, number>> {
	const rows = await driver.query<{ key_version: number; seals: number }>(
		`SELECT key_version, count(*)::int AS seals FROM ${states} /* no owner predicate: a count over every account */
GROUP BY key_version ORDER BY key_version`,
		[],
	);
	return new Map(rows.map((row) => [Number(row.key_version), Number(row.seals)]));
}

function emptyRows(): { seals: number; tokens: number; traces: number } {
	return { seals: 0, tokens: 0, traces: 0 };
}

//token rows are rebound outside every account lock or a redemption and the pass deadlock (S-INTEG-8)
async function rebindEveryTokenTable(
	runtime: SecurityStateRuntime,
	rows: Map<number, { seals: number; tokens: number; traces: number }>,
): Promise<void> {
	for (const table of TOKEN_TABLES) {
		const rebinding = await rebindTokenRowsUnderCurrentKey({
			driver: runtime.driver,
			schema: runtime.schema,
			keys: runtime.keys,
			sealing: runtime.sealing,
			table,
			batchSize: TOKEN_BATCH,
			reportTokenBindingRefusal: runtime.reportTokenBindingRefusal,
		});
		for (const [version, held] of Object.entries(rebinding.rowsByKeyVersion)) {
			const entry = rows.get(Number(version)) ?? emptyRows();
			entry.tokens += held.tokens;
			entry.traces += held.traces;
			rows.set(Number(version), entry);
		}
	}
}

async function sealEveryAccount(runtime: SecurityStateRuntime): Promise<SecurityStateReport> {
	const schema = assertSchemaName(runtime.schema);
	const users = qualifiedTableName(schema, "user");
	const counts = { sealed: 0, rekeyed: 0, refused: 0, unchanged: 0 };
	const refusedUserIds: string[] = [];
	for (let after = FIRST_ACCOUNT; ; ) {
		const ids = await nextAccountIds(runtime.driver, users, after);
		for (const userId of ids) {
			const outcome = await sealOneAccount(runtime, userId);
			if (outcome !== "gone") {
				counts[outcome] += 1;
			}
			if (outcome === "refused") {
				refusedUserIds.push(userId);
			}
		}
		const last = ids.at(-1);
		if (last === undefined || ids.length < ACCOUNT_BATCH) {
			break;
		}
		after = last;
	}
	const rows = new Map<number, { seals: number; tokens: number; traces: number }>();
	await rebindEveryTokenTable(runtime, rows);
	const seals = await sealRowsByKeyVersion(
		runtime.driver,
		qualifiedTableName(schema, "security_state"),
	);
	for (const [version, count] of seals) {
		const entry = rows.get(version) ?? emptyRows();
		entry.seals = count;
		rows.set(version, entry);
	}
	return {
		...counts,
		refusedUserIds,
		rowsByKeyVersion: Object.fromEntries([...rows].sort(([a], [b]) => a - b)),
	};
}

function highestFloorOf(reading: Extract<AnchorReading, { kind: "answered" }>): number {
	return reading.floors.reduce((highest, floor) => Math.max(highest, floor?.version ?? 0), 0);
}

function ratifiedStateOf(
	read: SecurityStateRead,
	seal: { readonly version: number; readonly sessionEpoch: number },
): SealedSecurityState {
	return {
		version: seal.version,
		sessionEpoch: seal.sessionEpoch,
		email: read.email,
		emailVerified: read.emailVerified,
		disabled: read.disabled,
		password: read.password !== null,
		passwordSetBySession: read.password?.setBySessionId ?? null,
		passwordResetRequired: read.passwordResetRequired,
		totp: read.totp === null ? "none" : read.totp.confirmed ? "confirmed" : "unconfirmed",
		passkeyCredentialIds: read.passkeys.map((passkey) => encodeBase64Url(passkey.credentialId)),
		identities: read.identities.map(({ provider, subject }) => ({ provider, subject })),
		recoveryCodeCount: read.recoveryCodes.length,
	};
}

interface Resealed {
	readonly read: SecurityStateRead;
	readonly version: number;
	readonly sessionEpoch: number;
	readonly digest: Uint8Array<ArrayBuffer>;
}

//a reseal confirms no generation a writer may have set and draws every one afresh (E-3523)
function generationsAfterReseal(stored: SealedGenerations, version: number): SealedGenerations {
	return {
		componentsVersion: version,
		sessionGeneration: drawGenerationOtherThan(stored.sessionGeneration),
		attemptGeneration: drawGenerationOtherThan(stored.attemptGeneration),
		attemptLast: null,
		tokenGenerations: {
			email_verify: drawGenerationOtherThan(stored.tokenGenerations.email_verify),
			password_reset: drawGenerationOtherThan(stored.tokenGenerations.password_reset),
			email_change: drawGenerationOtherThan(stored.tokenGenerations.email_change),
			magic_link: drawGenerationOtherThan(stored.tokenGenerations.magic_link),
		},
		tokenLast: null,
	};
}

async function writeResealedRow(
	tx: Driver,
	states: string,
	read: SecurityStateRead,
	seal: Omit<Resealed, "read"> & {
		readonly keyVersion: number;
		readonly generations: SealedGenerations;
	},
): Promise<void> {
	const stored = read.seal;
	const generations = [
		seal.generations.componentsVersion,
		seal.generations.sessionGeneration,
		seal.generations.attemptGeneration,
		seal.generations.tokenGenerations.email_verify,
		seal.generations.tokenGenerations.password_reset,
		seal.generations.tokenGenerations.email_change,
		seal.generations.tokenGenerations.magic_link,
	];
	const written =
		stored === null
			? await tx.query(
					`INSERT INTO ${states} (user_id, version, digest, key_version, session_epoch,
  components_version, session_generation, attempt_generation, email_verify_generation,
  password_reset_generation, email_change_generation, magic_link_generation)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (user_id) DO NOTHING RETURNING 1 AS written`,
					[
						read.userId,
						seal.version,
						seal.digest,
						seal.keyVersion,
						seal.sessionEpoch,
						...generations,
					],
				)
			: await tx.query(
					`UPDATE ${states}
SET version = $2, digest = $3, key_version = $4, session_epoch = $5, sealed_at = now(),
  components_version = $10, session_generation = $11, attempt_generation = $12,
  attempt_last = NULL, email_verify_generation = $13, password_reset_generation = $14,
  email_change_generation = $15, magic_link_generation = $16, token_last = NULL
WHERE user_id = $1 AND version = $6 AND digest = $7 AND key_version = $8 AND session_epoch = $9
RETURNING 1 AS written`,
					[
						read.userId,
						seal.version,
						seal.digest,
						seal.keyVersion,
						seal.sessionEpoch,
						stored.version,
						stored.digest,
						stored.keyVersion,
						stored.sessionEpoch,
						...generations,
					],
				);
	if (written.length !== 1) {
		throw new SecurityStateMaintenanceError("security_state_changed_during_reseal", read.userId);
	}
}

//a reseal checks nothing it seals and lands above both the stored version and every floor (S-INTEG-7)
async function resealUnderAccountLock(
	runtime: SecurityStateRuntime,
	userId: string,
	floor: number,
): Promise<Resealed> {
	const schema = assertSchemaName(runtime.schema);
	return inOneTransaction(runtime.driver, async (tx) => {
		await lockAccountRow(tx, schema, userId);
		const stored = await readSecurityState(tx, schema, userId);
		if (stored === null) {
			throw new SecurityStateMaintenanceError("security_state_account_missing", userId);
		}
		const base = Math.max(stored.seal?.version ?? 0, floor);
		if (base >= Number.MAX_SAFE_INTEGER) {
			throw new SecurityStateMaintenanceError("security_state_version_exhausted", userId);
		}
		const read =
			stored.seal === null
				? await rewriteEnvelopes(runtime, tx, actorOfMaintenance(userId), stored, "absent")
				: stored;
		const version = base + 1;
		const sessionEpoch = drawSessionEpochOtherThan(stored.seal?.sessionEpoch ?? 1);
		const generations = generationsAfterReseal(stored.seal ?? FIRST_GENERATIONS, version);
		const { keyVersion, digest } = await computeSeal(runtime.keys, {
			userId,
			version,
			sessionEpoch,
			...generations,
			...componentsAfter(read, {}),
		});
		await writeResealedRow(tx, qualifiedTableName(schema, "security_state"), read, {
			version,
			sessionEpoch,
			generations,
			keyVersion,
			digest,
		});
		return { read, version, sessionEpoch, digest };
	});
}

async function resealAccount(
	runtime: SecurityStateRuntime,
	log: MaintenanceLog,
	input: { readonly userId: string; readonly reason: string },
): Promise<SealedSecurityState> {
	const reason: unknown = input?.reason;
	if (typeof reason !== "string" || reason.trim() === "") {
		throw new SecurityStateMaintenanceError("security_state_reason_missing", null);
	}
	const userId: unknown = input.userId;
	if (typeof userId !== "string" || !isRowIdentifier(userId)) {
		throw new SecurityStateMaintenanceError("security_state_account_missing", null);
	}
	const reading = await consultAnchors(runtime.anchors, userId);
	if (reading.kind === "unavailable") {
		runtime.alarms.raise({ userId, occasion: "maintenance", reason: "anchor_unavailable" });
		throw new SecurityStateMaintenanceError("security_state_anchor_unavailable", userId);
	}
	const resealed = await resealUnderAccountLock(runtime, userId, highestFloorOf(reading)).catch(
		(error: unknown) => {
			if (!(error instanceof KeyError)) {
				throw error;
			}
			//a reseal repairs no envelope and refuses one it cannot open (E-3219)
			runtime.alarms.raise({
				userId,
				occasion: "maintenance",
				reason: "envelope_binding_mismatch",
			});
			throw new SecurityStateMaintenanceError("security_state_envelope_unreadable", userId);
		},
	);
	//a reseal is never silent and its reason is logged and not stored (S-INTEG-7)
	log("warn", "an administrator resealed an account's security state", {
		userId,
		reason,
		version: resealed.version,
	});
	await recordSealWithAnchors(
		runtime.anchors,
		{ userId, version: resealed.version, digest: encodeBase64Url(resealed.digest) },
		() => runtime.alarms.raise({ userId, occasion: "maintenance", reason: "anchor_unavailable" }),
	);
	return ratifiedStateOf(resealed.read, resealed);
}

/** the two operator calls of the security state, which no route reaches */
export interface SecurityStateMaintenance {
	sealSecurityState(): Promise<SecurityStateReport>;
	resealSecurityState(input: { userId: string; reason: string }): Promise<SealedSecurityState>;
}

export function createSecurityStateMaintenance(input: {
	readonly runtime: SecurityStateRuntime;
	readonly log: MaintenanceLog;
}): SecurityStateMaintenance {
	return {
		sealSecurityState: () => sealEveryAccount(input.runtime),
		resealSecurityState: (call) => resealAccount(input.runtime, input.log, call),
	};
}
