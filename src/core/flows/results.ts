import type { IdentityFields, SignInLookup } from "../auth/config.js";
import type { SignInResult, SignUpResult } from "../auth/results.js";
import type { User } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Session } from "../http/caller.js";
import type { ServerCallFields } from "../http/route.js";
import type { SessionToken } from "../session/token.js";

/**
 * 3.15 B.4. It is declared here because the two routes that produce it today are the two mailed
 * resets; `password.set` and `password.change` produce the same type and are not written yet, so
 * the declaration moves to a password module when they are (E-604).
 */
export interface SetPasswordResult {
	readonly sessionToken: SessionToken;
	readonly session: Session;
	/**
	 * Every session the account had when the password was written. A reset has no calling session
	 * to keep, so nothing is subtracted from the count (E-611).
	 */
	readonly revokedOtherSessionsCount: number;
}

/** 3.15 D.3: the two redeeming `/email/*` rows answer with the account and nothing else. */
export interface ChangedUser {
	readonly user: User;
}

export interface SignUpNamespace<M extends IdentityMode> {
	withPassword(
		input: IdentityFields<M> & { password: string } & ServerCallFields,
	): Promise<SignUpResult>;
	withoutPassword(input: IdentityFields<M> & ServerCallFields): Promise<SignUpResult>;
}

export interface MagicLinkNamespace {
	request(input: { email: string } & ServerCallFields): Promise<void>;
	redeem(input: { token: string } & ServerCallFields): Promise<SignInResult>;
}

export interface EmailNamespace {
	requestVerification(input: ServerCallFields): Promise<void>;
	redeemVerification(input: { token: string } & ServerCallFields): Promise<ChangedUser>;
	requestChange(input: { newEmail: string } & ServerCallFields): Promise<void>;
	redeemChange(input: { token: string } & ServerCallFields): Promise<ChangedUser>;
}

/** The half of 3.15 B.4 that needs an address, and therefore does not exist in mode `username`. */
export interface MailedPasswordNamespace {
	requestReset(input: { email: string } & ServerCallFields): Promise<void>;
	redeemReset(
		input: { token: string; newPassword: string } & ServerCallFields,
	): Promise<SetPasswordResult>;
}

/** 3.4: the way back into an account that has no address, and therefore present in every mode. */
export interface RecoveryPasswordNamespace<M extends IdentityMode> {
	redeemResetWithRecoveryCode(
		input: SignInLookup<M> & { recoveryCode: string; newPassword: string } & ServerCallFields,
	): Promise<SetPasswordResult>;
}
