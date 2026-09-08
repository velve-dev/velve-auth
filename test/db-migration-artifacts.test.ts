import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identityModeMigration } from "../src/core/db/migrations/identity-mode.js";
import { initialSchema } from "../src/core/db/migrations/initial-schema.js";

function shippedFile(name: string): string {
	return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("the SQL the runner executes and the SQL the operator reads", () => {
	it("are the same text for migration 1", () => {
		expect(initialSchema.sql).toBe(shippedFile("0001_initial_schema.sql"));
	});

	it("are the same text for each identity mode", () => {
		expect(identityModeMigration("email").sql).toBe(shippedFile("0002_identity_email.sql"));
		expect(identityModeMigration("username").sql).toBe(shippedFile("0002_identity_username.sql"));
		expect(identityModeMigration("username_email").sql).toBe(
			shippedFile("0002_identity_username_email.sql"),
		);
	});
});
