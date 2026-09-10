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
	 * S-REDIR-4: no query string the library writes carries a one-time artefact, and a GET is the
	 * one shape in which the client puts input into one. Every route that redeems one is a POST.
	 */
	it("puts no one-time artefact in a query string, because no route that takes one is a GET", () => {
		const carryingAnArtefact = everyDeclarationTheLibraryMakes().filter((route) =>
			route.input.fields.includes("token"),
		);

		expect(carryingAnArtefact.length).toBeGreaterThan(0);
		expect(carryingAnArtefact.filter((route) => route.method === "GET")).toStrictEqual([]);
	});
});
