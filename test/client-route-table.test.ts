import { describe, expect, it } from "vitest";
import { VELVE_CLIENT_ROUTES } from "../src/client/routes.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { widestVelveAuth } from "./client-fixtures.js";

function everyRouteTheLibraryDeclares(): readonly AnyRoute[] {
	return widestVelveAuth().routes;
}

/** `AnyRoute` hides the validator so no caller can reach past the checks; a test comparing declarations needs it. */
interface DeclaredRoute {
	readonly name: string;
	readonly method: string;
	readonly path: string;
	readonly input: { readonly fields: readonly string[] };
}

function everyDeclarationTheLibraryMakes(): readonly DeclaredRoute[] {
	return everyRouteTheLibraryDeclares() as unknown as readonly DeclaredRoute[];
}

function addressOf(route: { name: string; method: string; path: string }): string {
	return `${route.name} ${route.method} ${route.path}`;
}

/** A count no plausible table falls below, so a walk that produced nothing cannot read as agreement. */
const FEWEST_ROUTES_THAT_COULD_BE_THE_TABLE = 20;

describe("the client table against the table the server serves (architecture 3.15 E)", () => {
	it("names every row the widest instance serves, with the same method and the same path", () => {
		const served = everyRouteTheLibraryDeclares().map(addressOf);

		expect(VELVE_CLIENT_ROUTES.map(addressOf)).toStrictEqual(served);
	});

	it("holds enough rows that an empty comparison could not have passed", () => {
		expect(VELVE_CLIENT_ROUTES.length).toBeGreaterThanOrEqual(
			FEWEST_ROUTES_THAT_COULD_BE_THE_TABLE,
		);
	});

	it("carries no handler on any row", () => {
		for (const route of VELVE_CLIENT_ROUTES) {
			expect(Object.keys(route)).toStrictEqual(["name", "method", "path"]);
		}
	});

	it("declares every path parameter as a field of the route that has it", () => {
		const parameterised = VELVE_CLIENT_ROUTES.filter((route) => route.path.includes("/:"));
		const served = new Map(everyDeclarationTheLibraryMakes().map((route) => [route.name, route]));

		expect(parameterised.length).toBeGreaterThan(0);
		for (const route of parameterised) {
			const names = route.path
				.split("/")
				.filter((segment) => segment.startsWith(":"))
				.map((segment) => segment.slice(1));
			const declared = served.get(route.name);
			expect(names.every((name) => declared?.input.fields.includes(name) === true)).toBe(true);
		}
	});

	/**
	 * A GET is the one shape in which the client puts input into a query string, so what may not
	 * end up there is what the library mints as a secret. That is `token` and only `token`: the
	 * clause below is what makes the six envelope fields unreachable as inputs. `code` and `state`
	 * are the provider's callback parameters and travel in a query by protocol — `state` is a
	 * pointer whose other half is a cookie (S-CSRF-5), not a secret on its own.
	 */
	it("declares no envelope field as a route input, so no session or pending token can be one", () => {
		const reserved = ["sessionToken", "pendingToken", "oauthStateToken", "ipAddress", "userAgent"];

		for (const route of everyDeclarationTheLibraryMakes()) {
			expect(route.input.fields.filter((field) => reserved.includes(field))).toStrictEqual([]);
		}
	});

	it("takes a one-time token only on routes the client sends as a POST", () => {
		const carryingAnArtefact = everyDeclarationTheLibraryMakes().filter((route) =>
			route.input.fields.includes("token"),
		);

		expect(carryingAnArtefact.length).toBeGreaterThan(0);
		expect(carryingAnArtefact.filter((route) => route.method === "GET")).toStrictEqual([]);
	});
});
