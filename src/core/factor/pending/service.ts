import type { Driver } from "../../db/driver.js";
import type {
	AuthenticationFactor,
	PendingAuthentication,
	ResolvedPendingAuthentication,
} from "../../http/caller.js";
import { ConcealedError, type ConcealedReason } from "../../http/error-map.js";
import { equalsInConstantTime } from "../../keys/constant-time.js";
import type { KeyProvider } from "../../keys/provider.js";
import {
	bindToken,
	checkTokenBinding,
	decodedOrNull,
	reportRefusedTokenRow,
	type StoredTokenMac,
	type TokenBinding,
	type TokenBindingRefusal,
	type TokenBindingRefusalReport,
	type TokenBindingVerdict,
} from "../../token/binding.js";
import { pendingBinding } from "./binding.js";
import { type BookedAttempt, lendBooking } from "./booking.js";
import {
	createPendingAuthenticationRepository,
	type PendingAuthenticationRepository,
	type PendingAuthenticationWithOwner,
	type PendingCandidate,
	type SecondFactor,
} from "./repository.js";
import { createPendingToken, hashPendingToken, type PendingToken } from "./token.js";

//the pending state lives exactly as long as its cookie (S-COOKIE-3)
export const PENDING_LIFETIME_IN_SECONDS = 300;

//the five attempts are counted per pending flow and not per factor (E-471)
export const MAXIMUM_PENDING_ATTEMPTS = 5;

//the routes reading the pending cookie are one list so a fifth cannot slip in (S-CACHE-4)
export const PENDING_CALLER_ROUTES = [
	"factor.totp.verify",
	"factor.webauthn.authenticate.start",
	"factor.webauthn.authenticate.finish",
	"factor.recovery.verify",
] as const;

export type PendingCallerRoute = (typeof PENDING_CALLER_ROUTES)[number];

export interface IssuedPendingAuthentication {
	readonly token: PendingToken;
	readonly pending: PendingAuthentication;
}

/** the resolved intermediate state, which is not a session and mints no `Actor` */
export type PendingResolution = ResolvedPendingAuthentication;

export interface ConsumedPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
	/** the epoch the row was created under, which the session the completion issues must still find */
	readonly sessionEpoch: number;
}

export type FailedAttempt =
	| { readonly outcome: "attempts_remain"; readonly attemptsRemaining: number }
	| { readonly outcome: "exhausted" };

/** what sealing a booked attempt found, a refusal being a broken state the factor check answers */
export type SealedAttempt = "booked" | "missed" | "written_back" | "overtaken" | "refused";

/** books an attempt over the pending row and then moves the account's attempt generation under its lock */
export type AttemptSeal = (input: {
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	/** the generation the booked row binds before the booking */
	readonly from: number;
	/** the compare-and-set on the pending row, taken before the account lock, binding the generation the account moves to */
	readonly book: (tx: Driver, to: number) => Promise<boolean>;
}) => Promise<SealedAttempt>;

export interface PendingAuthenticationServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema?: string;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
	//a booking moves a generation under the seal and a row written back binds one the account has left (E-3519)
	readonly attemptSeal?: AttemptSeal;
}

/** the second factors a verified read holds, which the pending row must still find when it is written */
export interface OfferedFactors {
	readonly factors: readonly SecondFactor[];
	readonly refusal: ConcealedReason;
}

export interface PendingAuthenticationService {
	begin(input: {
		readonly userId: string;
		readonly factorsCompleted: readonly AuthenticationFactor[];
		/** the epoch the first factor's check read; the account's current one where not given */
		readonly sessionEpoch?: number;
		/** the second factors the first factor's check read, and what a sign-in that loses one answers */
		readonly offered?: OfferedFactors;
	}): Promise<IssuedPendingAuthentication>;
	resolve(token: PendingToken): Promise<PendingResolution | null>;
	consume(token: PendingToken): Promise<ConsumedPendingAuthentication>;
	cancel(input: { readonly token: PendingToken }): Promise<void>;
}

interface CheckedPendingRow extends StoredTokenMac {
	readonly userId: string;
	readonly factorNames: readonly string[];
	readonly attempts: number;
	readonly sessionEpoch: number;
	readonly attemptGeneration: number;
	/** whether the account had a seal row when the row was read, which only then moves a generation */
	readonly accountSealed: boolean;
}

const FIRST_ATTEMPT_GENERATION = 1;

function attemptsRemainingAfter(attempts: number): number {
	return Math.max(MAXIMUM_PENDING_ATTEMPTS - attempts, 0);
}

const FIRST_ATTEMPT_COUNT = 0;

function budgetIsSpentBy(attempts: number): boolean {
	return attempts >= MAXIMUM_PENDING_ATTEMPTS;
}

export function createPendingAuthenticationService(
	options: PendingAuthenticationServiceOptions,
): PendingAuthenticationService {
	const repository: PendingAuthenticationRepository = repositoryOn(options.driver);

	function repositoryOn(driver: Driver): PendingAuthenticationRepository {
		return createPendingAuthenticationRepository({ driver, schema: options.schema ?? "velve" });
	}

	//a statement whose miss is read as a race must run at read committed whatever the database default (E-3481)
	function inTransaction<T>(
		work: (store: PendingAuthenticationRepository) => Promise<T>,
	): Promise<T> {
		return options.driver.transaction((tx) => work(repositoryOn(tx)));
	}

	function bindingOf(tokenHash: Uint8Array, candidate: PendingCandidate<unknown>): TokenBinding {
		return pendingBinding(candidate.userId, tokenHash, candidate.storedFactorNames ?? [], {
			attempts: candidate.attempts,
			sessionEpoch: candidate.sessionEpoch,
			attemptGeneration: candidate.attemptGeneration,
		});
	}

	//a pending row a mass revocation has overtaken is no row, and no writer's doing (E-3484)
	function isOvertaken(candidate: PendingCandidate<unknown>): boolean {
		return candidate.sessionEpoch !== candidate.currentEpoch;
	}

	function generationLeftBehind(candidate: PendingCandidate<unknown>): boolean {
		return (
			candidate.attemptGeneration !==
			(candidate.currentAttemptGeneration ?? FIRST_ATTEMPT_GENERATION)
		);
	}

	//a row whose own booking moved the generation past it was written back, a sibling's booking only overtook it (E-3519)
	function wasWrittenBack(tokenHash: Uint8Array, candidate: PendingCandidate<unknown>): boolean {
		return (
			candidate.attemptLast !== null &&
			equalsInConstantTime(new Uint8Array(candidate.attemptLast), new Uint8Array(tokenHash))
		);
	}

	//a library row overtaken by a revocation or by the account's generation is answered as missing (E-3519)
	function supersededLibraryRow(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<unknown>,
		verdict: TokenBindingVerdict,
	): boolean {
		if (verdict !== "valid") {
			return false;
		}
		if (!isOvertaken(candidate) && generationLeftBehind(candidate)) {
			if (wasWrittenBack(tokenHash, candidate)) {
				reportRefusal(candidate.userId, "mismatch");
			}
			return true;
		}
		return isOvertaken(candidate);
	}

	async function verdictOf(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<unknown>,
	): Promise<TokenBindingVerdict> {
		return candidate.storedFactorNames === null
			? "mismatch"
			: checkTokenBinding(options.keys, bindingOf(tokenHash, candidate), candidate);
	}

	function reportRefusal(userId: string, verdict: TokenBindingRefusal["verdict"]): void {
		reportRefusedTokenRow(options.reportTokenBindingRefusal, {
			userId,
			occasion: "factor_check",
			verdict,
		});
	}

	//a row the library did not write is answered as no row before anything in it is read (S-INTEG-9)
	async function verified<Decoded>(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<Decoded> | null,
	): Promise<{ readonly binding: TokenBinding; readonly decoded: Decoded } | null> {
		if (candidate === null) {
			return null;
		}
		const verdict = await verdictOf(tokenHash, candidate);
		if (supersededLibraryRow(tokenHash, candidate, verdict)) {
			return null;
		}
		const decoded = verdict === "valid" ? decodedOrNull(() => candidate.decode()) : null;
		if (decoded === null) {
			reportRefusal(candidate.userId, verdict === "valid" ? "mismatch" : verdict);
			return null;
		}
		return { binding: bindingOf(tokenHash, candidate), decoded };
	}

	function checkedRow(candidate: PendingCandidate<unknown>): CheckedPendingRow {
		return {
			userId: candidate.userId,
			factorNames: candidate.storedFactorNames ?? [],
			attempts: candidate.attempts,
			sessionEpoch: candidate.sessionEpoch,
			attemptGeneration: candidate.attemptGeneration,
			accountSealed: candidate.currentAttemptGeneration !== null,
			tokenMac: candidate.tokenMac,
			tokenMacKeyVersion: candidate.tokenMacKeyVersion,
		};
	}

	//a booking must be pinned to the row this check passed, which only a booking rebinds (E-3149)
	async function checkedRowOf(tokenHash: Uint8Array): Promise<{
		readonly row: CheckedPendingRow;
		readonly found: PendingAuthenticationWithOwner;
	} | null> {
		const candidate = await repository.findPendingAuthenticationByTokenHash(tokenHash);
		const checked = await verified(tokenHash, candidate);
		if (checked === null || candidate === null) {
			return null;
		}
		return { row: checkedRow(candidate), found: checked.decoded };
	}

	//a missed booking must tell a concurrent attempt from a writer (E-3140)
	async function afterMissedBooking(
		tokenHash: Uint8Array,
		pinned: CheckedPendingRow,
	): Promise<CheckedPendingRow | "missing"> {
		const reread = await inTransaction((store) =>
			store.findPendingAuthenticationByTokenHash(tokenHash),
		);
		if (reread === null) {
			return "missing";
		}
		const verdict = await verdictOf(tokenHash, reread);
		const advanced =
			reread.attempts > pinned.attempts ||
			(reread.attempts === pinned.attempts &&
				reread.tokenMacKeyVersion > pinned.tokenMacKeyVersion);
		if (supersededLibraryRow(tokenHash, reread, verdict)) {
			return "missing";
		}
		if (verdict !== "valid" || !advanced) {
			reportRefusal(reread.userId, verdict === "valid" ? "mismatch" : verdict);
			return "missing";
		}
		return checkedRow(reread);
	}

	async function exhaust(tokenHash: Uint8Array): Promise<{ readonly outcome: "exhausted" }> {
		await repository.deletePendingAuthenticationByTokenHash(tokenHash);
		return { outcome: "exhausted" };
	}

	async function bookedUnder(
		tokenHash: Uint8Array,
		row: CheckedPendingRow,
		attemptGeneration: number,
	): Promise<StoredTokenMac & { readonly attemptGeneration: number }> {
		const mac = await bindToken(
			options.keys,
			pendingBinding(row.userId, tokenHash, row.factorNames, {
				attempts: row.attempts + 1,
				sessionEpoch: row.sessionEpoch,
				attemptGeneration,
			}),
		);
		return { ...mac, attemptGeneration };
	}

	function bookedWithoutASeal(tokenHash: Uint8Array, row: CheckedPendingRow): Promise<boolean> {
		return inTransaction(async (store) =>
			store.bookAttempt({
				tokenHash,
				checked: row,
				next: await bookedUnder(tokenHash, row, row.attemptGeneration),
			}),
		);
	}

	async function bookedWithoutASealOutcome(
		tokenHash: Uint8Array,
		row: CheckedPendingRow,
	): Promise<"booked" | "missed"> {
		return (await bookedWithoutASeal(tokenHash, row)) ? "booked" : "missed";
	}

	//a booking under a broken seal is still counted and the factor check answers the broken state (S-INTEG-5)
	async function bookedOver(
		tokenHash: Uint8Array,
		row: CheckedPendingRow,
	): Promise<"booked" | "missed" | "missing"> {
		if (options.attemptSeal === undefined || !row.accountSealed) {
			return bookedWithoutASealOutcome(tokenHash, row);
		}
		const sealed = await options.attemptSeal({
			userId: row.userId,
			tokenHash,
			from: row.attemptGeneration,
			book: async (tx, to) =>
				repositoryOn(tx).bookAttempt({
					tokenHash,
					checked: row,
					next: await bookedUnder(tokenHash, row, to),
				}),
		});
		if (sealed === "written_back") {
			reportRefusal(row.userId, "mismatch");
		}
		if (sealed === "refused") {
			return bookedWithoutASealOutcome(tokenHash, row);
		}
		return sealed === "booked" || sealed === "missed" ? sealed : "missing";
	}

	function bookingOf(
		tokenHash: Uint8Array,
		resolution: PendingResolution,
		attempts: number,
	): BookedAttempt {
		return {
			outcome: "booked",
			resolution,
			failed: async () =>
				budgetIsSpentBy(attempts)
					? exhaust(tokenHash)
					: { outcome: "attempts_remain", attemptsRemaining: attemptsRemainingAfter(attempts) },
		};
	}

	//a retry follows only a row that advanced in attempts within the budget or in key version within the ring (E-3140)
	async function bookFrom(
		tokenHash: Uint8Array,
		resolution: PendingResolution,
		checked: CheckedPendingRow,
	): Promise<BookedAttempt> {
		let row: CheckedPendingRow | "missing" = checked;
		while (row !== "missing") {
			if (budgetIsSpentBy(row.attempts)) {
				return { outcome: "exhausted" };
			}
			const booked = await bookedOver(tokenHash, row);
			if (booked === "booked") {
				return bookingOf(tokenHash, resolution, row.attempts + 1);
			}
			row = booked === "missing" ? "missing" : await afterMissedBooking(tokenHash, row);
		}
		return { outcome: "missing" };
	}

	//no factor is evaluated before its attempt is counted (E-3140)
	async function book(token: PendingToken): Promise<BookedAttempt> {
		const tokenHash = hashPendingToken(token);
		const checked = await checkedRowOf(tokenHash);
		const resolution = checked === null ? null : resolutionOf(checked.found);
		if (checked === null || resolution === null) {
			return { outcome: "missing" };
		}
		return bookFrom(tokenHash, resolution, checked.row);
	}

	//a disabled account answers as an unknown pending state, not with the disabled code
	function resolutionOf(found: PendingAuthenticationWithOwner): PendingResolution | null {
		if (found.userDisabledAt !== null) {
			return null;
		}
		return {
			userId: found.userId,
			pending: {
				factorsCompleted: found.factorsCompleted,
				availableFactors: found.availableFactors,
				attemptsRemaining: attemptsRemainingAfter(found.attempts),
				expiresAt: found.expiresAt,
			},
			observedAt: found.observedAt,
		};
	}

	//a factor the check read and the insert no longer finds was removed past the seal (S-INTEG-4)
	async function refuseAFactorGoneSinceTheCheck(
		userId: string,
		tokenHash: Uint8Array,
		offered: OfferedFactors,
		available: readonly SecondFactor[],
	): Promise<void> {
		if (offered.factors.every((factor) => available.includes(factor))) {
			return;
		}
		await repository.deletePendingAuthenticationByTokenHash(tokenHash);
		options.reportTokenBindingRefusal?.({
			userId,
			occasion: "sign_in",
			reason: "seal_mismatch",
			verdict: "mismatch",
		});
		throw new ConcealedError(offered.refusal);
	}

	const service: PendingAuthenticationService = {
		//the factors on offer are the account's state so the write reads them itself (E-735)
		async begin({ userId, factorsCompleted, sessionEpoch, offered }) {
			const token = createPendingToken();
			const tokenHash = hashPendingToken(token);
			const storedFactors = factorsCompleted.filter(
				(factor, index) => factorsCompleted.indexOf(factor) === index,
			);
			const account = await repository.accountStateOf({ userId });
			const boundEpoch = sessionEpoch ?? account.sessionEpoch;
			const attemptGeneration = account.attemptGeneration ?? FIRST_ATTEMPT_GENERATION;
			const stored = await repository.insertPendingAuthentication({
				userId,
				tokenHash,
				factorsCompleted: storedFactors,
				lifetimeInSeconds: PENDING_LIFETIME_IN_SECONDS,
				sessionEpoch: boundEpoch,
				attemptGeneration,
				...(await bindToken(
					options.keys,
					pendingBinding(userId, tokenHash, storedFactors, {
						attempts: FIRST_ATTEMPT_COUNT,
						sessionEpoch: boundEpoch,
						attemptGeneration,
					}),
				)),
			});
			if (offered !== undefined) {
				await refuseAFactorGoneSinceTheCheck(userId, tokenHash, offered, stored.availableFactors);
			}
			return {
				token,
				pending: {
					factorsCompleted: stored.factorsCompleted,
					availableFactors: offered?.factors ?? stored.availableFactors,
					attemptsRemaining: attemptsRemainingAfter(stored.attempts),
					expiresAt: stored.expiresAt,
				},
			};
		},

		async resolve(token) {
			const checked = await checkedRowOf(hashPendingToken(token));
			return checked === null ? null : resolutionOf(checked.found);
		},

		//the removal is the check so two requests with one token cannot both pass
		async consume(token) {
			const tokenHash = hashPendingToken(token);
			const candidate = await repository.deletePendingAuthenticationByTokenHash(tokenHash);
			const removed = await verified(tokenHash, candidate);
			if (removed === null || candidate === null) {
				throw new ConcealedError("pending_consumed");
			}
			return { ...removed.decoded, sessionEpoch: candidate.sessionEpoch };
		},

		async cancel({ token }) {
			await repository.deletePendingAuthenticationByTokenHash(hashPendingToken(token));
		},
	};
	lendBooking(service, book);
	return service;
}
