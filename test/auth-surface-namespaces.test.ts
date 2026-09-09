import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURFACE_NAMESPACES } from "../src/core/auth/instance.js";
import { type MountedAuth, mountAuth, mountAuthInMode } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("surfacenames");
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

/**
 * E-779: the list is a statement of 3.15 B and deliberately wider than the build, so it can only be
 * checked in one direction. That the surface never carries a namespace the list omits is checkable
 * here; that the list carries all eighteen of 3.15 B is checkable only by reading it against 3.15 B.
 */
describe("the namespaces a plugin may not take (3.11, 3.15 B)", () => {
	it("names every namespace the built instance carries", () => {
		const carried = Object.keys(mounted.auth as unknown as Record<string, unknown>);
		const reserved = new Set(SURFACE_NAMESPACES);

		expect(SURFACE_NAMESPACES).toHaveLength(18);
		expect(carried.length).toBeGreaterThan(5);
		expect(carried.filter((name) => !reserved.has(name))).toStrictEqual([]);
	});

	/**
	 * `username` is on the surface in one mode and absent in another, so a list read off the build
	 * would reserve it in one and release it in the other — which is what E-779 found.
	 */
	it("names the namespace that exists in one identity mode and not another", async () => {
		const withUsernames = await mountAuthInMode("surfacenamesmode", {
			mode: "username_email",
			username: {
				allowedCharacters: /^[a-z0-9_-]+$/,
				minimumLength: 3,
				maximumLength: 32,
				reservedNames: [],
			},
		});
		const carried = Object.keys(withUsernames.auth as unknown as Record<string, unknown>);
		await dropSchema(withUsernames.connection, withUsernames.schema);
		await withUsernames.connection.close();

		expect(carried).toContain("username");
		expect(SURFACE_NAMESPACES).toContain("username");
		expect(carried.filter((name) => !SURFACE_NAMESPACES.includes(name))).toStrictEqual([]);
	});

	/** The wave-4 build assembles a fraction of 3.15 B, and the list covers what it has not built. */
	it("reserves more than the build carries, which is the point of it being a list", () => {
		const carried = new Set(Object.keys(mounted.auth as unknown as Record<string, unknown>));

		expect(SURFACE_NAMESPACES.filter((name) => !carried.has(name)).sort()).toStrictEqual([
			"email",
			"factor",
			"identity",
			"password",
			"signIn",
			"signUp",
			"username",
		]);
	});
});
