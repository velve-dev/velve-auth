import type { HttpEnvironment } from "./environment.js";
import type { VelveErrorCode } from "./error-map.js";
import { runRoute, toLoggedFailure } from "./pipeline.js";
import type { AnyRoute, Route, RunnableRoute, ServerCallFields } from "./route.js";

async function callRoute<Output>(
	route: RunnableRoute<Output>,
	environment: HttpEnvironment,
	input: ServerCallFields & Record<string, unknown>,
): Promise<Output> {
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
}

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
	return (input) =>
		callRoute(route, environment, input as ServerCallFields & Record<string, unknown>);
}

/**
 * The same method for a route whose input and output types are not in view — the table read at run
 * time, from which 3.15 D.2 builds the object path out of the dotted `name`.
 */
export function createServerMethodOfAnyRoute(
	route: AnyRoute,
	environment: HttpEnvironment,
): (input: ServerCallFields & Record<string, unknown>) => Promise<unknown> {
	return (input) => callRoute(route, environment, input);
}
