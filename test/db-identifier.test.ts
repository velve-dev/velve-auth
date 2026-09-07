import { describe, expect, it } from "vitest";
import {
	assertIdentifier,
	InvalidIdentifierError,
	qualifiedTableName,
} from "../src/core/db/identifier.js";

describe("identifier checking", () => {
	it("accepts the names the library itself uses", () => {
		expect(assertIdentifier("velve")).toBe("velve");
		expect(qualifiedTableName("velve", "schema_migration")).toBe("velve.schema_migration");
	});

	it("rejects anything that would need quoting", () => {
		for (const name of ["Velve", "velve schema", 'velve";DROP', "1velve", ""]) {
			expect(() => assertIdentifier(name)).toThrow(InvalidIdentifierError);
		}
	});

	it("rejects a name longer than PostgreSQL stores", () => {
		expect(() => assertIdentifier("v".repeat(64))).toThrow(InvalidIdentifierError);
		expect(assertIdentifier("v".repeat(63))).toHaveLength(63);
	});
});
