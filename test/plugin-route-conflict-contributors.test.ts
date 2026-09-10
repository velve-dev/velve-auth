import { describe, expect, it } from "vitest";
import { THE_CORE, VelveStartupError } from "../src/core/auth/startup.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

/**
 * `test/plugin-registry-start.test.ts` holds the first half of T-OWNER-11 — 2/2 configurations
 * refuse — and identifies each refusal by its code, because the rest of a start message is prose.
 * This file holds the second half, which the row states as a property of the message itself:
 * *die Fehlermeldung nennt beide Beitragenden*. The bracketed clause is generated from
 * `VelveStartupError.conflict` and is therefore a contract rather than prose, and only that clause
 * is read here (E-1331).
 */
const NAMES_BOTH = /\[(.+) is claimed by (.+) and by (.+)\]$/;

interface Refusal {
	readonly code: string;
	readonly claimed: string;
	readonly contributors: readonly string[];
	readonly statedInTheMessage: readonly string[];
	readonly claimedInTheMessage: string;
}

/**
 * A `toContain` for each contributor passes for a message that names one of them and happens to
 * carry the other as a substring, which is the reading of the row this file exists to refuse. The
 * message is parsed back into the three items it claims to carry instead, so each contributor has
 * to stand in it as a token of its own (E-1332).
 */
function refusalOf(plugins: readonly VelvePlugin[]): Refusal {
	try {
		createVelveAuth(configFor({ database: unreachableDriver(), plugins }));
	} catch (cause) {
		if (!(cause instanceof VelveStartupError)) {
			throw new Error(`not a start error: ${String(cause)}`);
		}
		if (cause.conflict === undefined) {
			throw new Error(`${cause.code} carries no conflict to name a contributor from`);
		}
		const named = NAMES_BOTH.exec(cause.message);
		if (named === null) {
			throw new Error(`the message names no contributors: ${cause.message}`);
		}
		return {
			code: cause.code,
			claimed: cause.conflict.claimed,
			contributors: cause.conflict.contributors,
			claimedInTheMessage: String(named[1]),
			statedInTheMessage: [String(named[2]), String(named[3])],
		};
	}
	throw new Error("the configuration started");
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

/**
 * One id is a proper prefix of the other, so a message naming only `cartridge` still contains
 * `cart`. Every assertion below compares whole captured tokens in order for that reason, and the
 * order is the incumbent first and the arriving second, which `DOCUMENTATION.md` states as the
 * contract (E-1342).
 */
const SHADOWING_ID = "cart";
const SHADOWED_BY = "cartridge";

describe("a route conflict names both contributors (S-OWNER-11, T-OWNER-11)", () => {
	it("names the plugin and the core when a plugin takes a core route's path", () => {
		const refusal = refusalOf([
			asJavaScriptPlugin({ id: "demo", routes: [routeNamed("demo.signOut", "/sign-out")] }),
		]);

		expect(refusal.code).toBe("plugin_route_conflict");
		expect(refusal.contributors).toEqual([THE_CORE, "demo"]);
		expect(refusal.statedInTheMessage).toEqual([THE_CORE, "demo"]);
		expect(refusal.claimedInTheMessage).toBe(refusal.claimed);
		expect(refusal.claimed).toBe("POST /sign-out");
	});

	it("names both plugins when a second plugin collides with the first", () => {
		const refusal = refusalOf([
			asJavaScriptPlugin({
				id: SHADOWING_ID,
				routes: [routeNamed("shared.x", `/x/${SHADOWING_ID}/x`)],
			}),
			asJavaScriptPlugin({
				id: SHADOWED_BY,
				routes: [routeNamed("shared.x", `/x/${SHADOWED_BY}/x`)],
			}),
		]);

		expect(refusal.code).toBe("plugin_route_conflict");
		expect(refusal.contributors).toEqual([SHADOWING_ID, SHADOWED_BY]);
		expect(refusal.statedInTheMessage).toEqual([SHADOWING_ID, SHADOWED_BY]);
		expect(refusal.claimedInTheMessage).toBe(refusal.claimed);
		expect(refusal.claimed).toBe("shared.x");
	});

	/**
	 * The two above would both pass against an implementation that named the arriving plugin twice,
	 * because a set of two equal ids still contains every id the case expects. This one fails there.
	 */
	it("states two contributors and not one of them twice", () => {
		for (const refusal of [
			refusalOf([
				asJavaScriptPlugin({ id: "demo", routes: [routeNamed("demo.signOut", "/sign-out")] }),
			]),
			refusalOf([
				asJavaScriptPlugin({
					id: SHADOWING_ID,
					routes: [routeNamed("shared.x", `/x/${SHADOWING_ID}/x`)],
				}),
				asJavaScriptPlugin({
					id: SHADOWED_BY,
					routes: [routeNamed("shared.x", `/x/${SHADOWED_BY}/x`)],
				}),
			]),
		]) {
			expect(new Set(refusal.contributors).size).toBe(2);
			expect(new Set(refusal.statedInTheMessage).size).toBe(2);
		}
	});

	/**
	 * A plugin whose id takes one of the eighteen namespaces of 3.15 B refuses at a second site, and
	 * a conflict that reached the operator with one contributor from one site and none from the other
	 * would meet the row in half.
	 */
	it("names the plugin and the core when a plugin id takes a surface namespace", () => {
		const refusal = refusalOf([
			asJavaScriptPlugin({
				id: "session",
				routes: [routeNamed("session.mine", "/x/session/mine")],
			}),
		]);

		expect(refusal.code).toBe("plugin_route_conflict");
		expect(refusal.contributors).toEqual([THE_CORE, "session"]);
		expect(refusal.statedInTheMessage).toEqual([THE_CORE, "session"]);
		expect(refusal.claimed).toBe("session");
	});

	/**
	 * The helper throws its own error for a start that does not refuse, for a refusal carrying no
	 * conflict and for a message the pattern cannot read, so a green run means it looked and found
	 * both contributors rather than that it found nothing to look at.
	 */
	it("refuses to answer for a configuration that starts", () => {
		expect(() => refusalOf([])).toThrow("the configuration started");
	});
});
