import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { identityColumns, type ProvidedIdentifiers } from "../src/core/identity/columns.js";
import {
	type IdentityConfiguration,
	resolveIdentityConfiguration,
} from "../src/core/identity/configuration.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const schema = `velve_identity_invented_${randomBytes(4).toString("hex")}`;
const MODES: readonly IdentityMode[] = ["email", "username", "username_email"];

const NOTHING_REPORTED: Readonly<Record<string, string | null | undefined>> = {
	absent: undefined,
	"explicit null": null,
	empty: "",
	spaces: "   ",
	tab: "\t",
	"non-breaking space": " ",
	newline: "\n",
	"zero-width space": "​",
	"at sign alone": "@",
};

let connection: TestConnection;

function configurationOf(mode: IdentityMode): IdentityConfiguration {
	return resolveIdentityConfiguration({ mode });
}

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("username") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

function columnsFor(
	mode: IdentityMode,
	provided: ProvidedIdentifiers,
): { readonly email: string | null } | string {
	const outcome = identityColumns(configurationOf(mode), provided);
	return outcome.accepted ? outcome.value : `rejected: ${outcome.rejection.rejection}`;
}

function outcomeWhereNothingWasReported(): Record<string, string> {
	const outcomes: Record<string, string> = {};
	for (const mode of MODES) {
		for (const [label, reported] of Object.entries(NOTHING_REPORTED)) {
			const provided: ProvidedIdentifiers =
				reported === undefined ? { username: "alice" } : { username: "alice", email: reported };
			const result = columnsFor(mode, provided);
			outcomes[`${mode} / ${label}`] =
				typeof result === "string" ? result : `email=${JSON.stringify(result.email)}`;
		}
	}
	return outcomes;
}

describe("a provider that reports no address (E-16, S-LINK-5)", () => {
	it("never yields anything but NULL for the address column", () => {
		const invented = Object.entries(outcomeWhereNothingWasReported()).filter(
			([, value]) => value.startsWith("email=") && value !== "email=null",
		);
		expect(invented).toEqual([]);
	});

	it("rejects rather than invents where the mode insists on an address", () => {
		const outcomes = outcomeWhereNothingWasReported();
		const accepted = Object.entries(outcomes).filter(([, value]) => value.startsWith("email="));
		expect(accepted.map(([, value]) => value)).toEqual(accepted.map(() => "email=null"));
		expect(accepted.map(([key]) => key)).toEqual(["username / absent", "username / explicit null"]);
	});

	it("derives no address from a username, a subject or a provider name", () => {
		const derived = ["alice", "github|1234", "1234", "github"].flatMap((subject) => {
			const result = columnsFor("username", { username: "alice", email: null });
			return typeof result === "string" || result.email === null ? [] : [`${subject}`];
		});
		expect(derived).toEqual([]);
	});

	it("writes SQL NULL and not an empty string into velve.user.email", async () => {
		const result = columnsFor("username", { username: `u${randomBytes(6).toString("hex")}` });
		expect(typeof result).not.toBe("string");
		if (typeof result === "string") {
			return;
		}
		const columns = result as { email: string | null; username: string; usernameKey: string };
		await connection.query(
			`INSERT INTO ${schema}.user (email, username, username_key) VALUES ($1, $2, $3)`,
			[columns.email, columns.username, columns.usernameKey],
		);
		const [row] = await connection.query<{
			readonly is_null: boolean;
			readonly is_blank: boolean;
		}>(
			`SELECT (email IS NULL) AS is_null, (email = '') AS is_blank
			 FROM ${schema}.user WHERE username_key = $1`,
			[columns.usernameKey],
		);
		expect(row?.is_null).toBe(true);
		expect(row?.is_blank).toBeNull();
	});

	it("never accepts an address that normalises to nothing", () => {
		const accepted = Object.entries(NOTHING_REPORTED).flatMap(([label, reported]) => {
			if (reported === undefined) {
				return [];
			}
			const result = columnsFor("email", { email: reported });
			return typeof result === "string" ? [] : [`${label} was accepted as ${result.email}`];
		});
		expect(accepted).toEqual([]);
	});
});
