export { MissingCascadeError } from "../core/db/cascade-guard.js";
export type { Driver } from "../core/db/driver.js";
export { InvalidIdentifierError } from "../core/db/identifier.js";
export type { AppliedMigration, Migration, MigrationReport } from "../core/db/migration.js";
export {
	MigrationRefusedError,
	type MigrationRunnerOptions,
	runMigrations,
} from "../core/db/migration-runner.js";
export type { IdentityMode } from "../core/db/migrations/identity-mode.js";
export { coreMigrations } from "../core/db/migrations/index.js";
export {
	assertSchemaUpToDate,
	readSchemaStatus,
	type SchemaStatus,
	type SchemaStatusOptions,
	SchemaVersionMismatchError,
} from "../core/db/schema-status.js";
