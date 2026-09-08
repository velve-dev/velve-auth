import type { Driver } from "../../db/driver.js";
import type { SessionConfig } from "../../session/config.js";
import type { SessionMetadataMode } from "../../session/metadata.js";
import {
	createSessionService,
	type IssuedSession,
	type ObservedRequest,
} from "../../session/service.js";
import type { SecondFactor } from "./repository.js";
import { createPendingAuthenticationService } from "./service.js";
import type { PendingToken } from "./token.js";

export interface SecondFactorCompletionOptions {
	readonly driver: Driver;
	readonly schema?: string;
	readonly session?: Partial<SessionConfig>;
	readonly sessionMetadata?: SessionMetadataMode;
}

export interface SecondFactorCompletion {
	complete(input: {
		readonly pendingToken: PendingToken;
		readonly factor: SecondFactor;
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
}

/**
 * S-FIX-1 for every path that finishes at a second factor. The row that carried the trust level so
 * far is the pending row, not a session, and it has to be gone in the same transaction that inserts
 * the session — otherwise a failure between the two leaves an intermediate state that has already
 * been spent, or a session whose pending row can be spent again.
 *
 * It lives beside the pending module rather than in the assembly because it is the composition the
 * factor features call, and neither of them can write it: it needs the pending service and the
 * session service bound to the same transaction, and each feature owns only one half of that.
 */
export function createSecondFactorCompletion(
	options: SecondFactorCompletionOptions,
): SecondFactorCompletion {
	const schema = options.schema ?? "velve";

	return {
		complete({ pendingToken, factor, observed }) {
			return options.driver.transaction(async (tx) => {
				const pending = createPendingAuthenticationService({ driver: tx, schema });
				const sessions = createSessionService({
					driver: tx,
					schema,
					...(options.session === undefined ? {} : { session: options.session }),
					...(options.sessionMetadata === undefined
						? {}
						: { sessionMetadata: options.sessionMetadata }),
				});

				const consumed = await pending.consume(pendingToken);
				return sessions.issue({
					userId: consumed.userId,
					factors: [...consumed.factorsCompleted, factor],
					observed,
				});
			});
		},
	};
}
