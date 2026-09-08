import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { createSessionToken } from "../src/core/session/token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import {
	type CountedDriver,
	countingDriver,
	DAY,
	HOUR,
	MINUTE,
	statementsMatching,
	testClock,
} from "./session-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };

let migrated: MigratedSchema;
let counted: CountedDriver;
let service: SessionService;
let userId: string;

function serviceOver(driver: CountedDriver): SessionService {
	return createSessionService({
		driver: driver.driver,
		schema: migrated.schema,
		clock: testClock(),
	});
}

async function shiftDeadline(sessionId: string, column: string, by: string): Promise<void> {
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session SET ${column} = ${column} - $2::interval
		 WHERE id = $1 AND user_id = $3`,
		[sessionId, by, userId],
	);
}

async function age(sessionId: string, by: string): Promise<void> {
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session
		 SET created_at = created_at - $2::interval, last_used_at = last_used_at - $2::interval
		 WHERE id = $1 AND user_id = $3`,
		[sessionId, by, userId],
	);
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_session_resolution");
	counted = countingDriver(migrated.connection);
	service = serviceOver(counted);
	userId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("resolving a session (S-CACHE-1, S-CACHE-2)", () => {
	it("answers with the session and the user it belongs to", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });

		const resolved = await service.resolve(issued.token);

		expect(resolved?.userId).toBe(userId);
		expect(resolved?.session.id).toBe(issued.session.id);
		expect(resolved?.session.factors).toEqual(["password"]);
	});

	it("answers null for a token no row carries", async () => {
		expect(await service.resolve(createSessionToken().token)).toBeNull();
	});

	it("answers null once the idle deadline has passed", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shiftDeadline(issued.session.id, "idle_expires_at", "8 days");

		expect(await service.resolve(issued.token)).toBeNull();
	});

	it("answers null once the absolute deadline has passed", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shiftDeadline(issued.session.id, "absolute_expires_at", "31 days");

		expect(await service.resolve(issued.token)).toBeNull();
	});

	it("asks the database every single time (ratio 1.0)", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		counted.reset();

		for (let call = 0; call < 10; call += 1) {
			expect(await service.resolve(issued.token)).not.toBeNull();
		}

		expect(statementsMatching(counted, /FROM \S+\.session s/)).toHaveLength(10);
		expect(counted.statements).toHaveLength(10);
	});
});

describe("a disabled account (L-4, S-CACHE-3)", () => {
	it("stops the next request of an existing session with account_disabled", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		expect(await service.resolve(issued.token)).not.toBeNull();

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = now() WHERE id = $1`,
			[userId],
		);

		await expect(service.resolve(issued.token)).rejects.toMatchObject({
			code: "account_disabled",
		});
	});

	it("acts on the first following request, with no lifetime to wait out", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		const failure = await service.resolve(issued.token).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(VelveError);
		expect((failure as VelveError).httpStatus).toBe(403);

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = NULL WHERE id = $1`,
			[userId],
		);
		expect(await service.resolve(issued.token)).not.toBeNull();
	});

	it("names that code in exactly one module of the library", () => {
		const core = fileURLToPath(new URL("../src/core/", import.meta.url));
		const naming = readdirSync(core, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.filter((path) =>
				/throw new VelveError\("account_disabled"\)/.test(readFileSync(path, "utf8")),
			)
			.map((path) => path.replace(core, ""));

		expect(naming).toEqual(["session/service.ts"]);
	});
});

describe("the idle deadline (architecture 3.5)", () => {
	it("is not written again inside the write interval", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		counted.reset();

		await service.resolve(issued.token);
		await service.resolve(issued.token);

		expect(counted.statements).toHaveLength(2);
	});

	it("is written once the interval has passed, and moves forward", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await age(issued.session.id, "2 hours");
		counted.reset();

		const resolved = await service.resolve(issued.token);

		expect(statementsMatching(counted, /^UPDATE/)).toHaveLength(1);
		expect(resolved?.session.idleExpiresAt.getTime()).toBeGreaterThan(
			issued.session.idleExpiresAt.getTime() - 3 * HOUR,
		);
	});

	it("never moves the absolute deadline, however often the session is used", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await age(issued.session.id, "2 hours");

		await service.resolve(issued.token);
		await service.refresh(issued.token);
		const resolved = await service.resolve(issued.token);

		expect(resolved?.session.absoluteExpiresAt.getTime()).toBeCloseTo(
			issued.session.absoluteExpiresAt.getTime(),
			-3,
		);
		expect(resolved?.session.absoluteExpiresAt.getTime() ?? 0).toBeLessThan(
			issued.session.createdAt.getTime() + 30 * DAY + MINUTE,
		);
	});
});

describe("refresh (3.15 B.2)", () => {
	it("forces the idle write the interval would otherwise hold back", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		counted.reset();

		const refreshed = await service.refresh(issued.token);

		expect(statementsMatching(counted, /^UPDATE/)).toHaveLength(1);
		expect(refreshed?.session.id).toBe(issued.session.id);
	});

	it("leaves the token as it was — a refresh is not a re-issue", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });

		await service.refresh(issued.token);

		expect((await service.resolve(issued.token))?.session.id).toBe(issued.session.id);
	});

	it("answers null for a session that is already gone", async () => {
		expect(await service.refresh(createSessionToken().token)).toBeNull();
	});
});

describe("what the module does not contain (S-CACHE-1)", () => {
	it("keeps no cache of any kind in core/session", () => {
		const directory = fileURLToPath(new URL("../src/core/session/", import.meta.url));
		const holding = readdirSync(directory)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) =>
				/\bnew (Map|WeakMap|WeakRef)\b|\bLRU\b|\bcache\b/i.test(
					readFileSync(`${directory}${name}`, "utf8"),
				),
			);

		expect(holding).toEqual([]);
	});

	it("has files to scan, so an empty result means something", () => {
		const directory = fileURLToPath(new URL("../src/core/session/", import.meta.url));

		expect(readdirSync(directory).filter((name) => name.endsWith(".ts")).length).toBeGreaterThan(5);
	});
});
