import { describe, expect, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

/**
 * Architecture 3.11 turns four plugin configurations into start errors rather than warnings. None
 * of them reaches the database, so the driver here refuses every statement: a refusal that arrives
 * as a query failure would mean the check ran too late.
 */
function mount(plugins: readonly VelvePlugin[]): { routes: readonly AnyRoute[] } {
	return createVelveAuth(configFor({ database: unreachableDriver(), plugins }));
}

/** The refusal is identified by its code; the message is prose and no test should pin it. */
function codeOfRefusal(plugins: readonly VelvePlugin[]): string {
	try {
		mount(plugins);
	} catch (cause) {
		if (cause instanceof VelveStartupError) {
			return cause.code;
		}
		return `not a start error: ${String(cause)}`;
	}
	return "the configuration started";
}

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

function pluginNamed(id: string, dependsOn?: readonly string[]): VelvePlugin {
	return {
		id,
		...(dependsOn === undefined ? {} : { dependsOn }),
		routes: [routeNamed(`${id}.only`, `/x/${id}/only`)],
	} as VelvePlugin;
}

describe("dependsOn is sorted topologically (3.11)", () => {
	it("orders a plugin after everything it depends on, whatever order it was configured in", () => {
		const mounted = mount([
			pluginNamed("last", ["middle"]),
			pluginNamed("middle", ["first"]),
			pluginNamed("first"),
		]);

		const contributed = mounted.routes
			.filter((route) => route.path.startsWith("/x/"))
			.map((route) => route.name);

		expect(contributed).toStrictEqual(["first.only", "middle.only", "last.only"]);
	});

	it("orders a diamond so that both middles follow the root and precede the join", () => {
		const mounted = mount([
			pluginNamed("join", ["left", "right"]),
			pluginNamed("right", ["root"]),
			pluginNamed("left", ["root"]),
			pluginNamed("root"),
		]);

		const contributed = mounted.routes
			.filter((route) => route.path.startsWith("/x/"))
			.map((route) => route.name);

		expect(contributed[0]).toBe("root.only");
		expect(contributed.at(-1)).toBe("join.only");
		expect([...contributed].sort()).toStrictEqual([
			"join.only",
			"left.only",
			"right.only",
			"root.only",
		]);
	});

	it("refuses a cycle at start rather than warning about it", () => {
		expect(() => mount([pluginNamed("a", ["b"]), pluginNamed("b", ["a"])])).toThrow(
			VelveStartupError,
		);
		expect(codeOfRefusal([pluginNamed("a", ["b"]), pluginNamed("b", ["a"])])).toBe(
			"plugin_dependency_cycle",
		);
	});

	it("refuses a plugin that depends on itself", () => {
		expect(codeOfRefusal([pluginNamed("a", ["a"])])).toBe("plugin_dependency_cycle");
	});

	/** E-742 decides this beyond 3.11's text, so the decision is held to by a test rather than by the entry. */
	it("refuses a dependency on a plugin nobody configured", () => {
		expect(codeOfRefusal([pluginNamed("a", ["absent"])])).toBe("plugin_dependency_missing");
	});

	it("starts when the graph is acyclic and every dependency is present", () => {
		expect(() => mount([pluginNamed("a"), pluginNamed("b", ["a"])])).not.toThrow();
	});
});

describe("a name collision is a start error, not a warning (3.11, S-OWNER-11)", () => {
	it("refuses a plugin route whose name is a core route's", () => {
		const plugin = asJavaScriptPlugin({
			id: "demo",
			routes: [routeNamed("session.list", "/x/demo/list")],
		});

		expect(codeOfRefusal([plugin])).toBe("plugin_route_conflict");
	});

	it("refuses a plugin route whose method and path are a core route's", () => {
		const plugin = asJavaScriptPlugin({
			id: "demo",
			routes: [routeNamed("demo.signOut", "/sign-out")],
		});

		expect(codeOfRefusal([plugin])).toBe("plugin_route_conflict");
	});

	it("refuses two plugins contributing the same route name", () => {
		const first = asJavaScriptPlugin({ id: "one", routes: [routeNamed("shared.x", "/x/one/x")] });
		const second = asJavaScriptPlugin({ id: "two", routes: [routeNamed("shared.x", "/x/two/x")] });

		expect(codeOfRefusal([first, second])).toBe("plugin_route_conflict");
	});

	it("refuses a plugin whose id occupies a namespace of the instance surface", () => {
		const plugin = asJavaScriptPlugin({
			id: "session",
			routes: [routeNamed("session.mine", "/x/session/mine")],
		});

		expect(codeOfRefusal([plugin])).toBe("plugin_route_conflict");
	});

	it("refuses two plugins claiming the same id", () => {
		expect(codeOfRefusal([pluginNamed("demo"), pluginNamed("demo")])).toBe("plugin_id_duplicated");
	});

	it("accepts a plugin route that collides with nothing", () => {
		const mounted = mount([pluginNamed("demo")]);

		expect(mounted.routes.map((route) => route.name)).toContain("demo.only");
	});
});

/**
 * T-CSRF-6, the integration half (E-752): a plugin that tries to register a middleware ahead of the origin
 * check and to replace the checking function must produce a **start error**. A plugin written in
 * JavaScript can name any field it likes, and silently dropping the ones the interface does not
 * enumerate leaves its author believing the middleware runs.
 */
describe("a plugin that reaches for the security middleware is refused at start (S-CSRF-6)", () => {
	it("refuses a plugin declaring a middleware ahead of the origin check", () => {
		const plugin = asJavaScriptPlugin({
			id: "attacker",
			middleware: [{ before: "originCheck", run: () => Promise.resolve() }],
			routes: [routeNamed("attacker.only", "/x/attacker/only")],
		});

		expect(() => mount([plugin])).toThrow(VelveStartupError);
	});

	it("refuses a plugin declaring a replacement for the origin check", () => {
		const plugin = asJavaScriptPlugin({
			id: "attacker",
			assertOriginAllowed: () => undefined,
			originCheck: "exempt",
			routes: [routeNamed("attacker.only", "/x/attacker/only")],
		});

		expect(() => mount([plugin])).toThrow(VelveStartupError);
	});
});
