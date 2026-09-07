import { describe, expect, expectTypeOf, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import {
	defineRoute,
	type Nest,
	type Route,
	type RouteDeclaration,
	type ServerCallFields,
	type ServerMethodOf,
	type ServerSurface,
} from "../src/core/http/route.js";
import { createServerMethod } from "../src/core/http/server-method.js";
import { object, string } from "../src/core/http/validators.js";
import { ALLOWED_ORIGIN, type callbackRoute, createHarness, signInRoute } from "./http-fixtures.js";

const declaration: RouteDeclaration<
	"test.declared",
	"/test/declared",
	{ value: string },
	{ echoed: string },
	"invalid_input"
> = {
	name: "test.declared",
	method: "POST",
	path: "/test/declared",
	input: object({ value: string() }),
	errors: ["invalid_input"],
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (input) => ({ echoed: input.value }),
};

describe("defineRoute", () => {
	it("keeps every declared field and adds the derived invocation", () => {
		const route = defineRoute(declaration);

		expect(route.name).toBe("test.declared");
		expect(route.method).toBe("POST");
		expect(route.path).toBe("/test/declared");
		expect(route.errors).toEqual(["invalid_input"]);
		expectTypeOf(route).toExtend<
			Route<
				"test.declared",
				"/test/declared",
				{ value: string },
				{ echoed: string },
				"invalid_input"
			>
		>();
	});

	it("parses the input before the caller is resolved", async () => {
		const route = defineRoute(declaration);
		let contextResolved = false;

		await expect(
			route.invoke({ value: 7 }, async () => {
				contextResolved = true;
				throw new Error("the caller must not be resolved for input that never parsed");
			}),
		).rejects.toThrow(new VelveError("invalid_input"));
		expect(contextResolved).toBe(false);
	});

	it("refuses a path that would route ambiguously", () => {
		expect(() => defineRoute({ ...declaration, path: "/test//declared" })).toThrow(
			/empty segments/,
		);
		expect(() => defineRoute({ ...declaration, path: "test/declared" })).toThrow(/absolute/);
	});

	it("refuses to require freshness without requiring a session", () => {
		expect(() => defineRoute({ ...declaration, freshness: "required" })).toThrow(
			/does not require a session/,
		);
	});

	it("describes the server surface with the dotted name", () => {
		expectTypeOf<Nest<"factor.totp.verify", () => void>>().toEqualTypeOf<{
			factor: { totp: { verify: () => void } };
		}>();
		expectTypeOf<ServerSurface<[typeof signInRoute]>>().toEqualTypeOf<{
			test: { signIn: ServerMethodOf<typeof signInRoute> };
		}>();
	});
});

describe("server method", () => {
	it("returns what the handler returned, session token included", async () => {
		const { environment } = createHarness();
		const signIn = createServerMethod(signInRoute, environment);

		await expect(
			signIn({ identifier: "someone@example.com", origin: ALLOWED_ORIGIN }),
		).resolves.toEqual({ status: "signed_in", sessionToken: "session-token-value" });
	});

	it("checks the origin on a direct call as well", async () => {
		const { environment } = createHarness();
		const signIn = createServerMethod(signInRoute, environment);

		await expect(
			signIn({ identifier: "someone@example.com", origin: "https://evil.com" }),
		).rejects.toThrow(new VelveError("origin_not_allowed"));
		await expect(signIn({ identifier: "someone@example.com", origin: null })).rejects.toThrow(
			new VelveError("origin_not_allowed"),
		);
	});

	it("counts a direct call against the same bucket as the request", async () => {
		const { environment, rateLimitRequests } = createHarness();
		await createServerMethod(
			signInRoute,
			environment,
		)({
			identifier: "someone@example.com",
			origin: ALLOWED_ORIGIN,
		});

		expect(rateLimitRequests.map((request) => request.routeName)).toEqual([
			"test.signIn",
			"test.signIn",
		]);
	});

	it("takes the caller tokens as named input fields", () => {
		expectTypeOf<ServerMethodOf<typeof callbackRoute>>().toEqualTypeOf<
			(
				input: { provider: string; code: string | undefined } & ServerCallFields,
			) => Promise<{ provider: string; code: string | null }>
		>();
	});
});
