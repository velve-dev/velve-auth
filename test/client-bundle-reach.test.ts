import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const clientEntry = resolve(distDirectory, "client.mjs");

const RE_EXPORTED_OR_IMPORTED = /(?:^|[\s;}])(?:import|export)\b[^"'\n]*?from\s*["']([^"']+)["']/gm;
const IMPORTED_FOR_EFFECT = /^\s*import\s*["']([^"']+)["']/gm;

function specifiersIn(source: string): readonly string[] {
	return [
		...[...source.matchAll(RE_EXPORTED_OR_IMPORTED)].map((match) => match[1] ?? ""),
		...[...source.matchAll(IMPORTED_FOR_EFFECT)].map((match) => match[1] ?? ""),
	];
}

interface Reach {
	readonly modules: readonly string[];
	readonly bare: readonly string[];
	readonly source: string;
}

/**
 * 3.15 E's price: the client imports the route table as a value, and `unbundle: true` keeps every
 * import of every module reached from the entry. What a browser loads is therefore this walk and
 * not a claim about it.
 */
function reachOf(entry: string): Reach {
	const visited = new Set<string>();
	const bare = new Set<string>();
	const sources: string[] = [];
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) {
			continue;
		}
		visited.add(file);
		const source = readFileSync(file, "utf8");
		sources.push(source);
		for (const specifier of specifiersIn(source)) {
			if (specifier.startsWith(".")) {
				pending.push(resolve(dirname(file), specifier));
			} else {
				bare.add(specifier);
			}
		}
	}
	return {
		modules: [...visited].map((file) => relative(distDirectory, file)).toSorted(),
		bare: [...bare].toSorted(),
		source: sources.join("\n"),
	};
}

/**
 * The one module of `core/` a browser loads. §3 of the repository rules keeps it the only place
 * that decides what a caller learns, it imports nothing itself, and it is what makes
 * `instanceof VelveError` hold on both sides of the call (E-677).
 */
const THE_ONLY_CORE_MODULE = "core/http/error-map.mjs";

/** Names that exist only where a request is served: the handler registry, the driver, the SQL. */
const SERVER_ONLY_NAMES = ["invocationOf", "defineRoute", "runRoute", "transaction(", "SELECT "];

describe("what reaches the browser through @velve/auth/client (architecture 3.15 E)", () => {
	it("was built before it was measured, and is the client that was built", () => {
		expect(existsSync(clientEntry)).toBe(true);
		expect(readFileSync(clientEntry, "utf8")).toContain("createVelveClient");
	});

	it("loads more than its entry file, so an empty walk cannot read as a clean one", () => {
		expect(reachOf(clientEntry).modules.length).toBeGreaterThan(1);
	});

	it("reaches no dependency and no Node built-in", () => {
		expect(reachOf(clientEntry).bare).toStrictEqual([]);
	});

	it("reaches exactly one module of the server core", () => {
		const fromCore = reachOf(clientEntry).modules.filter((file) => file.startsWith("core/"));

		expect(fromCore).toStrictEqual([THE_ONLY_CORE_MODULE]);
	});

	it("carries no handler, no driver and no SQL", () => {
		const { source } = reachOf(clientEntry);

		expect(SERVER_ONLY_NAMES.filter((name) => source.includes(name))).toStrictEqual([]);
	});
});
