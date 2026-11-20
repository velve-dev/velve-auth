import type { VelveErrorCode } from "./error-map.js";
import type { RouteMetadata } from "./route.js";

/** which failure counters decide whether a sign-in asks for a proof */
export type FailureCounterScope = "address" | "address_and_account";

/** how a core route asks for a proof of work, on every call or once its failures reach the threshold */
export type ProofOfWorkGuard =
	| { readonly when: "always" }
	| {
			readonly when: "after_failures";
			readonly counters: FailureCounterScope;
			readonly failures: readonly VelveErrorCode[];
	  };

/** whose failures a sign-in is counted against */
export interface FailureScope {
	readonly ipAddress: string | null;
	readonly accountIdentifier: string | null;
}

/** what the pipeline asks of a configured proof of work */
export interface ProofOfWorkGate {
	spend(routeName: string, presented: string | null): Promise<void>;
	isRequiredAfterFailures(routeName: string, scope: FailureScope): Promise<boolean>;
	recordFailure(routeName: string, scope: FailureScope): Promise<void>;
}

/** a solution as a direct server call passes it, the challenge as handed out and the nonce found for it */
export interface ProofOfWorkSolution {
	readonly challenge: string;
	readonly nonce: number;
}

const guards = new WeakMap<RouteMetadata, ProofOfWorkGuard>();

//a guard is held against the route object so no plugin declaration can name or drop one (E-3669)
export function guardedByProofOfWork(route: RouteMetadata, guard: ProofOfWorkGuard): void {
	guards.set(route, guard);
}

export function proofOfWorkGuardOf(route: RouteMetadata): ProofOfWorkGuard | null {
	return guards.get(route) ?? null;
}
