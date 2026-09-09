import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURFACE_NAMESPACES } from "../src/core/auth/instance.js";
import type { Driver } from "../src/core/db/driver.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, mountAuthInMode } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

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

	/**
	 * The build assembles a fraction of 3.15 B, and the list covers what it has not built. Five of
	 * the seven left when this was written are gone, from two features: `oauth` builds the three
	 * `identity` rows and `signIn.oauth.*`, and `email-flows` builds `signUp`, `email` and both
	 * halves of `password`, contributing `signIn.magicLink` to the namespace the two share.
	 * `username` is absent from this mount because it is mounted in mode `email`.
	 */
	it("reserves more than the build carries, which is the point of it being a list", () => {
		const carried = new Set(Object.keys(mounted.auth as unknown as Record<string, unknown>));

		expect(SURFACE_NAMESPACES.filter((name) => !carried.has(name)).sort()).toStrictEqual([
			"factor",
			"username",
		]);
	});
});

function routeNamed(name: string, path: string): PluginRoute<string> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve(null),
	} as PluginRoute<string>;
}

function codeOfRefusal(plugin: VelvePlugin): string {
	try {
		createVelveAuth(configFor({ database: unreachableDriver() as Driver, plugins: [plugin] }));
	} catch (cause) {
		return (cause as { code?: string }).code ?? `not a start error: ${String(cause)}`;
	}
	return "the configuration started";
}

/**
 * E-785: the two axes are separate checks and each needs a case only it refuses. The id half was
 * measured by `id: "session"`, which the broken form still refused, so a plant on it fired while
 * measuring the surviving half; the name half had no case at all.
 */
describe("a plugin may take neither a namespace nor a name the core owns (3.11, E-780)", () => {
	it("refuses an id that is a namespace this build has not assembled yet", () => {
		for (const id of ["identity", "password", "factor", "email", "username"]) {
			expect(codeOfRefusal({ id } as VelvePlugin), id).toBe("plugin_route_conflict");
		}
	});

	it("refuses a route whose first segment is a core namespace, whatever the plugin is called", () => {
		const takingIdentity = {
			id: "demo",
			routes: [routeNamed("identity.list", "/x/demo/identity-list")],
		} as VelvePlugin;
		const takingSession = {
			id: "demo",
			routes: [routeNamed("session.mine", "/x/demo/session-mine")],
		} as VelvePlugin;

		expect(codeOfRefusal(takingIdentity)).toBe("plugin_route_conflict");
		expect(codeOfRefusal(takingSession)).toBe("plugin_route_conflict");
	});

	it("starts for a plugin that takes neither", () => {
		expect(
			codeOfRefusal({ id: "demo", routes: [routeNamed("demo.ok", "/x/demo/ok")] } as VelvePlugin),
		).toBe("the configuration started");
	});
});
