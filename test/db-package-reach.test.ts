import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	exports: Record<string, { default: string } | string>;
};

async function importSubpath(subpath: string): Promise<Record<string, unknown>> {
	const target = manifest.exports[subpath];
	if (typeof target !== "object") {
		throw new Error(`${subpath} is not declared with a default condition`);
	}
	return (await import(new URL(target.default, new URL("../", import.meta.url)).href)) as Record<
		string,
		unknown
	>;
}

describe("what the built package actually exposes (architecture 3.1)", () => {
	it("hands the migration runner out through @velve/auth/schema", async () => {
		const schema = await importSubpath("./schema");

		expect(typeof schema.runMigrations).toBe("function");
	});

	it("hands the shipped migration plan out through @velve/auth/schema", async () => {
		const schema = await importSubpath("./schema");

		expect(typeof schema.coreMigrations).toBe("function");
	});

	it("hands the driver interface's implementation out through @velve/auth/pg", async () => {
		const pg = await importSubpath("./pg");

		expect(typeof pg.createNodePostgresDriver).toBe("function");
	});

	it("hands the actor and the owner-scoped repository out through @velve/auth", async () => {
		const core = await importSubpath(".");

		expect(typeof core.actorOfResolvedSession).toBe("function");
		expect(typeof core.createOwnedRowRepository).toBe("function");
	});
});
