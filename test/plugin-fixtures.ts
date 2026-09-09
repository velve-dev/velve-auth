import type { Driver } from "../src/core/db/driver.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";

/**
 * A plugin written in JavaScript reaches the registry as a plain object, which is the half of 3.11
 * the type constraint cannot cover. One cast, in one place, so no test needs its own.
 */
export function asJavaScriptPlugin(value: Readonly<Record<string, unknown>>): VelvePlugin {
	return value as unknown as VelvePlugin;
}

export interface ObservedCall {
	readonly route: string;
	readonly context: RequestContext;
}

export interface ContextProbe {
	readonly plugin: VelvePlugin<"demo">;
	readonly calls: readonly ObservedCall[];
	last(): ObservedCall;
	clear(): void;
}

/** A route that records the context it was handed and answers nothing, so the assertion is the context. */
export function createContextProbe(options: { readonly path?: string } = {}): ContextProbe {
	const calls: ObservedCall[] = [];
	const route: PluginRoute<"demo"> = {
		name: "demo.echo",
		method: "POST",
		path: `/x/demo/${options.path ?? "echo"}`,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, context: RequestContext) => {
			calls.push({ route: "demo.echo", context });
			return Promise.resolve({ seen: true });
		},
	};
	return {
		plugin: { id: "demo", routes: [route] },
		get calls() {
			return calls;
		},
		last: () => {
			const call = calls.at(-1);
			if (call === undefined) {
				throw new Error("the probe route was never reached");
			}
			return call;
		},
		clear: () => {
			calls.length = 0;
		},
	};
}

/** Startup refusals are decided before any statement runs, so the tests that provoke them need no server. */
export function unreachableDriver(): Driver {
	const refuse = (): Promise<never> =>
		Promise.reject(new Error("a start error must be decided before any query"));
	return { query: refuse, transaction: refuse };
}
