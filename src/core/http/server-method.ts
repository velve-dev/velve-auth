import type { HttpEnvironment } from "./environment.js";
import type { VelveErrorCode } from "./error-map.js";
import { runRoute } from "./pipeline.js";
import type { Route, ServerCallFields } from "./route.js";

export function createServerMethod<
	Name extends string,
	Path extends string,
	Input,
	Output,
	Code extends VelveErrorCode,
>(
	route: Route<Name, Path, Input, Output, Code>,
	environment: HttpEnvironment,
): (input: Input & ServerCallFields) => Promise<Output> {
	return async (input) => {
		const { origin, sessionToken, pendingToken, ipAddress, userAgent, ...routeInput } = input;
		const outcome = await runRoute(
			route,
			{
				origin,
				sessionToken: sessionToken ?? null,
				pendingToken: pendingToken ?? null,
				ipAddress: ipAddress ?? null,
				userAgent: userAgent ?? null,
				readInput: async () => routeInput,
			},
			environment,
		);
		return outcome.output;
	};
}
