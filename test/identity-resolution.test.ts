import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { resolveIdentityConfiguration } from "../src/core/identity/configuration.js";
import {
	findUserByIdentifier,
	type ResolvedUserIdentity,
	type UserLookup,
	type UsernameAvailability,
	type UsernameLookup,
	usernameAvailability,
} from "../src/core/identity/resolution.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const schema = `velve_identity_resolution_${randomBytes(4).toString("hex")}`;
const configuration = resolveIdentityConfiguration({ mode: "username_email" });
let connection: TestConnection;

interface RecordedQuery {
	readonly sql: string;
	readonly params: readonly unknown[];
}

function recording(driver: Driver, log: RecordedQuery[]): Driver {
	return {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			log.push({ sql, params });
			return driver.query<T>(sql, params);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return driver.transaction(fn);
		},
	};
}

function lookupOf(identifier: string, driver: Driver = connection): UserLookup {
	return { driver, schema, configuration, identifier };
}

function availabilityOf(candidate: string): Promise<UsernameAvailability> {
	const lookup: UsernameLookup = {
		driver: connection,
		schema,
		rules: configuration.username,
		candidate,
	};
	return usernameAvailability(lookup);
}

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({
		driver: connection,
		schema,
		migrations: coreMigrations("username_email"),
	});
	await connection.query(
		`INSERT INTO ${schema}.user (email, email_verified_at, username, username_key)
		 VALUES ($1, now(), $2, $3)`,
		["alice@example.test", "Alice", "alice"],
	);
	await connection.query(
		`INSERT INTO ${schema}.user (email, username, username_key, disabled_at)
		 VALUES ($1, $2, $3, now())`,
		["mallory@example.test", "Mallory", "mallory"],
	);
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

describe("identifier resolution", () => {
	it("reaches the account through either identifier", async () => {
		const byEmail: ResolvedUserIdentity | null = await findUserByIdentifier(
			lookupOf("  ALICE@Example.TEST "),
		);
		const byUsername = await findUserByIdentifier(lookupOf("ALICE"));
		expect(byEmail).toEqual({
			id: byEmail?.id,
			email: "alice@example.test",
			username: "Alice",
			emailVerified: true,
			disabled: false,
		});
		expect(byUsername?.id).toBe(byEmail?.id);
	});

	it("reports a disabled account as disabled rather than hiding it from its owner", async () => {
		const found = await findUserByIdentifier(lookupOf("mallory"));
		expect([found?.disabled, found?.emailVerified]).toEqual([true, false]);
	});

	it("does the same work for an identifier that names nobody and one the allowlist refuses", async () => {
		const log: RecordedQuery[] = [];
		const driver = recording(connection, log);
		const identifiers = [
			"alice@example.test",
			"alice",
			"nobody@example.test",
			"nobody",
			"",
			"*",
			"a".repeat(400),
			"‮alice",
		];
		for (const identifier of identifiers) {
			await findUserByIdentifier(lookupOf(identifier, driver));
		}
		expect(log.length).toBe(identifiers.length);
		expect(new Set(log.map((entry) => entry.sql)).size).toBe(1);
		expect(log.every((entry) => entry.params.length === 2)).toBe(true);
	});

	it("looks in one column only where the configuration has one identifier", async () => {
		const log: RecordedQuery[] = [];
		const driver = recording(connection, log);
		await findUserByIdentifier({
			driver,
			schema,
			configuration: resolveIdentityConfiguration({ mode: "email" }),
			identifier: "alice",
		});
		await findUserByIdentifier({
			driver,
			schema,
			configuration: resolveIdentityConfiguration({ mode: "username" }),
			identifier: "alice@example.test",
		});
		expect(log.map((entry) => entry.params)).toEqual([
			[null, null],
			[null, null],
		]);
	});
});

describe("username availability", () => {
	it("answers with the fields the route is allowed to return", async () => {
		expect(await availabilityOf("brand-new")).toEqual({ available: true });
	});

	it("names the taken name and the refused spelling apart", async () => {
		expect(await availabilityOf("ALICE")).toEqual({ available: false, reason: "taken" });
		expect(await availabilityOf("ali*")).toEqual({
			available: false,
			reason: "invalid_characters",
		});
	});

	it("returns no list of near matches for a wildcard", async () => {
		expect(Object.keys(await availabilityOf("ali%")).sort()).toEqual(["available", "reason"]);
	});
});
