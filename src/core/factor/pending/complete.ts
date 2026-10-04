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
		readonly presentedSessionToken: string | null;
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
}

//the pending row must go in the same transaction that inserts the session (S-FIX-1)
export function createSecondFactorCompletion(
	options: SecondFactorCompletionOptions,
): SecondFactorCompletion {
	const schema = options.schema ?? "velve";

	return {
		complete({ pendingToken, factor, presentedSessionToken, observed }) {
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
				return sessions.issueReplacingPresented({
					presentedToken: presentedSessionToken,
					userId: consumed.userId,
					factors: [...consumed.factorsCompleted, factor],
					observed,
				});
			});
		},
	};
}
