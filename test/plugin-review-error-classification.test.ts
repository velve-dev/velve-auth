import { afterEach, describe, expect, it } from "vitest";
import { forgetPluginErrorCodes, VelveError } from "../src/core/http/error-map.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

const mounted: MountedAuth[] = [];

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
	forgetPluginErrorCodes();
});

function throwing(code: string): PluginRoute<"quota"> {
	return {
		name: "quota.spend",
		method: "POST",
		path: "/x/quota/spend",
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, _context: RequestContext) =>
			Promise.reject(new VelveError(code as "internal_error")),
	} as PluginRoute<"quota">;
}

async function answerTo(code: string): Promise<string> {
	const instance = await mountAuth("pluginclassify", {
		plugins: [{ id: "quota", routes: [throwing(code)] } satisfies VelvePlugin<"quota">],
	});
	mounted.push(instance);
	const response = await instance.handler(requestTo("/x/quota/spend", { body: {} }));
	const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
	return `${response.status} ${String(body.error?.code)} ${String(body.error?.message)}`;
}

/**
 * §3 puts the decision about what a caller learns in one place, and `visibleCodeOf` reaches it
 * through `isPluginErrorCode`, which asks `code in MESSAGE_BY_ERROR_CODE`. `in` walks the
 * prototype chain, so every key of `Object.prototype` reads as one of the twenty-five core codes.
 */
describe("a code a plugin throws that is neither core nor namespaced (3.15 F)", () => {
	it("answers internal_error for a code equal to a key of Object.prototype", async () => {
		expect(await answerTo("toString")).toBe(
			"500 internal_error The request could not be completed.",
		);
	});

	it("answers internal_error for a namespaced code nobody declared, which is the case beside it", async () => {
		expect(await answerTo("quota.undeclared")).toBe(
			"500 internal_error The request could not be completed.",
		);
	});
});
