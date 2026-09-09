import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { createSessionToken } from "../src/core/session/token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };
const SESSION_DIRECTORY = fileURLToPath(new URL("../src/core/session/", import.meta.url));

interface RecordedStatement {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly depth: number;
}

interface Recorder {
	readonly driver: Driver;
	readonly recorded: RecordedStatement[];
	readonly transactions: { count: number };
	reset(): void;
}

function recordingDriver(inner: Driver): Recorder {
	const recorded: RecordedStatement[] = [];
	const transactions = { count: 0 };

	function wrap(target: Driver, depth: number): Driver {
		return {
			query(sql, params) {
				recorded.push({ sql, params, depth });
				return target.query(sql, params);
			},
			transaction(fn) {
				transactions.count += 1;
				return target.transaction((tx) => fn(wrap(tx, depth + 1)));
			},
		};
	}

	return {
		driver: wrap(inner, 0),
		recorded,
		transactions,
		reset: () => {
			recorded.length = 0;
			transactions.count = 0;
		},
	};
}

let migrated: MigratedSchema;
let recorder: Recorder;
let service: SessionService;
let userId: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_review_resolution");
	recorder = recordingDriver(migrated.connection);
	service = createSessionService({
		driver: recorder.driver,
		schema: migrated.schema,
	});
	userId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("S-CACHE-1, E-20, E-21: one query per answer, never a remembered one", () => {
	it("issues exactly one statement for each of fifty consecutive answers", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		recorder.reset();

		for (let call = 0; call < 50; call += 1) {
			expect(await service.resolve(issued.token)).not.toBeNull();
		}

		expect(recorder.recorded).toHaveLength(50);
		expect(recorder.transactions.count).toBe(0);
	});

	it("asks again for a token it has just been told is unknown", async () => {
		const unknown = createSessionToken().token;
		recorder.reset();

		expect(await service.resolve(unknown)).toBeNull();
		expect(await service.resolve(unknown)).toBeNull();

		expect(recorder.recorded).toHaveLength(2);
	});

	it("asks again after the row is deleted behind its back, and changes its answer", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		expect(await service.resolve(issued.token)).not.toBeNull();

		await migrated.connection.query(
			`DELETE FROM ${migrated.schema}.session WHERE id = $1 AND user_id = $2`,
			[issued.session.id, userId],
		);

		expect(await service.resolve(issued.token)).toBeNull();
	});

	it("holds no map, set, cache or memo anywhere in the session module", () => {
		const holding = readdirSync(SESSION_DIRECTORY)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => [name, readFileSync(`${SESSION_DIRECTORY}${name}`, "utf8")] as const)
			.filter(([, text]) =>
				/\bnew (Map|Set|WeakMap|WeakSet|WeakRef)\b|\bLRU\b|\bcach(e|ing)\b|\bmemo(ise|ize|ised|ized)?\b|\bglobalThis\b/i.test(
					text,
				),
			)
			.map(([name]) => name);

		expect(readdirSync(SESSION_DIRECTORY).filter((name) => name.endsWith(".ts")).length).toBe(8);
		expect(holding).toEqual([]);
	});

	it("keeps no module-level mutable binding that could become one", () => {
		const mutable = readdirSync(SESSION_DIRECTORY)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => /^let\s|^var\s/m.test(readFileSync(`${SESSION_DIRECTORY}${name}`, "utf8")));

		expect(mutable).toEqual([]);
	});
});

describe("S-CACHE-2: the four conditions of the one resolving statement", () => {
	it("reads the token hash, both deadlines and the account state in a single statement", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		recorder.reset();

		await service.resolve(issued.token);

		const [statement] = recorder.recorded;
		expect(recorder.recorded).toHaveLength(1);
		expect(statement?.sql).toMatch(/token_sha256 = \$1/);
		expect(statement?.sql).toMatch(/idle_expires_at > now\(\)/);
		expect(statement?.sql).toMatch(/absolute_expires_at > now\(\)/);
		expect(statement?.sql).toMatch(/JOIN \S+\.user u ON u\.id = s\.user_id/);
		expect(statement?.sql).toMatch(/u\.disabled_at/);
		expect(statement?.params).toHaveLength(1);
	});

	/**
	 * T-CACHE-2 fixes the threshold at "byte for byte equal to a fixture", so that every change to
	 * the one authorisation query is a decision somebody made on purpose. This is that fixture.
	 * `observed_at` is the one column beyond the wording of architecture 3.5 (E-232).
	 */
	it("runs the statement this fixture pins, byte for byte", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		recorder.reset();

		await service.resolve(issued.token);

		expect(recorder.recorded[0]?.sql).toBe(
			`SELECT s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
\t\ts.absolute_expires_at, array_to_string(s.factors, ',') AS factors, s.ip, s.user_agent,
\t\tu.disabled_at, now() AS observed_at
\tFROM ${migrated.schema}.session s
\tJOIN ${migrated.schema}.user u ON u.id = s.user_id
\tWHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`,
		);
	});

	it("answers resolve and refresh from that one statement and no other", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		recorder.reset();

		await service.resolve(issued.token);
		await service.refresh(issued.token);

		const reading = recorder.recorded.filter(({ sql }) => /^SELECT/.test(sql.trimStart()));
		expect(new Set(reading.map(({ sql }) => sql)).size).toBe(1);
		expect(reading).toHaveLength(2);
	});

	it("never puts the plaintext token in a statement or a parameter (S-TIM-4)", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		recorder.reset();

		await service.resolve(issued.token);
		await service.refresh(issued.token);
		await service.signOut({ token: issued.token });

		for (const statement of recorder.recorded) {
			expect(statement.sql).not.toContain(issued.token);
			expect(JSON.stringify(statement.params)).not.toContain(issued.token);
		}
		expect(recorder.recorded.length).toBeGreaterThan(2);
	});
});

describe("L-4, S-CACHE-3: account_disabled and where it may appear", () => {
	it("takes effect on the very next request of an existing session", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		expect(await service.resolve(issued.token)).not.toBeNull();

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = now() WHERE id = $1`,
			[userId],
		);

		await expect(service.resolve(issued.token)).rejects.toMatchObject({
			code: "account_disabled",
			httpStatus: 403,
		});
		await expect(service.refresh(issued.token)).rejects.toMatchObject({
			code: "account_disabled",
		});
	});

	it("does not extend the idle deadline of a session it refuses", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.session
			 SET last_used_at = last_used_at - interval '2 hours' WHERE id = $1 AND user_id = $2`,
			[issued.session.id, userId],
		);
		recorder.reset();

		await expect(service.resolve(issued.token)).rejects.toMatchObject({
			code: "account_disabled",
		});

		expect(recorder.recorded.filter(({ sql }) => /^UPDATE/.test(sql.trimStart()))).toEqual([]);
	});

	it("goes away again when the account is enabled, without a lifetime to wait out", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await expect(service.resolve(issued.token)).rejects.toMatchObject({
			code: "account_disabled",
		});

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = NULL WHERE id = $1`,
			[userId],
		);

		expect(await service.resolve(issued.token)).not.toBeNull();
	});

	it("is raised in exactly one place in the library, and that place is session resolution", () => {
		const core = fileURLToPath(new URL("../src/core/", import.meta.url));
		const files = readdirSync(core, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => `${entry.parentPath}/${entry.name}`);
		const raising = files
			.filter((path) => /new VelveError\(\s*"account_disabled"/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(core, ""));
		const naming = files
			.filter((path) => /account_disabled/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(core, ""))
			.sort();

		expect(files.length).toBeGreaterThan(20);
		expect(raising).toEqual(["session/service.ts"]);
		// The assembly names the code without raising it, once, in the route contract D.3 fixes for
		// every route with caller `session`. It named it a second time until `instance.ts` stopped
		// keeping its own copy of the twenty-five codes and read the error map's own list (E-734).
		// `flows/routes.ts` is the same contract for the two `/email/*` rows with caller `session`
		// (E-607); nothing there raises it either, which is what the first expectation holds.
		expect(naming).toEqual([
			"auth/routes.ts",
			"flows/routes.ts",
			"http/error-map.ts",
			"session/service.ts",
		]);
	});

	it("is reachable from no method that issues a session", async () => {
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = now() WHERE id = $1`,
			[userId],
		);

		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		const reissued = await service.reissue({
			previousToken: issued.token,
			userId,
			factors: ["password"],
			observed: NOWHERE,
		});

		expect(reissued.session.userId).toBe(userId);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = NULL WHERE id = $1`,
			[userId],
		);
	});
});
