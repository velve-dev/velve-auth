import { describe, expect, expectTypeOf, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { createUserRepository } from "../src/core/auth/user.js";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { FrozenContextServices } from "../src/core/plugin/context.js";
import { createPluginRuntime, type PluginRuntime } from "../src/core/plugin/registry.js";
import {
	compareWithAnchors,
	consultAnchors,
	decodeAnchorFloor,
	recordSealWithAnchors,
} from "../src/core/security-state/anchor.js";
import {
	createVelveAuth,
	type FrozenContext,
	type SecurityStateAnchor,
	type SecurityStateFloor,
	type SecurityStateSealedEvent,
	type VelvePlugin,
} from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

//the plugin member of T-INTEG-4 and T-INTEG-6 reaches the request path as one port per plugin (E-3170)

const USER_ID = "6f1c2b8e-1d2a-4a51-9c5e-0d3f7a9b1c22";
const DIGEST = encodeBase64Url(new Uint8Array(32).fill(7));
const EVENT: SecurityStateSealedEvent = { userId: USER_ID, version: 4, digest: DIGEST };

function servicesOver(driver: Driver): FrozenContextServices {
	return {
		clock: { now: () => new Date(0) },
		identityMode: "email",
		schema: "velve",
		users: createUserRepository({ driver, schema: "velve" }),
		sessions: createSessionRepository({ driver, schema: "velve" }),
		driver,
		log: () => undefined,
	};
}

function runtimeOf(plugins: readonly VelvePlugin[]): PluginRuntime {
	return createPluginRuntime({ plugins, services: servicesOver(unreachableDriver()) });
}

interface AnchorCall {
	readonly plugin: string;
	readonly member: keyof SecurityStateAnchor;
	readonly argument: unknown;
	readonly context: FrozenContext;
}

function recordingAnchor(
	plugin: string,
	calls: AnchorCall[],
	answer: () => unknown = () => null,
): SecurityStateAnchor {
	return {
		recordSeal: (event, context) => {
			calls.push({ plugin, member: "recordSeal", argument: event, context });
			return Promise.resolve();
		},
		minimumVersion: (input, context) => {
			calls.push({ plugin, member: "minimumVersion", argument: input, context });
			return Promise.resolve(answer() as SecurityStateFloor | null);
		},
	};
}

function codeOfRefusal(plugins: readonly VelvePlugin[]): string {
	try {
		createVelveAuth(configFor({ database: unreachableDriver(), plugins }));
	} catch (cause) {
		return cause instanceof VelveStartupError ? cause.code : `not a start error: ${String(cause)}`;
	}
	return "the configuration started";
}

describe("the anchor member is part of the public plugin type (3.15 G)", () => {
	it("types both members with the plugin's frozen context and the shapes the port decodes", () => {
		expectTypeOf<VelvePlugin["securityStateAnchor"]>().toEqualTypeOf<
			SecurityStateAnchor | undefined
		>();
		expectTypeOf<SecurityStateAnchor["recordSeal"]>().toEqualTypeOf<
			(event: SecurityStateSealedEvent, context: FrozenContext) => Promise<void>
		>();
		expectTypeOf<SecurityStateAnchor["minimumVersion"]>().toEqualTypeOf<
			(
				input: { readonly userId: string },
				context: FrozenContext,
			) => Promise<SecurityStateFloor | null>
		>();
		expectTypeOf<SecurityStateFloor>().toEqualTypeOf<{
			readonly version: number;
			readonly digest: string;
		}>();
		expectTypeOf<SecurityStateSealedEvent>().toEqualTypeOf<{
			readonly userId: string;
			readonly version: number;
			readonly digest: string;
		}>();
	});
});

describe("registering the anchor", () => {
	it("starts with the member, which is no field outside the interface", () => {
		const plugin: VelvePlugin = { id: "audit", securityStateAnchor: recordingAnchor("audit", []) };

		expect(codeOfRefusal([plugin])).toBe("the configuration started");
	});

	it("still refuses a field beside it that the interface does not enumerate", () => {
		const plugin = asJavaScriptPlugin({
			id: "audit",
			securityStateAnchor: recordingAnchor("audit", []),
			minimumStateVersion: () => Promise.resolve(null),
		});

		expect(codeOfRefusal([plugin])).toBe("plugin_field_unknown");
	});

	it("builds no port for a plugin that contributes none, and none without plugins", () => {
		expect(runtimeOf([]).securityStateAnchors).toHaveLength(0);
		expect(runtimeOf([{ id: "plain" }]).securityStateAnchors).toHaveLength(0);
	});

	it("builds one port per contributing plugin, in dependency order", async () => {
		const calls: AnchorCall[] = [];
		const runtime = runtimeOf([
			{ id: "late", dependsOn: ["early"], securityStateAnchor: recordingAnchor("late", calls) },
			{ id: "plain" },
			{ id: "early", securityStateAnchor: recordingAnchor("early", calls) },
		]);

		expect(runtime.securityStateAnchors).toHaveLength(2);
		for (const port of runtime.securityStateAnchors) {
			await port.minimumVersion({ userId: USER_ID });
		}

		expect(calls.map((call) => call.plugin)).toStrictEqual(["early", "late"]);
	});

	it("binds each port to the frozen context its plugin's hooks are given", async () => {
		const calls: AnchorCall[] = [];
		const hookContexts: FrozenContext[] = [];
		const runtime = runtimeOf([
			{
				id: "audit",
				securityStateAnchor: recordingAnchor("audit", calls),
				hooks: {
					afterUserCreate: (_event, context) => {
						hookContexts.push(context);
						return Promise.resolve();
					},
				},
			},
			{ id: "other", securityStateAnchor: recordingAnchor("other", calls) },
		]);
		const [audit, other] = runtime.securityStateAnchors;

		await audit?.minimumVersion({ userId: USER_ID });
		await audit?.recordSeal(EVENT);
		await other?.recordSeal(EVENT);
		await runtime.hooks.afterUserCreate({ email: null, username: "a", userId: USER_ID });

		const [auditAsked, auditTold, otherTold] = calls;
		expect(Object.isFrozen(auditAsked?.context)).toBe(true);
		expect(auditAsked?.context).toBe(hookContexts[0]);
		expect(auditTold?.context).toBe(hookContexts[0]);
		expect(otherTold?.context).not.toBe(hookContexts[0]);
	});

	it("calls the members the start read, whatever the object answers later", async () => {
		const calls: string[] = [];
		let reads = 0;
		const anchor = {
			get minimumVersion() {
				reads += 1;
				const read = reads;
				return () => {
					calls.push(`read ${read}`);
					return Promise.resolve(null);
				};
			},
			recordSeal: () => {
				calls.push("first recordSeal");
				return Promise.resolve();
			},
		};
		const runtime = runtimeOf([asJavaScriptPlugin({ id: "audit", securityStateAnchor: anchor })]);
		const readsAtStart = reads;
		anchor.recordSeal = () => {
			calls.push("replaced recordSeal");
			return Promise.resolve();
		};

		const [port] = runtime.securityStateAnchors;
		await port?.minimumVersion({ userId: USER_ID });
		await port?.minimumVersion({ userId: USER_ID });
		await port?.recordSeal(EVENT);

		expect(reads).toBe(readsAtStart);
		expect(calls).toStrictEqual(["read 1", "read 1", "first recordSeal"]);
	});

	it("calls an anchor written as a class on itself, its own store included", async () => {
		class AppendOnlyAnchor implements SecurityStateAnchor {
			readonly recorded: SecurityStateSealedEvent[] = [];

			recordSeal(event: SecurityStateSealedEvent): Promise<void> {
				this.recorded.push(event);
				return Promise.resolve();
			}

			minimumVersion(): Promise<SecurityStateFloor | null> {
				const highest = this.recorded.at(-1);
				return Promise.resolve(
					highest === undefined ? null : { version: highest.version, digest: highest.digest },
				);
			}
		}
		const anchor = new AppendOnlyAnchor();
		const [port] = runtimeOf([{ id: "audit", securityStateAnchor: anchor }]).securityStateAnchors;
		if (port === undefined) {
			throw new Error("the class anchor built no port");
		}

		await port.recordSeal(EVENT);
		const reading = await consultAnchors([port], USER_ID);

		expect(anchor.recorded).toStrictEqual([EVENT]);
		expect(reading.kind).toBe("answered");
		expect(
			compareWithAnchors({ version: EVENT.version, digest: new Uint8Array(32).fill(7) }, reading),
		).toBe("within_floor");
	});
});

describe("what a port hands the anchor", () => {
	it("asks with a frozen copy of the account id and nothing else", async () => {
		const calls: AnchorCall[] = [];
		const [port] = runtimeOf([
			{ id: "audit", securityStateAnchor: recordingAnchor("audit", calls) },
		]).securityStateAnchors;
		const input = { userId: USER_ID };

		await port?.minimumVersion(input);

		const asked = calls[0]?.argument;
		expect(asked).toStrictEqual({ userId: USER_ID });
		expect(asked).not.toBe(input);
		expect(Object.isFrozen(asked)).toBe(true);
	});

	it("tells every anchor its own frozen copy, so one cannot change what the next learns", async () => {
		const learned: unknown[] = [];
		const tampering: SecurityStateAnchor = {
			recordSeal: (event) => {
				(event as { version: number }).version = 1;
				return Promise.resolve();
			},
			minimumVersion: () => Promise.resolve(null),
		};
		const listening: SecurityStateAnchor = {
			recordSeal: (event) => {
				learned.push(event);
				return Promise.resolve();
			},
			minimumVersion: () => Promise.resolve(null),
		};
		const ports = runtimeOf([
			{ id: "tamper", securityStateAnchor: tampering },
			{ id: "listen", securityStateAnchor: listening },
		]).securityStateAnchors;
		const failures: string[] = [];

		await recordSealWithAnchors(ports, EVENT, () => failures.push("reported"));

		expect(learned).toStrictEqual([EVENT]);
		expect(learned[0]).not.toBe(EVENT);
		expect(Object.isFrozen(learned[0])).toBe(true);
		expect(failures).toStrictEqual(["reported"]);
	});
});

describe("an anchor that cannot be read fails the request closed (T-INTEG-4, E-3286)", () => {
	const malformed: ReadonlyArray<readonly [string, unknown]> = [
		["undefined", undefined],
		["a version NaN", { version: Number.NaN, digest: DIGEST }],
		["a fraction", { version: 2.5, digest: DIGEST }],
		["a version 0", { version: 0, digest: DIGEST }],
		["a negative version", { version: -3, digest: DIGEST }],
		["a version above the safe integers", { version: 2 ** 53, digest: DIGEST }],
		["a missing digest", { version: 3 }],
		["a digest of 31 bytes", { version: 3, digest: encodeBase64Url(new Uint8Array(31)) }],
		["a bare number", 3],
	];

	for (const [name, answer] of malformed) {
		it(`refuses ${name} answered through a registered plugin`, async () => {
			const ports = runtimeOf([
				{ id: "audit", securityStateAnchor: recordingAnchor("audit", [], () => answer) },
			]).securityStateAnchors;

			const reading = await consultAnchors(ports, USER_ID);

			expect(decodeAnchorFloor(answer)).toBe("malformed");
			expect(reading).toStrictEqual({ kind: "unavailable" });
			expect(compareWithAnchors({ version: 3, digest: new Uint8Array(32).fill(7) }, reading)).toBe(
				"anchor_unavailable",
			);
		});
	}

	it("reads a valid floor and a null through the port as answered", async () => {
		const ports = runtimeOf([
			{
				id: "floor",
				securityStateAnchor: recordingAnchor("floor", [], () => ({ version: 3, digest: DIGEST })),
			},
			{ id: "none", securityStateAnchor: recordingAnchor("none", []) },
		]).securityStateAnchors;

		const reading = await consultAnchors(ports, USER_ID);

		expect(reading).toStrictEqual({
			kind: "answered",
			floors: [{ version: 3, digest: new Uint8Array(32).fill(7) }, null],
		});
	});

	it("turns a synchronous throw of the plugin into a rejection of the port", async () => {
		const throwing: SecurityStateAnchor = {
			recordSeal: () => {
				throw new Error("the store is down");
			},
			minimumVersion: () => {
				throw new Error("the store is down");
			},
		};
		const [port] = runtimeOf([{ id: "audit", securityStateAnchor: throwing }]).securityStateAnchors;
		if (port === undefined) {
			throw new Error("the throwing anchor built no port");
		}
		const failures: string[] = [];

		const asked = port.minimumVersion({ userId: USER_ID });
		const told = port.recordSeal(EVENT);
		await recordSealWithAnchors([port], EVENT, () => failures.push("reported"));

		await expect(asked).rejects.toThrow("the store is down");
		await expect(told).rejects.toThrow("the store is down");
		expect(await consultAnchors([port], USER_ID)).toStrictEqual({ kind: "unavailable" });
		expect(failures).toStrictEqual(["reported"]);
	});

	const unavailable = { kind: "unavailable" } as const;
	const answeredNull = { kind: "answered", floors: [null] } as const;
	const incomplete: ReadonlyArray<readonly [string, unknown, unknown, number]> = [
		["null", null, unavailable, 1],
		["true", true, unavailable, 1],
		["an empty object", {}, unavailable, 1],
		[
			"a minimumVersion that is no function",
			{ minimumVersion: 3, recordSeal: async () => {} },
			unavailable,
			0,
		],
		["no recordSeal", { minimumVersion: async () => null }, answeredNull, 1],
	];

	for (const [name, anchor, expectedReading, expectedFailures] of incomplete) {
		it(`starts with ${name} as the anchor and refuses every call through the missing member`, async () => {
			const plugin = asJavaScriptPlugin({ id: "audit", securityStateAnchor: anchor });
			expect(codeOfRefusal([plugin])).toBe("the configuration started");
			const ports = runtimeOf([plugin]).securityStateAnchors;
			const failures: string[] = [];

			const reading = await consultAnchors(ports, USER_ID);
			await recordSealWithAnchors(ports, EVENT, () => failures.push("reported"));

			expect(ports).toHaveLength(1);
			expect(reading).toStrictEqual(expectedReading);
			expect(failures).toHaveLength(expectedFailures);
		});
	}
});
