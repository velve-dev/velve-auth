import { describe, expect, it } from "vitest";
import {
	assertIdentifier,
	assertSchemaName,
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

	it("keeps a reserved key word usable after a dot", () => {
		expect(qualifiedTableName("velve", "user")).toBe("velve.user");
		expect(assertIdentifier("user")).toBe("user");
	});

	it("rejects a reserved key word where it would stand unqualified", () => {
		for (const name of ["user", "table", "select", "default", "left", "authorization"]) {
			expect(() => assertSchemaName(name)).toThrow(InvalidIdentifierError);
		}
		expect(() => qualifiedTableName("user", "session")).toThrow(InvalidIdentifierError);
		expect(assertSchemaName("velve")).toBe("velve");
	});

	it("rejects a name longer than PostgreSQL stores", () => {
		expect(() => assertIdentifier("v".repeat(64))).toThrow(InvalidIdentifierError);
		expect(assertIdentifier("v".repeat(63))).toHaveLength(63);
	});
});
