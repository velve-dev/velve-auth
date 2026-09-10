import { describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { defineRoute } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

/**
 * A route source that lands under a namespace the assembly also states by hand. `session` is the
 * one used because the assembly states all six of its methods, so the shadowing would take six
 * methods away and not one — which is what makes an object literal's precedence the wrong
 * instrument for the collision (E-1192).
 */
const SHADOWING_ROUTE_NAME = "session.contributed";

vi.mock("../src/core/oauth/routes.js", () => ({
	oauthRoutes: () => [
		defineRoute({
			name: SHADOWING_ROUTE_NAME,
			method: "POST",
			path: "/seam/session-contributed",
			input: object({}),
			errors: [] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve(null),
		}),
	],
}));

function codeOfRefusal(): string {
	try {
		createVelveAuth(configFor({ database: unreachableDriver() as Driver }));
	} catch (cause) {
		return (cause as { code?: string }).code ?? `not a start error: ${String(cause)}`;
	}
	return "the configuration started";
}

describe("a namespace the assembly states may not replace one a route source built (E-1192)", () => {
	it("refuses the start rather than dropping the six methods under `session`", () => {
		expect(codeOfRefusal()).toBe("route_namespace_conflict");
	});
});
