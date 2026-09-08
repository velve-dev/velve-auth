import { describe, expect, it } from "vitest";
import type { Actor, ResolvedSession } from "../src/index.js";
import {
	actorOfResolvedSession,
	createOwnedRowRepository,
	type OwnedRowRepository,
	type OwnedRowRepositoryOptions,
	UnknownColumnError,
	VELVE_AUTH_VERSION,
} from "../src/index.js";
import type {
	AppliedMigration,
	Driver,
	IdentityMode,
	Migration,
	MigrationReport,
	MigrationRunnerOptions,
	SchemaStatus,
	SchemaStatusOptions,
} from "../src/schema/index.js";
import {
	assertSchemaUpToDate,
	coreMigrations,
	MigrationRefusedError,
	MissingCascadeError,
	readSchemaStatus,
	runMigrations,
	SchemaVersionMismatchError,
	UnrewritableMigrationError,
} from "../src/schema/index.js";

const driver: Driver = {
	query: async () => [],
	transaction: (fn) => fn(driver),
};

describe("@velve/auth", () => {
	it("hands out the actor constructor and the owner-scoped repository", () => {
		const actor: Actor = actorOfResolvedSession({ userId: "not-a-uuid" });
		const options: OwnedRowRepositoryOptions = { driver, schema: "velve", table: "session" };
		const repository: OwnedRowRepository<{ id: string }> = createOwnedRowRepository(options);

		expect(actor).toBe("not-a-uuid");
		expect(typeof repository.deleteOwnedRow).toBe("function");
		expect(new UnknownColumnError("velve.session", "user_id").code).toBe("unknown_column");
		expect(VELVE_AUTH_VERSION).toBe("0.0.0");
	});

	it("names the shape session resolution must return", () => {
		// @ts-expect-error E-93: a plain object is not what session resolution produces.
		const forged: ResolvedSession = { userId: "00000000-0000-4000-8000-000000000000" };

		expect(forged.userId).toBe("00000000-0000-4000-8000-000000000000");
	});
});

describe("@velve/auth/schema", () => {
	it("hands out the runner, the plan and the status query", () => {
		const mode: IdentityMode = "username_email";
		const plan: readonly Migration[] = coreMigrations(mode);
		const runnerOptions: MigrationRunnerOptions = { driver, migrations: plan };
		const statusOptions: SchemaStatusOptions = { driver, migrations: plan };

		expect(plan.map((migration) => migration.version)).toEqual([1, 2]);
		expect(typeof runMigrations).toBe("function");
		expect(typeof readSchemaStatus).toBe("function");
		expect(typeof assertSchemaUpToDate).toBe("function");
		expect(runnerOptions.migrations).toBe(statusOptions.migrations);
	});

	it("hands out the errors a caller has to distinguish", () => {
		expect(new MigrationRefusedError("migration_duplicate_version", "x").code).toBe(
			"migration_duplicate_version",
		);
		expect(new MissingCascadeError("x").code).toBe("migration_missing_cascade");
		expect(new UnrewritableMigrationError("x").code).toBe("migration_unrewritable_body");
		const status: SchemaStatus = {
			currentVersion: 1,
			expectedVersion: 2,
			appliedVersions: [1],
			pendingVersions: [2],
			changedVersions: [],
			upToDate: false,
		};
		expect(new SchemaVersionMismatchError(status).code).toBe("schema_version_mismatch");
	});

	it("names the ledger row and the report a caller reads back", () => {
		const applied: AppliedMigration = { version: 1, name: "initial_schema", checksum: "00" };
		const report: MigrationReport = { appliedVersions: [1], currentVersion: 1 };

		expect(report.currentVersion).toBe(applied.version);
	});
});
