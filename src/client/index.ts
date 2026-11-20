import type { AnyRoute } from "../core/http/route.js";
import {
	createProofOfWorkCalls,
	createProofOfWorkSolver,
	type ProofOfWorkCalls,
	type ProofOfWorkPreparation,
} from "./proof-of-work.js";
import { type ClientRoute, VELVE_CLIENT_ROUTES, type VelveRouteTable } from "./routes.js";
import type { ClientSurface } from "./surface.js";
import { createRouteCall, type VelveClientOptions } from "./transport.js";

export { VelveError, type VelveErrorCode } from "../core/http/error-map.js";
export type { ProofOfWorkPreparation } from "./proof-of-work.js";
export type { ProofOfWorkTask, ProofOfWorkWorker } from "./proof-of-work-solver.js";
export {
	unwrap,
	type VelveFailure,
	type VelveResult,
	VelveTransportError,
} from "./result.js";
export { type ClientRoute, VELVE_CLIENT_ROUTES, type VelveRouteTable } from "./routes.js";
export type { ClientMethodOf, ClientSurface } from "./surface.js";
export type { VelveClientOptions } from "./transport.js";

/** the route table an instance declares, read as the library's own table where it was widened */
type RouteTableOf<Auth extends { readonly routes: readonly AnyRoute[] }> =
	number extends Auth["routes"]["length"] ? VelveRouteTable : Auth["routes"];

function nestRouteCalls(
	routes: readonly ClientRoute[],
	call: ProofOfWorkCalls["call"],
): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	for (const route of routes) {
		const segments = route.name.split(".");
		const leaf = segments.pop() ?? "";
		let node = root;
		for (const segment of segments) {
			node[segment] ??= {};
			node = node[segment] as Record<string, unknown>;
		}
		node[leaf] = (input: unknown) => call(route, input);
	}
	return root;
}

/** the client's surface, where `proofOfWork` also prepares a solution ahead of the call that needs it */
export type VelveClient<Routes extends readonly AnyRoute[]> = ClientSurface<Routes> & {
	readonly proofOfWork: ProofOfWorkPreparation;
};

function challengeRouteOf(routes: readonly ClientRoute[]): ClientRoute {
	const challenge = routes.find((route) => route.name === "proofOfWork.challenge");
	if (challenge === undefined) {
		throw new TypeError("The client route table carries no proofOfWork.challenge row");
	}
	return challenge;
}

/** builds a client whose every call takes its method and path from its own route row */
export function createVelveClient<
	Auth extends { readonly routes: readonly AnyRoute[] } = { readonly routes: VelveRouteTable },
>(options: VelveClientOptions): VelveClient<RouteTableOf<Auth>> {
	const solve = createProofOfWorkSolver(options.createProofOfWorkWorker);
	const calls = createProofOfWorkCalls(
		createRouteCall(options),
		challengeRouteOf(VELVE_CLIENT_ROUTES),
		solve,
	);
	const nested = nestRouteCalls(VELVE_CLIENT_ROUTES, calls.call);
	const proofOfWork = (nested.proofOfWork ?? {}) as Record<string, unknown>;
	proofOfWork.prepare = calls.prepare;
	nested.proofOfWork = proofOfWork;
	return nested as VelveClient<RouteTableOf<Auth>>;
}
