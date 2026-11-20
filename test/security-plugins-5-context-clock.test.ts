import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../src/core/http/environment.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

/**
 * 3.11: a plugin may not change the core context, and the context is frozen. `Object.freeze` is
 * shallow, and the context's `clock` is the very object the pipeline reads freshness from, the
 * rate limiter reads its window from and TOTP reads its time step from. Without a configured
 * clock it is the module-level system clock every instance in the process shares.
 */

const PLANTED = new Date("2001-01-01T00:00:00.000Z");

let rewrite: ((clock: Clock) => void) | null = null;

const REWRITER: VelvePlugin<"rewriter"> = {
	id: "rewriter",
	routes: [
		{
			name: "rewriter.go",
			method: "POST",
			path: "/x/rewriter/go",
			input: object({}),
			errors: [] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
			handler: (_input: unknown, context: RequestContext) => {
				rewrite?.(context.plugin.clock);
				return Promise.resolve({ done: true });
			},
		} as PluginRoute<"rewriter">,
	],
};

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("secplugclock", { plugins: [REWRITER] });
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("the clock a plugin is handed is part of the frozen context (3.11)", () => {
	it("hands a plugin a clock it cannot change", async () => {
		let frozen: boolean | null = null;
		rewrite = (clock) => {
			frozen = Object.isFrozen(clock);
		};
		await mounted.handler(requestTo("/x/rewriter/go", { body: {} }));
		rewrite = null;

		expect(frozen, "the context's clock is a mutable object").toBe(true);
	});

	it("leaves the core's clock, and another instance's, alone when a plugin rewrites the one it holds", async () => {
		const bystander = createVelveAuth(configFor({ database: unreachableDriver() }));
		const original = mounted.auth.http.clock.now;
		let core: Date | null = null;
		let other: Date | null = null;
		rewrite = (clock) => {
			try {
				(clock as { now: () => Date }).now = () => PLANTED;
			} catch {
				return;
			}
		};
		try {
			await mounted.handler(requestTo("/x/rewriter/go", { body: {} }));
			core = mounted.auth.http.clock.now();
			other = bystander.http.clock.now();
		} finally {
			rewrite = null;
			(mounted.auth.http.clock as { now: () => Date }).now = original;
		}

		expect(
			core?.getTime(),
			"the pipeline's freshness clock now answers the plugin's time",
		).not.toBe(PLANTED.getTime());
		expect(other?.getTime(), "an instance without the plugin reads the plugin's time").not.toBe(
			PLANTED.getTime(),
		);
	});
});
