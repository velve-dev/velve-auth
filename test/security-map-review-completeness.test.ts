import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { widestVelveAuth } from "./client-fixtures.js";

/**
 * The review of section 5.22 against the tree it claims to map: every route the widest instance
 * serves, every method it carries and every plugin point that runs code or SQL must stand in the
 * map as part of a way in or among the things the section says do not belong. A way the map does
 * not name is the worst finding the map can have, so each check here reads the tree, not the map.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const english = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITECTURE.md`, "utf8");
const german = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITEKTUR.md`, "utf8");

interface JsonWay {
	readonly id: string;
	readonly title: string;
	readonly routes?: readonly string[];
	readonly guards: readonly { readonly enforcedIn: string }[];
}

const mapJson: readonly JsonWay[] = JSON.parse(
	readFileSync(`${repositoryRoot}/test/attacks/map.json`, "utf8"),
);

function sliceBetween(text: string, opens: string, closes: string): string {
	const start = text.indexOf(opens);
	if (start < 0) {
		throw new Error(`cannot read the specification: ${opens} is missing`);
	}
	const end = text.indexOf(closes, start + opens.length);
	if (end < 0) {
		throw new Error(`cannot read the specification: nothing closes ${opens}`);
	}
	return text.slice(start, end);
}

interface ParsedWay {
	readonly id: string;
	readonly title: string;
	readonly routes: readonly string[];
	readonly enforcedIn: readonly string[];
}

function waysOf(section: string, routesLabel: string): ParsedWay[] {
	const ways: { id: string; title: string; routes: string[]; enforcedIn: string[] }[] = [];
	for (const line of section.split("\n")) {
		const heading = /^#### `(W-[A-Z0-9-]+)` — (.+)$/.exec(line);
		if (heading !== null) {
			ways.push({ id: heading[1] ?? "", title: heading[2] ?? "", routes: [], enforcedIn: [] });
			continue;
		}
		const current = ways.at(-1);
		if (current === undefined) {
			continue;
		}
		if (line.startsWith(routesLabel)) {
			current.routes.push(...[...line.matchAll(/`([^`]+)`/g)].map((match) => String(match[1])));
			continue;
		}
		const enforced = /^\|[^|]+\|[^|]+\| `(src\/[^`]+)` \|/.exec(line);
		if (enforced !== null) {
			current.enforcedIn.push(String(enforced[1]));
		}
	}
	return ways;
}

const englishMap = sliceBetween(english, "\n### 5.22 ", "\n## 6.");
const germanMap = sliceBetween(german, "\n### 5.22 ", "\n## 6.");
const englishWays = waysOf(englishMap, "Routes and methods:");
const germanWays = waysOf(germanMap, "Routen und Methoden:");

/** the paragraph naming what the section says does not belong, every backticked name in it */
const declaredOutside: ReadonlySet<string> = (() => {
	const paragraph = englishMap
		.split("\n\n")
		.find((each) => each.startsWith("What does not belong"));
	if (paragraph === undefined) {
		throw new Error("cannot read the map: the paragraph of what does not belong is missing");
	}
	return new Set([...paragraph.matchAll(/`([^`]+)`/g)].map((match) => String(match[1])));
})();

const namedByAWay: ReadonlySet<string> = new Set(englishWays.flatMap((way) => way.routes));

function isAccountedFor(name: string): boolean {
	return namedByAWay.has(name) || declaredOutside.has(name);
}

/** every function the instance carries, as the dotted name an application calls it by */
function methodNamesOf(node: unknown, prefix: string, seen: Set<unknown>): string[] {
	if (typeof node === "function") {
		return [prefix];
	}
	if (typeof node !== "object" || node === null || seen.has(node)) {
		return [];
	}
	seen.add(node);
	return Object.entries(node).flatMap(([key, value]) =>
		methodNamesOf(value, prefix === "" ? key : `${prefix}.${key}`, seen),
	);
}

//the members that are data the application reads and not methods it calls
const DATA_MEMBERS = new Set(["routes", "http", "errorCodes", "weakenings", "identityMode"]);
//the one method that does nothing at all, so it cannot be a way in
const DOES_NOTHING = new Set(["close"]);

describe("every route the widest instance serves stands in the map", () => {
	it("names each served route in a way or in the paragraph of what does not belong", () => {
		const auth = widestVelveAuth();
		const served = auth.routes.map((route) => `${route.method} ${route.path}`);
		expect(served.length).toBeGreaterThan(40);
		expect(served.filter((address) => !isAccountedFor(address))).toStrictEqual([]);
	});
});

describe("every method the widest instance carries stands in the map", () => {
	it("names each method by its own name, by the route it calls, or as not belonging", () => {
		const auth = widestVelveAuth() as unknown as Record<string, unknown>;
		const pathOfRoute = new Map(
			widestVelveAuth().routes.map((route) => [route.name, `${route.method} ${route.path}`]),
		);
		const methods = Object.entries(auth)
			.filter(([key]) => !DATA_MEMBERS.has(key))
			.flatMap(([key, value]) => methodNamesOf(value, key, new Set()));
		expect(methods.length).toBeGreaterThan(40);
		const unaccounted = methods.filter(
			(name) =>
				!DOES_NOTHING.has(name) &&
				!isAccountedFor(name) &&
				!isAccountedFor(pathOfRoute.get(name) ?? name),
		);
		//migrate() runs every plugin migration on the library's own connection
		expect(unaccounted).toStrictEqual([]);
	});
});

describe("every plugin point that runs code or SQL stands in W-PLUGIN", () => {
	const EVERY_PLUGIN_FIELD = [
		"id",
		"dependsOn",
		"migrations",
		"routes",
		"hooks",
		"errorCodes",
		"rateLimitRules",
		"securityStateAnchor",
	] as const satisfies readonly (keyof VelvePlugin)[];
	type Unlisted = Exclude<keyof VelvePlugin, (typeof EVERY_PLUGIN_FIELD)[number]>;
	const everyFieldIsListed: [Unlisted] extends [never] ? true : false = true;
	//a name, a dependency order, codes and limits on its own routes run nothing of the plugin
	const RUNS_NOTHING = new Set(["id", "dependsOn", "errorCodes", "rateLimitRules"]);

	it("names VelvePlugin.<field> for every field that hands the library code or SQL to run", () => {
		expect(everyFieldIsListed).toBe(true);
		const plugin = englishWays.find((way) => way.id === "W-PLUGIN");
		expect(plugin).toBeDefined();
		const missing = EVERY_PLUGIN_FIELD.filter((field) => !RUNS_NOTHING.has(field)).filter(
			(field) => !(plugin?.routes ?? []).includes(`VelvePlugin.${field}`),
		);
		expect(missing).toStrictEqual([]);
	});

	it("names a guard for plugin migrations, which run on the library's connection", () => {
		const plugin = englishWays.find((way) => way.id === "W-PLUGIN");
		expect(
			plugin?.enforcedIn.some((point) => point.startsWith("src/core/db/migration-runner.ts:")),
		).toBe(true);
	});
});

describe("the activation of a recovery reached through the passkey sign-in stands in the map", () => {
	it("names POST /sign-in/passkey/finish on the way whose guard is the activation", () => {
		const activating = englishWays.filter((way) =>
			way.enforcedIn.some((point) => point.startsWith("src/core/recovery/activation.ts:")),
		);
		expect(activating.map((way) => way.id)).toContain("W-PASSKEY-RECOVERY");
		//signIn.passkey.finish activates a due recovery before it verifies the assertion
		expect(activating.some((way) => way.routes.includes("POST /sign-in/passkey/finish"))).toBe(
			true,
		);
	});
});

describe("the threat model of 5.0 places every error class of section 5", () => {
	function classesOfSection5(specification: string): string[] {
		return [
			...new Set(
				[...specification.matchAll(/^- \*\*S-([A-Z]+)-\d+:\*\*/gm)].map((match) =>
					String(match[1]),
				),
			),
		].sort();
	}

	function classesStoppingAnAttacker(specification: string, heading: string): Set<string> {
		const model = sliceBetween(specification, heading, "\n### 5.1 ");
		const stopping = model
			.split("\n")
			.filter((line) => line.startsWith("| ") && !line.startsWith("|---"))
			.map((line) => line.split("|")[3] ?? "");
		return new Set(
			stopping.flatMap((cell) => [...cell.matchAll(/\b([A-Z]{3,})\b/g)].map((m) => String(m[1]))),
		);
	}

	it("names each class against an attacker in the English table", () => {
		const named = classesStoppingAnAttacker(english, "\n### 5.0 ");
		const classes = classesOfSection5(german);
		expect(classes.length).toBeGreaterThan(15);
		expect(classes.filter((each) => !named.has(each))).toStrictEqual([]);
	});

	it("names each class against an attacker in the German table", () => {
		const named = classesStoppingAnAttacker(german, "\n### 5.0 ");
		expect(classesOfSection5(german).filter((each) => !named.has(each))).toStrictEqual([]);
	});
});

describe("the routes and methods of every way are kept as equal as its guards", () => {
	it("names the same routes and methods for every way in German and English", () => {
		expect(germanWays.map((way) => way.id)).toStrictEqual(englishWays.map((way) => way.id));
		for (const way of englishWays) {
			expect(germanWays.find((each) => each.id === way.id)?.routes, way.id).toStrictEqual(
				way.routes,
			);
		}
	});

	it("carries the routes and methods and the title of every way in map.json", () => {
		for (const way of englishWays) {
			const kept = mapJson.find((each) => each.id === way.id);
			expect(kept?.title, way.id).toBe(way.title);
			expect(kept?.routes, way.id).toStrictEqual(way.routes);
		}
	});
});
