import type { HttpEnvironment } from "./environment.js";
import type { VelveErrorCode } from "./error-map.js";
import { runRoute, toLoggedFailure } from "./pipeline.js";
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
		const {
			origin,
			sessionToken,
			pendingToken,
			oauthStateToken,
			ipAddress,
			userAgent,
			...routeInput
		} = input;
		try {
			const outcome = await runRoute(
				route,
				{
					origin,
					ipAddress: ipAddress ?? null,
					userAgent: userAgent ?? null,
					readCallerTokens: () => ({
						sessionToken: sessionToken ?? null,
						pendingToken: pendingToken ?? null,
						oauthStateToken: oauthStateToken ?? null,
					}),
					readInput: async () => routeInput,
				},
				environment,
			);
			return outcome.output;
		} catch (cause) {
			throw toLoggedFailure(cause, route.name, environment);
		}
	};
}
