import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createSessionRepository,
	type SessionRepository,
} from "../src/core/db/repositories/session.js";
import { InvalidSessionConfigError, sessionSettingsOf } from "../src/core/session/config.js";
import type { Duration } from "../src/core/session/duration.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { DAY, sessionInsertFor } from "./session-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
/** This file names both shapes in order to reject them, so it is the one file the scan skips. */
const THE_SCAN_ITSELF = "test/session-deadline-interval.test.ts";
const SCANNED_EXTENSIONS = /\.(ts|mts|mjs|js|sql)$/;
const WHAT_THE_LIBRARY_SHIPS = /^(?:src|migrations|tools)\//;

const A_VALUE_RENDERED_BEFORE_AN_INTERVAL_UNIT =
	/\$\{[^}]*\}[ \t]+(?:millisecond|second|minute|hour|day|week|month|year)s?\b/g;
const A_PARAMETER_CAST_TO_AN_INTERVAL = /\$\d+::interval\b/g;

/** PostgreSQL below 15 caps an interval literal's millisecond and second fields at this (E-1571). */
const THE_FIELD_CAP_BELOW_POSTGRESQL_15 = 2_147_483_647;

function scannedFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" })
		.split("\0")
		.filter(Boolean)
		.filter((path) => SCANNED_EXTENSIONS.test(path))
		.filter((path) => path !== THE_SCAN_ITSELF);
}

function hits(pattern: RegExp, paths: string[]): string[] {
	return paths.flatMap((path) => {
		const contents = readFileSync(`${repositoryRoot}${path}`, "utf8");
		return [...contents.matchAll(pattern)].map((match) => `${path}: ${match[0]}`);
	});
}

describe("no duration is written as an interval literal", () => {
	it("renders no value directly before an interval unit, anywhere in the tree", () => {
		expect(hits(A_VALUE_RENDERED_BEFORE_AN_INTERVAL_UNIT, scannedFiles())).toEqual([]);
	});

	it("binds no interval parameter in what the library ships", () => {
		const shipped = scannedFiles().filter((path) => WHAT_THE_LIBRARY_SHIPS.test(path));

		expect(hits(A_PARAMETER_CAST_TO_AN_INTERVAL, shipped)).toEqual([]);
		expect(shipped.length).toBeGreaterThan(100);
	});

	it("reads a tree large enough for those answers to mean something", () => {
		expect(scannedFiles().length).toBeGreaterThan(200);
	});
});

describe("a deadline the configuration cannot state exactly is refused at startup", () => {
	function refusalFor(absoluteTimeout: Duration): string {
		try {
			sessionSettingsOf({ absoluteTimeout });
		} catch (error) {
			return error instanceof InvalidSessionConfigError ? error.message : "not refused";
		}
		return "not refused";
	}

	it("takes the longest deadline it can state in milliseconds", () => {
		const settings = sessionSettingsOf({
			idleTimeout: "104249991d",
			absoluteTimeout: "104249991d",
		});

		expect(settings.absoluteTimeoutMs).toBe(104_249_991 * DAY);
		expect(Number.isSafeInteger(settings.absoluteTimeoutMs)).toBe(true);
	});

	it("refuses the next whole day above it, and names the option", () => {
		expect(refusalFor("104249992d")).toContain(
			"session.absoluteTimeout is longer than a deadline this library can state exactly",
		);
	});

	it("refuses a duration whose milliseconds no longer land on whole numbers", () => {
		expect(refusalFor("99999999999999999999d")).toContain("absoluteTimeout is longer than");
	});

	it("refuses a duration so long that reading it gives up on being a number at all", () => {
		expect(refusalFor(`${"9".repeat(400)}d` as Duration)).toContain(
			"absoluteTimeout is longer than",
		);
	});
});

describe("the deadlines the database actually stores (PostgreSQL 14 and newer)", () => {
	let migrated: MigratedSchema;
	let sessions: SessionRepository;
	let userId: string;

	beforeAll(async () => {
		migrated = await openMigratedSchema("sessioninterval");
		sessions = createSessionRepository({
			driver: migrated.connection,
			schema: migrated.schema,
		});
		userId = await createUser(migrated.connection, migrated.schema);
	});

	afterAll(async () => {
		await dropSchema(migrated.connection, migrated.schema);
	});

	it("writes the default 30-day absolute deadline, which is past the field cap in milliseconds", async () => {
		expect(30 * DAY).toBeGreaterThan(THE_FIELD_CAP_BELOW_POSTGRESQL_15);

		const session = await sessions.insertSession(sessionInsertFor(userId));
		const lived = session.absoluteExpiresAt.getTime() - session.createdAt.getTime();

		expect(Math.round(lived / 1000)).toBe((30 * DAY) / 1000);
	});

	it("writes a deadline one millisecond past the cap", async () => {
		const past = THE_FIELD_CAP_BELOW_POSTGRESQL_15 + 1;
		const session = await sessions.insertSession(
			sessionInsertFor(userId, { idleTimeoutMs: past, absoluteTimeoutMs: past }),
		);
		const lived = session.absoluteExpiresAt.getTime() - session.createdAt.getTime();

		expect(Math.round(lived / 1000)).toBe(Math.round(past / 1000));
	});

	it("keeps sub-second precision, which the millisecond literal also had", async () => {
		const session = await sessions.insertSession(
			sessionInsertFor(userId, { idleTimeoutMs: 1_500, absoluteTimeoutMs: 2_500 }),
		);

		expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(2_500);
		expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBe(1_500);
	});
});
