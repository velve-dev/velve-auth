import type { OneTimeTokenRepository, ReadOneTimeToken } from "../db/repositories/token.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import type { KeyProvider } from "../keys/provider.js";
import type { SecurityStateAlarmReason } from "../security-state/alarm.js";
import { compareWithAnchors, consultAnchors } from "../security-state/anchor.js";
import { FIRST_GENERATIONS } from "../security-state/encoding.js";
import {
	checkSecurityState,
	readSecurityState,
	type SecurityStateRead,
} from "../security-state/read.js";
import type { SecurityStateRuntime } from "../security-state/runtime.js";
import {
	checkTokenBinding,
	reportBrokenState,
	reportRefusedTokenRow,
	type TokenBindingRefusalReport,
} from "./binding.js";
import { tokenGenerationIn } from "./one-time-token.js";
import { ONE_TIME_TOKEN_PURPOSES, type OneTimeTokenPurpose } from "./purpose.js";
import { hashSecretToken, toSecretToken } from "./secret-token.js";

/** the account and the purpose a one-time token names, read without spending the token */
export interface ResolvedOneTimeToken {
	readonly userId: string;
	readonly purpose: OneTimeTokenPurpose;
}

interface OneTimeTokenResolutionOptions {
	readonly repository: OneTimeTokenRepository;
	readonly keys: KeyProvider;
	readonly securityState: SecurityStateRuntime;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

const ACCOUNT_ADDRESS = "accountEmail";

//a resolve reports what a redemption of the same token would report (E-3693)
const OCCASION = "token_redemption";

async function libraryWrote(
	options: OneTimeTokenResolutionOptions,
	row: ReadOneTimeToken,
	tokenSha256: Uint8Array,
): Promise<boolean> {
	const verdict =
		row.storedPayload === null
			? "mismatch"
			: await checkTokenBinding(
					options.keys,
					{
						purpose: row.purpose,
						ownerId: row.userId,
						tokenSha256,
						content: { payload: row.storedPayload.payload },
					},
					row,
				);
	if (verdict !== "valid") {
		reportRefusedTokenRow(options.reportTokenBindingRefusal, {
			userId: row.userId,
			occasion: OCCASION,
			verdict,
		});
	}
	return verdict === "valid";
}

function brokenReasonOf(
	verdict: Awaited<ReturnType<typeof checkSecurityState>>["verdict"],
	anchorVerdict: ReturnType<typeof compareWithAnchors>,
): SecurityStateAlarmReason | null {
	if (verdict !== "valid" && verdict !== "unsealed") {
		return verdict;
	}
	return anchorVerdict === "version_below_anchor" ||
		anchorVerdict === "anchor_mismatch" ||
		anchorVerdict === "anchor_unavailable"
		? anchorVerdict
		: null;
}

//the seal is verified against the anchors without recording it with one that is behind (E-3696)
async function verifiedReadOf(
	runtime: SecurityStateRuntime,
	userId: string,
): Promise<SecurityStateRead | null> {
	const anchorReading = await consultAnchors(runtime.anchors, userId);
	const read = await readSecurityState(runtime.driver, runtime.schema, userId);
	if (read === null) {
		return null;
	}
	const { verdict } = await checkSecurityState(runtime.keys, read, runtime.sealing);
	const broken = brokenReasonOf(verdict, compareWithAnchors(read.seal, anchorReading));
	if (broken !== null) {
		runtime.alarms.raise({ userId, occasion: OCCASION, reason: broken });
		return null;
	}
	return read;
}

//the address the link was mailed to must still be the sealed one as a redemption demands (S-INTEG-9)
function addressStillTheAccounts(
	options: OneTimeTokenResolutionOptions,
	userId: string,
	row: ReadOneTimeToken,
	read: SecurityStateRead,
): boolean {
	const bound = row.storedPayload?.payload?.[ACCOUNT_ADDRESS];
	if (bound !== undefined && bound === read.email) {
		return true;
	}
	reportBrokenState(options.reportTokenBindingRefusal, {
		userId,
		occasion: OCCASION,
		reason: "seal_mismatch",
	});
	return false;
}

//a link that binds a generation the account has left is answered as a spent one (S-INTEG-9)
function generationStillTheAccounts(
	options: OneTimeTokenResolutionOptions,
	userId: string,
	row: ReadOneTimeToken,
	read: SecurityStateRead,
	tokenSha256: Uint8Array,
): boolean {
	const current = (read.seal ?? FIRST_GENERATIONS).tokenGenerations[row.purpose];
	if (tokenGenerationIn(row.storedPayload?.payload ?? null) === current) {
		return true;
	}
	const last = read.seal?.tokenLast ?? null;
	//a link a later redemption overtook is no writer's doing and raises no alarm
	if (last !== null && equalsInConstantTime(new Uint8Array(last), new Uint8Array(tokenSha256))) {
		reportRefusedTokenRow(options.reportTokenBindingRefusal, {
			userId,
			occasion: OCCASION,
			verdict: "mismatch",
		});
	}
	return false;
}

//a resolve must answer null wherever a redemption would answer invalid_token and must write nothing (S-TOKEN-7)
export function createOneTimeTokenResolution(
	options: OneTimeTokenResolutionOptions,
): (token: unknown) => Promise<ResolvedOneTimeToken | null> {
	return async (token) => {
		if (typeof token !== "string") {
			return null;
		}
		const tokenSha256 = hashSecretToken(toSecretToken(token));
		const row = await options.repository.readOneTimeToken({
			tokenSha256,
			purposes: ONE_TIME_TOKEN_PURPOSES,
		});
		if (row === null || !(await libraryWrote(options, row, tokenSha256))) {
			return null;
		}
		const { userId } = row;
		if (userId === null) {
			return null;
		}
		const read = await verifiedReadOf(options.securityState, userId);
		if (read === null) {
			return null;
		}
		const answersAsRedemptionWould =
			addressStillTheAccounts(options, userId, row, read) &&
			generationStillTheAccounts(options, userId, row, read, tokenSha256) &&
			!read.disabled;
		return answersAsRedemptionWould ? { userId, purpose: row.purpose } : null;
	};
}
