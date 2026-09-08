import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationChecksum } from "../src/core/db/migration.js";
import { identityModeMigration } from "../src/core/db/migrations/identity-mode.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { initialSchema } from "../src/core/db/migrations/initial-schema.js";

const migrationsDirectory = new URL("../migrations/", import.meta.url);

function shippedFiles(): string[] {
	return readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith(".sql"))
		.sort();
}

function shippedFile(name: string): string {
	return readFileSync(new URL(name, migrationsDirectory), "utf8");
}

const everyShippedMigration = [
	initialSchema,
	identityModeMigration("email"),
	identityModeMigration("username"),
	identityModeMigration("username_email"),
];

describe("the SQL the operator reads and the SQL the runner executes", () => {
	it("has a file on disk for every migration the library carries", () => {
		expect(shippedFiles()).toEqual([
			"0001_initial_schema.sql",
			"0002_identity_email.sql",
			"0002_identity_username.sql",
			"0002_identity_username_email.sql",
		]);
	});

	it("has a migration in the library for every file on disk", () => {
		const embedded = new Set(everyShippedMigration.map((migration) => migration.sql));

		for (const name of shippedFiles()) {
			expect({ name, embedded: embedded.has(shippedFile(name)) }).toEqual({
				name,
				embedded: true,
			});
		}
	});

	it("hashes each pair to the same checksum", () => {
		const pairs: readonly [string, string][] = [
			["0001_initial_schema.sql", initialSchema.sql],
			["0002_identity_email.sql", identityModeMigration("email").sql],
			["0002_identity_username.sql", identityModeMigration("username").sql],
			["0002_identity_username_email.sql", identityModeMigration("username_email").sql],
		];

		for (const [name, embedded] of pairs) {
			expect(migrationChecksum({ version: 0, name, sql: shippedFile(name) })).toBe(
				migrationChecksum({ version: 0, name, sql: embedded }),
			);
		}
	});

	it("notices a single changed byte", () => {
		const shipped = shippedFile("0001_initial_schema.sql");

		expect(migrationChecksum({ version: 1, name: "x", sql: `${shipped} ` })).not.toBe(
			migrationChecksum({ version: 1, name: "x", sql: shipped }),
		);
	});

	it("ships a plan whose version numbers are the file prefixes", () => {
		expect(coreMigrations("email").map((migration) => migration.version)).toEqual([1, 2]);
		expect(coreMigrations("username").map((migration) => migration.name)).toEqual([
			"initial_schema",
			"identity_username",
		]);
	});
});
