import type { Driver } from "../../db/driver.js";
import type {
	IssueAuthorisation,
	SealVerification,
	SecurityStateSealing,
} from "../../db/repositories/session.js";
import type { KeyProvider } from "../../keys/provider.js";
import type { SessionConfig } from "../../session/config.js";
import type { SessionMetadataMode } from "../../session/metadata.js";
import {
	createSessionService,
	type IssuedSession,
	type ObservedRequest,
	type SessionIssuePath,
} from "../../session/service.js";
import type { TokenBindingRefusalReport } from "../../token/binding.js";
import type { SecondFactor } from "./repository.js";
import { createPendingAuthenticationService } from "./service.js";
import type { PendingToken } from "./token.js";

export interface SecondFactorCompletionOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly sealing: SecurityStateSealing;
	readonly schema?: string;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
	readonly sealVerifiesAfterMissedIssue?: SealVerification;
	readonly session?: Partial<SessionConfig>;
	readonly sessionMetadata?: SessionMetadataMode;
	/** told the owner of the consumed pending row before the account lock is taken, and may refuse by throwing */
	readonly beforeLockingTheOwnerOf?: (ownerId: string) => Promise<void>;
}

export interface SecondFactorCompletion {
	complete(input: {
		readonly pendingToken: PendingToken;
		readonly factor: SecondFactor;
		/** the seal the factor check read, whose epoch is the one the pending row stores */
		readonly authorisedBy: IssueAuthorisation;
		readonly presentedSessionToken: string | null;
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
}

//a missed issue answers as the factor that completed the sign-in fails (S-INTEG-5)
const SECOND_FACTOR_PATH: Readonly<Record<SecondFactor, SessionIssuePath>> = {
	totp: "totp_second_factor",
	webauthn: "passkey_second_factor",
	recovery: "recovery_second_factor",
};

//the pending row must go in the same transaction that inserts the session (S-FIX-1)
export function createSecondFactorCompletion(
	options: SecondFactorCompletionOptions,
): SecondFactorCompletion {
	const schema = options.schema ?? "velve";

	return {
		complete({ pendingToken, factor, authorisedBy, presentedSessionToken, observed }) {
			return options.driver.transaction(async (tx) => {
				const report =
					options.reportTokenBindingRefusal === undefined
						? {}
						: { reportTokenBindingRefusal: options.reportTokenBindingRefusal };
				const pending = createPendingAuthenticationService({
					driver: tx,
					keys: options.keys,
					schema,
					...report,
				});
				const sessions = createSessionService({
					driver: tx,
					keys: options.keys,
					sealing: options.sealing,
					schema,
					...report,
					...(options.sealVerifiesAfterMissedIssue === undefined
						? {}
						: { sealVerifiesAfterMissedIssue: options.sealVerifiesAfterMissedIssue }),
					...(options.session === undefined ? {} : { session: options.session }),
					...(options.sessionMetadata === undefined
						? {}
						: { sessionMetadata: options.sessionMetadata }),
				});

				const consumed = await pending.consume(pendingToken);
				//the anchor is asked about the consumed row's owner in this transaction before the account lock (E-3265)
				await options.beforeLockingTheOwnerOf?.(consumed.userId);
				return sessions.issueReplacingPresented({
					completes: SECOND_FACTOR_PATH[factor],
					authorisedBy,
					presentedToken: presentedSessionToken,
					userId: consumed.userId,
					factors: [...consumed.factorsCompleted, factor],
					observed,
				});
			});
		},
	};
}
