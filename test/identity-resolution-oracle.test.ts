import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	type IdentityConfiguration,
	resolveIdentityConfiguration,
} from "../src/core/identity/configuration.js";
import { findUserByIdentifier } from "../src/core/identity/resolution.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

const schema = `velve_identity_oracle_${randomBytes(4).toString("hex")}`;
const CONFIGURATIONS: Readonly<Record<IdentityMode, IdentityConfiguration>> = {
	email: resolveIdentityConfiguration({ mode: "email" }),
	username: resolveIdentityConfiguration({ mode: "username" }),
	username_email: resolveIdentityConfiguration({ mode: "username_email" }),
};

let connection: TestConnection;

interface RecordedQuery {
	readonly sql: string;
	readonly params: readonly unknown[];
}

function recording(log: RecordedQuery[]): Driver {
	return {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			log.push({ sql, params });
			return connection.query<T>(sql, params);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return connection.transaction(fn);
		},
	};
}

const refusing: Driver = {
	query(): Promise<never[]> {
		return Promise.reject(new Error("reached the driver"));
	},
	transaction(): Promise<never> {
		return Promise.reject(new Error("reached the driver"));
	},
};

function shapeOf(params: readonly unknown[]): string {
	return params.map((value) => (value === null ? "null" : "value")).join(",");
}

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("username_email") });
	await connection.query(
		`INSERT INTO ${schema}.user (email, username, username_key) VALUES ($1, $2, $3)`,
		["known@example.test", "Known", "known"],
	);
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

async function resolveWith(
	mode: IdentityMode,
	identifier: string,
	driver: Driver,
): Promise<unknown> {
	return findUserByIdentifier({
		driver,
		schema,
		configuration: CONFIGURATIONS[mode],
		identifier,
	});
}

const EXISTING_AND_ABSENT: readonly (readonly [string, string])[] = [
	["known@example.test", "absent@example.test"],
	["KNOWN@EXAMPLE.TEST", "ABSENT@EXAMPLE.TEST"],
	["known", "absen"],
	["Known", "Absen"],
];

async function comparedPair(existing: string, absent: string): Promise<string> {
	const log: RecordedQuery[] = [];
	const driver = recording(log);
	const found = await resolveWith("username_email", existing, driver);
	const missing = await resolveWith("username_email", absent, driver);
	const [first, second] = log;
	if (first === undefined || second === undefined) {
		return `${existing}: fewer than two statements`;
	}
	if (found === null || missing !== null) {
		return `${existing}: the fixture does not separate found from absent`;
	}
	if (first.sql !== second.sql) {
		return `${existing}: two different statements`;
	}
	return shapeOf(first.params) === shapeOf(second.params)
		? `${existing}: identical`
		: `${existing}: ${shapeOf(first.params)} against ${shapeOf(second.params)}`;
}

const REFUSED_SPELLINGS: readonly string[] = [
	"",
	" ",
	"*",
	"%",
	"ali%ce",
	"аlice",
	"‮alice",
	"ali​ce",
	"İstanbul",
	"a".repeat(10_000),
	"@",
	"a@b@c",
	"@example.test",
	"alice@",
];

describe("resolution costs the same whether or not the identifier names an account", () => {
	it("reaches the driver for every identifier, refused spellings included", async () => {
		const outcomes: string[] = [];
		for (const mode of Object.keys(CONFIGURATIONS) as IdentityMode[]) {
			for (const identifier of [...REFUSED_SPELLINGS, "known@example.test", "known"]) {
				const reached = await resolveWith(mode, identifier, refusing).then(
					() => "returned without asking the database",
					() => "asked the database",
				);
				if (reached !== "asked the database") {
					outcomes.push(`${mode} / ${JSON.stringify(identifier.slice(0, 12))}: ${reached}`);
				}
			}
		}
		expect(outcomes).toEqual([]);
	});

	it("issues exactly one statement, and the same one, for every identifier in every mode", async () => {
		const log: RecordedQuery[] = [];
		const driver = recording(log);
		const identifiers = [...REFUSED_SPELLINGS, "known@example.test", "known", "Known"];
		for (const mode of Object.keys(CONFIGURATIONS) as IdentityMode[]) {
			for (const identifier of identifiers) {
				await resolveWith(mode, identifier, driver);
			}
		}
		expect(log.length).toBe(identifiers.length * 3);
		expect(new Set(log.map((entry) => entry.sql)).size).toBe(1);
		expect(new Set(log.map((entry) => entry.params.length))).toEqual(new Set([2]));
	});

	it("gives an existing and an absent identifier the same statement and the same parameter shape", async () => {
		const observed: string[] = [];
		for (const [existing, absent] of EXISTING_AND_ABSENT) {
			observed.push(await comparedPair(existing, absent));
		}
		expect(observed).toEqual(EXISTING_AND_ABSENT.map(([existing]) => `${existing}: identical`));
	});

	it("passes the identifier through the normaliser of every column the mode configures", async () => {
		const observed: Record<string, string> = {};
		for (const mode of Object.keys(CONFIGURATIONS) as IdentityMode[]) {
			for (const identifier of ["known@example.test", "known", "*"]) {
				const log: RecordedQuery[] = [];
				await resolveWith(mode, identifier, recording(log));
				observed[`${mode} / ${identifier}`] = shapeOf(log[0]?.params ?? []);
			}
		}
		expect(observed).toEqual({
			"email / known@example.test": "value,null",
			"email / known": "null,null",
			"email / *": "null,null",
			"username / known@example.test": "null,null",
			"username / known": "null,value",
			"username / *": "null,null",
			"username_email / known@example.test": "value,null",
			"username_email / known": "null,value",
			"username_email / *": "null,null",
		});
	});

	it("finds the account through either column and returns the same row", async () => {
		const byEmail = await resolveWith("username_email", "  KNOWN@Example.TEST ", connection);
		const byName = await resolveWith("username_email", " KNOWN ", connection);
		expect(byEmail).toEqual({
			id: expect.any(String),
			email: "known@example.test",
			username: "Known",
			emailVerified: false,
			disabled: false,
		});
		expect(byName).toEqual(byEmail);
	});
});
