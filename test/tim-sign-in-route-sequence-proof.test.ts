import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

//the counters sit under the real derivations so a KDF call outside the semaphore is counted too
const kdfCalls: string[] = [];

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	const counted = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
		((...args: never[]) => {
			kdfCalls.push(name);
			return fn(...args);
		}) as T;
	return {
		...original,
		argon2idAsync: counted("argon2id", original.argon2idAsync),
		argon2iAsync: counted("argon2i", original.argon2iAsync),
		argon2dAsync: counted("argon2d", original.argon2dAsync),
	};
});

//the accelerator derives in WebAssembly and calls none of the counted functions (E-180)
vi.doMock("hash-wasm", () => {
	throw new Error("the accelerator is out of the way for this count");
});

vi.mock("bcryptjs", async (importOriginal) => {
	const original = await importOriginal<typeof import("bcryptjs")>();
	return {
		...original,
		compare: (...args: Parameters<typeof original.compare>) => {
			kdfCalls.push("bcrypt");
			return original.compare(...args);
		},
	};
});

import type { Driver } from "../src/core/db/driver.js";

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { encodeStandardBase64 } = await import("../src/core/password/base64.js");
const { sealPhc } = await import("../src/core/password/credential.js");
const { MAXIMUM_STORED_MEMORY_KIB } = await import("../src/core/password/limits.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor, testKeyProvider } = await import("./auth-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");
const { drawTestPassword } = await import("./password-fixtures.js");

type Opened = Awaited<ReturnType<typeof openMigratedSchema>>;

interface Call {
	readonly statement: string;
	readonly shape: string;
}

interface Observation {
	readonly status: number;
	readonly calls: readonly Call[];
	readonly kdfCalls: readonly string[];
}

const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();

const calls: Call[] = [];
const keys = testKeyProvider();
let opened: Opened;
let handler: (request: Request) => Promise<Response>;

/** A parameter's shape and never its value, so two lookups differing only in an address compare. */
function shapeOf(parameters: readonly unknown[]): string {
	return parameters
		.map((parameter) => {
			if (parameter === null) {
				return "null";
			}
			return parameter instanceof Uint8Array ? `bytes(${parameter.length})` : typeof parameter;
		})
		.join(",");
}

function recording(inner: Driver): Driver {
	return {
		query: (sql, parameters) => {
			calls.push({ statement: sql.replace(/\s+/g, " ").trim(), shape: shapeOf(parameters) });
			return inner.query(sql, parameters);
		},
		transaction: (run) => {
			calls.push({ statement: "BEGIN", shape: "" });
			return inner.transaction((transaction) => run(recording(transaction)));
		},
	};
}

beforeAll(async () => {
	opened = await openMigratedSchema("timroute");
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: recording(opened.connection),
				schema: opened.schema,
				keys,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
	const present = await handler(
		postTo("/sign-up", { email: "present@example.com", password: PASSWORD }),
	);
	const credentialless = await handler(
		postTo("/sign-up/passwordless", { email: "credentialless@example.com" }),
	);
	const overCeiling = await handler(
		postTo("/sign-up", { email: "overceiling@example.com", password: PASSWORD }),
	);
	expect([present.status, credentialless.status, overCeiling.status]).toStrictEqual([
		200, 200, 200,
	]);
	await storeOverTheCeiling("overceiling@example.com");
	await handler(postTo("/sign-in/password", { email: "warmup@example.com", password: PASSWORD }));
}, 120_000);

//an import the cost ceilings refuse must cost what an absent user costs (S-TIM-2)
async function storeOverTheCeiling(email: string): Promise<void> {
	const filler = encodeStandardBase64(new Uint8Array(32).fill(1));
	const sealed = await sealPhc(
		keys,
		`$argon2id$v=19$m=${MAXIMUM_STORED_MEMORY_KIB + 1},t=2,p=1$${filler}$${filler}`,
	);
	await opened.connection.query(
		`UPDATE ${opened.schema}.password_credential SET phc = $2, key_version = $3
		 WHERE user_id = (SELECT id FROM ${opened.schema}.user WHERE email = $1)`,
		[email, sealed.ciphertext, sealed.keyVersion],
	);
}

afterAll(async () => {
	await dropSchema(opened.connection, opened.schema);
	await opened.connection.close();
});

async function signInAs(email: string): Promise<Observation> {
	calls.length = 0;
	kdfCalls.length = 0;
	const answer = await handler(postTo("/sign-in/password", { email, password: WRONG_PASSWORD }));
	await answer.arrayBuffer();
	return { status: answer.status, calls: [...calls], kdfCalls: [...kdfCalls] };
}

describe("T-TIM-1b over the mounted route — one call sequence for every identifier (S-TIM-1)", () => {
	it("runs the same statements, parameter shapes and KDF calls in all five cases", async () => {
		const cases = {
			"existing account, wrong password": await signInAs("present@example.com"),
			"no such account": await signInAs("absent@example.com"),
			"account without a password credential": await signInAs("credentialless@example.com"),
			"not an email address": await signInAs("not an email at all"),
			"stored credential above the cost ceiling": await signInAs("overceiling@example.com"),
		};
		const reference = cases["existing account, wrong password"];

		expect(reference.status).toBe(401);
		expect(reference.kdfCalls).toStrictEqual(["argon2id"]);
		expect(
			reference.calls.some((call) => call.statement.includes("disabled_at IS NOT NULL")),
			"the account lookup is part of the recorded sequence",
		).toBe(true);
		expect(
			reference.calls.some((call) => call.statement.includes("password_credential")),
			"the credential read is part of the recorded sequence",
		).toBe(true);

		for (const [name, observed] of Object.entries(cases)) {
			expect(observed.status, name).toBe(reference.status);
			expect(
				observed.calls.map((call) => call.statement),
				name,
			).toStrictEqual(reference.calls.map((call) => call.statement));
			expect(
				observed.calls.map((call) => call.shape),
				name,
			).toStrictEqual(reference.calls.map((call) => call.shape));
			expect(observed.kdfCalls, name).toStrictEqual(reference.kdfCalls);
		}
	}, 60_000);
});
