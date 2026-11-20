import type { Driver } from "../db/driver.js";
import type { Clock } from "../http/environment.js";
import { ConcealedError } from "../http/error-map.js";
import type { FailureScope, ProofOfWorkGate } from "../http/proof-of-work.js";
import type { KeyProvider } from "../keys/provider.js";
import { accountFailureCounterKey, addressFailureCounterKey } from "../limit/bucket-key.js";
import { createFailureCounters } from "../limit/failure-counter.js";
import { createProofOfWorkChallenges, type ProofOfWorkChallenge } from "./challenge.js";
import {
	difficultyWithinBounds,
	failureThresholdWithinBounds,
	MOST_SIGN_IN_FAILURES_BEFORE_PROOF,
	type ProofOfWorkConfig,
	type ProofOfWorkRoute,
	SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES,
	type SignInRouteGuardedAfterFailures,
} from "./config.js";
import { createSpentChallenges } from "./spent.js";

/** the gate the pipeline asks, and the issuer the challenge route hands challenges out from */
export interface ProofOfWork extends ProofOfWorkGate {
	issue(route: ProofOfWorkRoute): Promise<ProofOfWorkChallenge>;
}

interface ProofOfWorkOptions {
	readonly config: ProofOfWorkConfig;
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly clock: Clock;
}

async function counterKeysOf(
	keys: KeyProvider,
	routeName: string,
	scope: FailureScope,
): Promise<readonly string[]> {
	const address = addressFailureCounterKey(routeName, scope.ipAddress);
	return scope.accountIdentifier === null
		? [address]
		: [address, await accountFailureCounterKey(keys, routeName, scope.accountIdentifier)];
}

function signInRouteNamed(routeName: string): SignInRouteGuardedAfterFailures {
	const named = SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES.find((route) => route === routeName);
	if (named === undefined) {
		throw new Error(
			`Route ${routeName} is not a sign-in route the proof of work counts failures on`,
		);
	}
	return named;
}

export function createProofOfWork(options: ProofOfWorkOptions): ProofOfWork {
	const challenges = createProofOfWorkChallenges(options.keys);
	const spent = createSpentChallenges({ driver: options.driver, schema: options.schema });
	const counters = createFailureCounters({
		driver: options.driver,
		schema: options.schema,
		ceiling: MOST_SIGN_IN_FAILURES_BEFORE_PROOF,
	});

	return {
		//the application's difficulty is asked on every issue and never once at construction (E-3662)
		issue: (route) =>
			challenges.issue({
				route,
				difficulty: difficultyWithinBounds(options.config.difficulty({ route })),
				now: options.clock.now(),
			}),

		async spend(routeName, presented) {
			const checked = await challenges.check({ route: routeName, presented });
			if (checked.outcome === "refused") {
				throw new ConcealedError(checked.reason);
			}
			const outcome = await spent.spend(checked.solution);
			if (outcome === "expired") {
				throw new ConcealedError("proof_of_work_expired");
			}
			if (outcome === "spent_before") {
				throw new ConcealedError("proof_of_work_spent");
			}
		},

		//only counters keyed like the rate buckets decide, so an unknown account asks as early (S-RATE-11)
		async isRequiredAfterFailures(routeName, scope) {
			const threshold = failureThresholdWithinBounds(
				options.config.signInFailuresBeforeProof({ route: signInRouteNamed(routeName) }),
			);
			const failures = await counters.highestOf(
				await counterKeysOf(options.keys, routeName, scope),
				options.clock.now(),
			);
			return failures >= threshold;
		},

		async recordFailure(routeName, scope) {
			await counters.record(
				await counterKeysOf(options.keys, routeName, scope),
				options.clock.now(),
			);
		},
	};
}
