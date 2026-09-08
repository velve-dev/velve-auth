import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidIdentifierError } from "../src/core/db/identifier.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { createOwnedRowRepository } from "../src/core/db/repositories/owned-row-repository.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";

// Identifiers cannot be bound as parameters, so every one of these reaches SQL by
// interpolation and the only defence is the check in src/core/db/identifier.ts.
const HOSTILE_NAMES: readonly string[] = [
	'velve"; DROP SCHEMA public CASCADE; --',
	"velve; DROP TABLE velve.user; --",
	"velve.user",
	"velve user",
	"velve--",
	"velve/*x*/",
	"velve'",
	'velve"',
	"velve`",
	"VELVE",
	"Velve",
	"vel­ve",
	`velve${String.fromCharCode(0)}`,
	"velve\n",
	"velve\t",
	"velve ",
	" velve",
	"1velve",
	"",
	"пользователь",
	"v".repeat(64),
];

let migrated: MigratedSchema;
let actor: ReturnType<typeof actorOfTestUser>;

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_injection");
	actor = actorOfTestUser(await createUser(migrated.connection, migrated.schema));
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("identifiers that reach SQL by interpolation", () => {
	it("refuses every hostile schema name before a statement is sent", async () => {
		for (const name of HOSTILE_NAMES) {
			await expect(
				runMigrations({
					driver: migrated.connection,
					schema: name,
					migrations: coreMigrations("email"),
				}),
			).rejects.toBeInstanceOf(InvalidIdentifierError);
		}
	});

	it("leaves the database untouched by the attempt", async () => {
		const [row] = await migrated.connection.query<{ present: number }>(
			"SELECT count(*)::int AS present FROM information_schema.schemata WHERE schema_name = 'public'",
			[],
		);

		expect(row?.present).toBe(1);
	});

	it("refuses a hostile table, id column, owner column or updatable column", () => {
		for (const name of HOSTILE_NAMES) {
			expect(() =>
				createOwnedRowRepository({
					driver: migrated.connection,
					schema: migrated.schema,
					table: name,
				}),
			).toThrow(InvalidIdentifierError);
			expect(() =>
				createOwnedRowRepository({
					driver: migrated.connection,
					schema: migrated.schema,
					table: "webauthn_credential",
					idColumn: name,
				}),
			).toThrow(InvalidIdentifierError);
			expect(() =>
				createOwnedRowRepository({
					driver: migrated.connection,
					schema: migrated.schema,
					table: "webauthn_credential",
					ownerColumn: name,
				}),
			).toThrow(InvalidIdentifierError);
			expect(() =>
				createOwnedRowRepository({
					driver: migrated.connection,
					schema: migrated.schema,
					table: "webauthn_credential",
					updatableColumns: [name],
				}),
			).toThrow(InvalidIdentifierError);
		}
	});

	it("refuses a hostile key in the values of an update", async () => {
		const repository = createOwnedRowRepository({
			driver: migrated.connection,
			schema: migrated.schema,
			table: "webauthn_credential",
			updatableColumns: ["label"],
		});

		for (const name of ["label = 'x', user_id", 'label"', "user_id", "__proto__", "constructor"]) {
			await expect(
				repository.updateOwnedRow({
					id: "00000000-0000-4000-8000-000000000000",
					actor,
					values: { [name]: "x" },
				}),
			).rejects.toMatchObject({ code: "unknown_column" });
		}
	});

	it("binds the actor as a parameter rather than splicing it into the statement", async () => {
		const repository = createOwnedRowRepository({
			driver: migrated.connection,
			schema: migrated.schema,
			table: "webauthn_credential",
		});

		await expect(
			repository.listOwnedRows({
				actor: actorOfTestUser("' OR true --"),
			}),
		).rejects.toMatchObject({ sqlState: "22P02" });
	});
});
