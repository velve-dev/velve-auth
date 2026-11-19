import type { OneTimeTokenRepository, ReadOneTimeToken } from "../db/repositories/token.js";
import { equalsInConstantTime } from "../keys/constant-time.js";
import type { KeyProvider } from "../keys/provider.js";
import { FIRST_GENERATIONS } from "../security-state/encoding.js";
import type { SecurityStateRead } from "../security-state/read.js";
import { checkAccount, type SecurityStateRuntime } from "../security-state/runtime.js";
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
		const check = await checkAccount(options.securityState, userId, OCCASION);
		if (check.kind !== "usable") {
			return null;
		}
		const answersAsRedemptionWould =
			addressStillTheAccounts(options, userId, row, check.read) &&
			generationStillTheAccounts(options, userId, row, check.read, tokenSha256) &&
			!check.read.disabled;
		return answersAsRedemptionWould ? { userId, purpose: row.purpose } : null;
	};
}
