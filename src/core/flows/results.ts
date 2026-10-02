import type { IdentityFields, SignInLookup } from "../auth/config.js";
import type { SignInResult, SignUpResult } from "../auth/results.js";
import type { User } from "../auth/user.js";
import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { Session } from "../http/caller.js";
import type { ServerCallFields } from "../http/route.js";
import type { SessionToken } from "../session/token.js";

/** the result of writing a password */
export interface SetPasswordResult {
	readonly sessionToken: SessionToken;
	readonly session: Session;
	/** how many sessions were revoked, which for a reset is every session the account had */
	readonly revokedOtherSessionsCount: number;
}

/** what the two redeeming `/email/*` routes answer with, the account and nothing else */
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

/** the password routes that need an address, absent in mode `username` */
export interface MailedPasswordNamespace {
	requestReset(input: { email: string } & ServerCallFields): Promise<void>;
	redeemReset(
		input: { token: string; newPassword: string } & ServerCallFields,
	): Promise<SetPasswordResult>;
}

/** the way back into an account that has no address, present in every mode */
export interface RecoveryPasswordNamespace<M extends IdentityMode> {
	redeemResetWithRecoveryCode(
		input: SignInLookup<M> & { recoveryCode: string; newPassword: string } & ServerCallFields,
	): Promise<SetPasswordResult>;
}
