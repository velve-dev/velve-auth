import { addressOnly, type RouteServices } from "../auth/routes.js";
import { type AnyRoute, defineRoute, type ServerCallFields } from "../http/route.js";
import { object, oneOf } from "../http/validators.js";
import type { ProofOfWorkChallenge } from "./challenge.js";
import {
	ALWAYS_GUARDED_ROUTES,
	type ProofOfWorkRoute,
	SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES,
} from "./config.js";
import type { ProofOfWork } from "./gate.js";

/** hands out a challenge for one guarded route, present only while the proof of work is configured */
export interface ProofOfWorkNamespace {
	challenge(input: { route: ProofOfWorkRoute } & ServerCallFields): Promise<ProofOfWorkChallenge>;
}

/** the `proofOfWork` namespace, present at run time only where `proofOfWork` is configured */
export interface ProofOfWorkSurface {
	readonly proofOfWork: ProofOfWorkNamespace;
}

function challengeRoutesOf(services: RouteServices, proofOfWork: ProofOfWork) {
	//handing out a challenge stores nothing, so the route is a reading one (S-RATE-9)
	const challenge = defineRoute({
		name: "proofOfWork.challenge",
		method: "GET",
		path: "/proof-of-work/challenge",
		input: object({
			route: oneOf(...ALWAYS_GUARDED_ROUTES, ...SIGN_IN_ROUTES_GUARDED_AFTER_FAILURES),
		}),
		errors: ["invalid_input", "rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: addressOnly(services),
		handler: async (input): Promise<ProofOfWorkChallenge> => proofOfWork.issue(input.route),
	});

	return [challenge] as const;
}

export type ProofOfWorkRouteTable = ReturnType<typeof challengeRoutesOf>;

//without the proof of work configured its challenge route does not exist (E-3670)
export function proofOfWorkRoutes(
	services: RouteServices,
	proofOfWork: ProofOfWork | undefined,
): readonly AnyRoute[] {
	return proofOfWork === undefined ? [] : challengeRoutesOf(services, proofOfWork);
}
