import { writtenSolution } from "../pow/work.js";
import type { HttpEnvironment } from "./environment.js";
import type { VelveErrorCode } from "./error-map.js";
import { runRoute, toLoggedFailure } from "./pipeline.js";
import type { AnyRoute, Route, RouteMetadata, RunnableRoute, ServerCallFields } from "./route.js";

//a javascript caller can pass any value and a solution that is no pair must read as presented and malformed
function presentedSolution(solution: unknown): string | null {
	if (solution === undefined) {
		return null;
	}
	const { challenge, nonce } = (solution ?? {}) as { challenge?: unknown; nonce?: unknown };
	return typeof challenge === "string" && typeof nonce === "number" && Number.isSafeInteger(nonce)
		? writtenSolution(challenge, nonce)
		: "";
}

//the field is the call's own unless the proof of work is off and the route declares it as input (E-3677)
function splitProofOfWork(
	route: RouteMetadata,
	callInput: Record<string, unknown>,
	environment: HttpEnvironment,
): { readonly proofOfWork: unknown; readonly routeInput: Record<string, unknown> } {
	if (environment.proofOfWork === undefined && declaresInputField(route, "proofOfWork")) {
		return { proofOfWork: undefined, routeInput: callInput };
	}
	const { proofOfWork, ...routeInput } = callInput;
	return { proofOfWork, routeInput };
}

function declaresInputField(route: RouteMetadata, field: string): boolean {
	const input = (route as { readonly input?: { readonly fields?: unknown } }).input;
	return Array.isArray(input?.fields) && input.fields.includes(field);
}

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
		...callInput
	} = input;
	const { proofOfWork, routeInput } = splitProofOfWork(route, callInput, environment);
	try {
		const outcome = await runRoute(
			route,
			{
				origin,
				//a server call is never a same-origin read and always compares its origin (E-2390)
				fetchSite: null,
				ipAddress: ipAddress ?? null,
				userAgent: userAgent ?? null,
				proofOfWork: presentedSolution(proofOfWork),
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

export function createServerMethodOfAnyRoute(
	route: AnyRoute,
	environment: HttpEnvironment,
): (input: ServerCallFields & Record<string, unknown>) => Promise<unknown> {
	return (input) => callRoute(route, environment, input);
}
