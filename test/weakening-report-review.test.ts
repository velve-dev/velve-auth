import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateLimitConfig } from "../src/core/auth/config.js";
import { rateLimitConfigOf } from "../src/core/auth/rate-limiting.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import type { BucketRule } from "../src/core/http/rate-limit.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("weakening_review");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

const WEAKENED_LINE = "a security option is weaker than its default";

/**
 * `RateLimitConfig` types both buckets as `BucketRule`, but a configuration written in JavaScript
 * can hand over the `"none"` that `RateLimitRule` allows, and `rateLimitConfigOf` passes it on to
 * every core route unchanged. E-2212 refuses exactly this for a plugin route because a JavaScript
 * plugin can write it; the application's own configuration reaches every core route at once.
 */
const SWITCHED_OFF = "none" as unknown as BucketRule;

/** One request past the default address capacity, so exactly the last one is refused. */
const ONE_PAST_THE_DEFAULT = rateLimitConfigOf().perIpAddress.capacity + 1;

function startWith(rateLimit: Partial<RateLimitConfig>): {
	readonly outcome: "refused" | "started";
	readonly weakenedOptions: readonly unknown[];
} {
	const log = createLogSink();
	try {
		createVelveAuth(
			configFor({ database: connection as Driver, schema, log: log.write, rateLimit }),
		);
	} catch (cause) {
		if (cause instanceof VelveStartupError) {
			return { outcome: "refused", weakenedOptions: [] };
		}
		throw cause;
	}
	return {
		outcome: "started",
		weakenedOptions: log.lines
			.filter((line) => line.message === WEAKENED_LINE)
			.map((line) => line.fields.option),
	};
}

describe("the application's rate-limit configuration cannot switch a bucket off (S-DEFAULT-3)", () => {
	it("refuses an address bucket of none at start", () => {
		expect(startWith({ perIpAddress: SWITCHED_OFF })).toStrictEqual({
			outcome: "refused",
			weakenedOptions: [],
		});
	});

	it("refuses an account bucket of none at start", () => {
		expect(startWith({ perAccount: SWITCHED_OFF })).toStrictEqual({
			outcome: "refused",
			weakenedOptions: [],
		});
	});

	it("limits a core route by address once the instance has started at the default", async () => {
		const mounted = await mountAuth("weakening_review_default");
		try {
			const statuses = await signOutStatuses(mounted.handler, ONE_PAST_THE_DEFAULT);

			expect(statuses.filter((status) => status === 429)).toHaveLength(1);
		} finally {
			await dropSchema(mounted.connection, mounted.schema);
			await mounted.connection.close();
		}
	});

	it("does not serve a core route unlimited because the address bucket was written as none", async () => {
		const mounted = await mountAuth("weakening_review_none", {
			rateLimit: { perIpAddress: SWITCHED_OFF },
		}).catch((cause: unknown) => cause);
		if (mounted instanceof VelveStartupError) {
			return;
		}
		if (mounted instanceof Error || typeof mounted !== "object" || mounted === null) {
			throw mounted;
		}
		const started = mounted as Awaited<ReturnType<typeof mountAuth>>;
		try {
			const statuses = await signOutStatuses(started.handler, ONE_PAST_THE_DEFAULT);

			expect(statuses.filter((status) => status === 429)).toHaveLength(1);
		} finally {
			await dropSchema(started.connection, started.schema);
			await started.connection.close();
		}
	});
});

async function signOutStatuses(
	handler: (request: Request) => Promise<Response>,
	count: number,
): Promise<readonly number[]> {
	const statuses: number[] = [];
	for (let attempt = 0; attempt < count; attempt += 1) {
		const response = await handler(requestTo("/sign-out", { body: {} }));
		statuses.push(response.status);
	}
	return statuses;
}
