import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import {
	type IdentityMode,
	identityModeMigration,
} from "../src/core/db/migrations/identity-mode.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	type IdentifierKind,
	type IdentityColumns,
	identityColumns,
	REQUIRED_IDENTIFIERS,
} from "../src/core/identity/columns.js";
import { resolveIdentityConfiguration } from "../src/core/identity/configuration.js";
import { normaliseEmail, normaliseUsername } from "../src/core/identity/normalise.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const MODES: readonly IdentityMode[] = ["email", "username", "username_email"];
const PRESENCE: readonly (readonly IdentifierKind[])[] = [
	[],
	["email"],
	["username"],
	["email", "username"],
];

const CONSTRAINT_CLAUSE = /\b(email|username)\s+IS NOT NULL/g;

function identifiersDemandedBy(sql: string): string[] {
	return [...sql.matchAll(CONSTRAINT_CLAUSE)].map((clause) => String(clause[1]));
}

let connection: TestConnection;
const schemas: Record<string, string> = {};

function schemaOf(mode: IdentityMode): string {
	const schema = schemas[mode];
	if (schema === undefined) {
		throw new Error(`no schema was migrated for the mode ${mode}`);
	}
	return schema;
}

beforeAll(async () => {
	connection = await openTestConnection();
	for (const mode of MODES) {
		const schema = `velve_identity_${mode}_${randomBytes(4).toString("hex")}`;
		await runMigrations({ driver: connection, schema, migrations: coreMigrations(mode) });
		schemas[mode] = schema;
	}
});

afterAll(async () => {
	for (const schema of Object.values(schemas)) {
		await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	}
	await connection.close();
});

function storedIdentifiers(columns: IdentityColumns): IdentifierKind[] {
	const stored: IdentifierKind[] = [];
	if (columns.email !== null) {
		stored.push("email");
	}
	if (columns.username !== null) {
		stored.push("username");
	}
	return stored;
}

async function databaseAcceptsRow(
	mode: IdentityMode,
	present: readonly IdentifierKind[],
): Promise<boolean> {
	const suffix = randomBytes(6).toString("hex");
	const name = present.includes("username") ? `u${suffix}` : null;
	try {
		await connection.query(
			`INSERT INTO ${schemaOf(mode)}.user (email, username, username_key) VALUES ($1, $2, $3)`,
			[present.includes("email") ? `${suffix}@example.test` : null, name, name],
		);
		return true;
	} catch {
		return false;
	}
}

interface Attempt {
	readonly produced: boolean;
	readonly refusal: string | null;
}

async function attemptColumns(
	mode: IdentityMode,
	present: readonly IdentifierKind[],
): Promise<Attempt> {
	const outcome = identityColumns(resolveIdentityConfiguration({ mode }), {
		email: present.includes("email") ? "Alice@Example.test" : null,
		username: present.includes("username") ? "Alice" : null,
	});
	if (!outcome.accepted) {
		return { produced: false, refusal: null };
	}
	const accepted = await databaseAcceptsRow(mode, storedIdentifiers(outcome.value));
	return {
		produced: true,
		refusal: accepted ? null : `${mode} refused ${present.join(" and ")}`,
	};
}

describe("identity mode constraint", () => {
	it("demands in the runtime what the shipped migration demands in SQL", () => {
		for (const mode of MODES) {
			expect([mode, identifiersDemandedBy(identityModeMigration(mode).sql)]).toEqual([
				mode,
				[...REQUIRED_IDENTIFIERS[mode]],
			]);
		}
	});

	it("reads no identifier out of a constraint that demands none", () => {
		expect(identifiersDemandedBy("ADD CONSTRAINT user_identity_mode CHECK (true);")).toEqual([]);
	});

	it("refuses in the database exactly the rows that lack a required identifier", async () => {
		for (const mode of MODES) {
			for (const present of PRESENCE) {
				const expected = REQUIRED_IDENTIFIERS[mode].every((kind) => present.includes(kind));
				expect([mode, present, await databaseAcceptsRow(mode, present)]).toEqual([
					mode,
					present,
					expected,
				]);
			}
		}
	});

	it("never produces columns the database would refuse", async () => {
		const attempts: Attempt[] = [];
		for (const mode of MODES) {
			for (const present of PRESENCE) {
				attempts.push(await attemptColumns(mode, present));
			}
		}
		expect(attempts.filter((attempt) => attempt.produced).length).toBe(4);
		expect(
			attempts.flatMap((attempt) => (attempt.refusal === null ? [] : [attempt.refusal])),
		).toEqual([]);
	});
});

describe("normalised values against the schema CHECKs", () => {
	it("stores every address the normaliser accepts", async () => {
		const schema = schemaOf("email");
		for (const address of [
			"Alice@Example.COM",
			"ＡＬＩＣＥ＠a.test",
			"İstanbul@example.test",
			"STRAẞE@example.test",
			"ΑΣ@example.test",
			"Ǆ@example.test",
		]) {
			const normalised = normaliseEmail(address);
			expect([address, normalised.accepted]).toEqual([address, true]);
			if (!normalised.accepted) {
				continue;
			}
			const stored = `${randomBytes(6).toString("hex")}+${normalised.value}`;
			await connection.query(`INSERT INTO ${schema}.user (email) VALUES ($1)`, [stored]);
			const [row] = await connection.query<{ readonly normalised: boolean }>(
				`SELECT (email = lower(email)) AS normalised FROM ${schema}.user WHERE email = $1`,
				[stored],
			);
			expect([address, row?.normalised]).toEqual([address, true]);
		}
	});

	it("stores every username key the normaliser accepts", async () => {
		const schema = schemaOf("username");
		const configuration = resolveIdentityConfiguration({ mode: "username" });
		for (const candidate of ["Alice", "ＢＯＢ", "carol-1", "d_e_f"]) {
			const normalised = normaliseUsername(
				`${candidate}${randomBytes(4).toString("hex")}`,
				configuration.username,
			);
			expect([candidate, normalised.accepted]).toEqual([candidate, true]);
			if (!normalised.accepted) {
				continue;
			}
			await connection.query(
				`INSERT INTO ${schema}.user (username, username_key) VALUES ($1, $2)`,
				[normalised.value.username, normalised.value.usernameKey],
			);
			const [row] = await connection.query<{ readonly normalised: boolean }>(
				`SELECT (username_key = lower(username_key)) AS normalised
				 FROM ${schema}.user WHERE username_key = $1`,
				[normalised.value.usernameKey],
			);
			expect([candidate, row?.normalised]).toEqual([candidate, true]);
		}
	});
});
