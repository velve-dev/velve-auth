import { describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/core/db/driver.js";

const { constructions } = vi.hoisted(() => ({ constructions: [] as { limit: number }[] }));

vi.mock("../src/core/password/semaphore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/password/semaphore.js")>();
	return {
		...actual,
		createKdfSemaphore: (options: { limit: number }) => {
			constructions.push(options);
			return actual.createKdfSemaphore(options);
		},
	};
});

const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");

const NO_DATABASE: Driver = {
	query: () => Promise.reject(new Error("assembling an instance must ask the database nothing")),
	transaction: () => Promise.reject(new Error("assembling an instance must open no transaction")),
};

/**
 * S-DOS-3 bounds concurrent key derivation for the process, and a bound is only a bound if there is
 * one of it: two semaphores of the configured size permit twice the derivations and twice the
 * memory. Counting the constructions is the measurement, because the wiring reads correct with one
 * seam making its own (E-1195).
 */
describe("one semaphore per assembled instance (S-DOS-3)", () => {
	it("constructs exactly one, whatever the number of route sources that need it", () => {
		constructions.length = 0;

		const auth = createVelveAuth(configFor({ database: NO_DATABASE }));

		expect(auth.routes.length).toBeGreaterThan(0);
		expect(constructions).toHaveLength(1);
	});

	it("gives it the configured concurrent-hash limit", () => {
		constructions.length = 0;
		createVelveAuth(configFor({ database: NO_DATABASE, password: { concurrentHashLimit: 3 } }));

		expect(constructions.map(({ limit }) => limit)).toEqual([3]);
	});

	/** A construction the assembly does not make is one no count of an assembly can see. */
	it("is constructed nowhere in the library but the assembly", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const core = fileURLToPath(new URL("../src/", import.meta.url));
		const callers = readdirSync(core, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.filter((path) => /createKdfSemaphore\(/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(core, ""))
			.sort();

		expect(callers).toEqual(["core/auth/instance.ts", "core/password/semaphore.ts"]);
	});
});
