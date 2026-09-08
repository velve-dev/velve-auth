import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { truncatedIpAddress } from "../src/core/session/ip-address.js";
import { DEFAULT_SESSION_METADATA_MODE, sessionMetadataFor } from "../src/core/session/metadata.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { truncatedUserAgent } from "../src/core/session/user-agent.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

const CHROME_ON_MACOS =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36";
const SAFARI_ON_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

interface Sent {
	readonly driver: Driver;
	readonly parameters: unknown[];
	readonly statements: string[];
	reset(): void;
}

function capturingDriver(inner: Driver): Sent {
	const parameters: unknown[] = [];
	const statements: string[] = [];

	function wrap(target: Driver): Driver {
		return {
			query(sql, params) {
				statements.push(sql);
				parameters.push(...params);
				return target.query(sql, params);
			},
			transaction: (fn) => target.transaction((tx) => fn(wrap(tx))),
		};
	}

	return {
		driver: wrap(inner),
		parameters,
		statements,
		reset: () => {
			parameters.length = 0;
			statements.length = 0;
		},
	};
}

let migrated: MigratedSchema;
let sent: Sent;
let truncating: SessionService;
let userId: string;

async function storedMetadata(sessionId: string) {
	const [row] = await migrated.connection.query<{ ip: string | null; user_agent: string | null }>(
		`SELECT host(ip) || '/' || masklen(ip) AS ip, user_agent
		 FROM ${migrated.schema}.session WHERE id = $1 AND user_id = $2`,
		[sessionId, userId],
	);
	if (row === undefined) {
		throw new Error("the session under test is gone");
	}
	return row;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_review_metadata");
	sent = capturingDriver(migrated.connection);
	truncating = createSessionService({
		driver: sent.driver,
		schema: migrated.schema,
	});
	userId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("L-10: truncated is the default, and it is what the column holds", () => {
	it("stores an IPv4 address as its /24 network and the user agent as two families", async () => {
		const issued = await truncating.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS },
		});

		expect(await storedMetadata(issued.session.id)).toEqual({
			ip: "203.0.113.0/24",
			user_agent: "Chrome on macOS",
		});
	});

	it("stores an IPv6 address as its /64 network", async () => {
		const issued = await truncating.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "2001:db8:1:2:dead:beef:1234:5678", userAgent: SAFARI_ON_IOS },
		});

		expect(await storedMetadata(issued.session.id)).toEqual({
			ip: "2001:db8:1:2::/64",
			user_agent: "Safari on iOS",
		});
	});
});

describe("L-10, E-222: the untruncated value never reaches the database", () => {
	it("puts neither the full address nor the full header into a statement parameter", async () => {
		sent.reset();

		await truncating.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS },
		});

		const carried = JSON.stringify(sent.parameters);
		expect(sent.parameters.length).toBeGreaterThan(0);
		expect(carried).toContain("203.0.113.0/24");
		expect(carried).not.toContain("203.0.113.42");
		expect(carried).not.toContain("Chrome/131");
		expect(carried).not.toContain("AppleWebKit");
	});

	it("does not smuggle it into the statement text either", async () => {
		sent.reset();

		await truncating.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "198.51.100.200", userAgent: SAFARI_ON_IOS },
		});

		for (const statement of sent.statements) {
			expect(statement).not.toContain("198.51.100.200");
			expect(statement).not.toContain("iPhone OS 17_5_1");
		}
		expect(sent.statements.length).toBeGreaterThan(0);
	});

	it("truncates on a re-issue and on a credential change as well, not only on the first insert", async () => {
		const first = await truncating.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "192.0.2.77", userAgent: CHROME_ON_MACOS },
		});
		sent.reset();

		const next = await truncating.reissue({
			previousToken: first.token,
			userId,
			factors: ["password", "totp"],
			observed: { ipAddress: "192.0.2.77", userAgent: CHROME_ON_MACOS },
		});
		const resolved = await truncating.resolve(next.token);
		if (resolved === null) {
			throw new Error("the re-issued session did not resolve");
		}
		const after = await truncating.reissueAfterCredentialChange({
			resolved,
			factors: ["password"],
			observed: { ipAddress: "192.0.2.77", userAgent: CHROME_ON_MACOS },
		});

		expect(JSON.stringify(sent.parameters)).not.toContain("192.0.2.77");
		expect(next.session.ipAddress).toBe("192.0.2.0/24");
		expect(after.session.ipAddress).toBe("192.0.2.0/24");
	});

	it("stores nothing at all in mode none, and the observed values in mode full", async () => {
		const nothing = createSessionService({
			driver: sent.driver,
			schema: migrated.schema,
			sessionMetadata: "none",
		});
		const everything = createSessionService({
			driver: sent.driver,
			schema: migrated.schema,
			sessionMetadata: "full",
		});

		const blank = await nothing.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS },
		});
		const complete = await everything.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS },
		});

		expect(blank.session.ipAddress).toBeNull();
		expect(blank.session.userAgent).toBeNull();
		expect(complete.session.ipAddress).toBe("203.0.113.42");
		expect(complete.session.userAgent).toBe(CHROME_ON_MACOS);
	});
});

describe("what truncation refuses to pass through", () => {
	it("drops an address it cannot read rather than storing it or failing the sign-in", async () => {
		for (const hostile of [
			"203.0.113.42, 198.51.100.1",
			"203.0.113.42:8080",
			"fe80::1%eth0",
			"not-an-address",
			"999.999.999.999",
			"'; DROP TABLE velve.session; --",
		]) {
			const issued = await truncating.issue({
				userId,
				factors: ["password"],
				observed: { ipAddress: hostile, userAgent: null },
			});

			expect({ hostile, stored: issued.session.ipAddress }).toEqual({ hostile, stored: null });
			expect(truncatedIpAddress(hostile)).toBeNull();
		}
	});

	it("keeps no part of a user agent that identifies one device", () => {
		for (const [header, expected] of [
			[CHROME_ON_MACOS, "Chrome on macOS"],
			[SAFARI_ON_IOS, "Safari on iOS"],
			["curl/8.7.1", null],
			[
				"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
				"Firefox on Linux",
			],
		] as const) {
			const truncated = truncatedUserAgent(header);

			expect({ header, truncated }).toEqual({ header, truncated: expected });
			if (truncated !== null) {
				expect(truncated.length).toBeLessThan(32);
				expect(header).not.toBe(truncated);
			}
		}
	});

	it("truncates an IPv4-mapped IPv6 address as IPv4, so one /64 is not every IPv4 client", () => {
		expect(truncatedIpAddress("::ffff:203.0.113.42")).toBe("203.0.113.0/24");
		expect(
			sessionMetadataFor("truncated", { ipAddress: "::ffff:10.1.2.3", userAgent: null }),
		).toEqual({ ipAddress: "10.1.2.0/24", userAgent: null });
	});

	it("is what a service built without the option does, and the option's default says so", async () => {
		const unconfigured = createSessionService({
			driver: sent.driver,
			schema: migrated.schema,
		});

		const issued = await unconfigured.issue({
			userId,
			factors: ["password"],
			observed: { ipAddress: "203.0.113.42", userAgent: CHROME_ON_MACOS },
		});

		expect(DEFAULT_SESSION_METADATA_MODE).toBe("truncated");
		expect(issued.session.ipAddress).toBe("203.0.113.0/24");
		expect(issued.session.userAgent).toBe("Chrome on macOS");
	});
});
