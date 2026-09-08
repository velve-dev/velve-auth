import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	hashSecretToken,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokens,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

let connection: TestConnection;
let schema: string;
let user: string;
let tokens: OneTimeTokens;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_review_leak");
	connection = migrated.connection;
	schema = migrated.schema;
	user = await createUser(connection, schema);
	tokens = createOneTimeTokens(createOneTimeTokenRepository({ driver: connection, schema }));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Everything a thrown value can carry out of the library, flattened into one string. */
function everythingOn(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	const parts: string[] = [String(value)];
	if (value instanceof Error) {
		parts.push(value.message, value.stack ?? "", String(value.cause));
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		parts.push(key, String((value as Record<string, unknown>)[key]));
	}
	try {
		parts.push(JSON.stringify(value, Object.getOwnPropertyNames(value)));
	} catch {
		parts.push("");
	}
	return parts.join("\n");
}

describe("no plaintext token reaches a console", () => {
	it("writes nothing at all while issuing and redeeming all four purposes", async () => {
		const written: string[] = [];
		const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
		for (const method of methods) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				written.push(args.map(String).join(" "));
			});
		}
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: unknown): boolean => {
				written.push(String(chunk));
				return true;
			});
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: unknown): boolean => {
				written.push(String(chunk));
				return true;
			});

		const minted: string[] = [];
		for (const purpose of ONE_TIME_TOKEN_PURPOSES) {
			const issued = await tokens.issue({ purpose, userId: user, payload: { note: "carried" } });
			minted.push(issued.token);
			await tokens.redeem({ token: issued.token, purpose });
			await tokens.redeem({ token: issued.token, purpose });
		}

		stdout.mockRestore();
		stderr.mockRestore();

		const output = written.join("\n");
		for (const token of minted) {
			expect(output).not.toContain(token);
		}
		expect(written).toStrictEqual([]);
	});
});

describe("no plaintext token reaches a thrown value", () => {
	function failingOn(pattern: RegExp, driver: Driver): Driver {
		const wrapper: Driver = {
			query<T>(sql: string, params: unknown[]): Promise<T[]> {
				if (pattern.test(sql)) {
					return Promise.reject(new Error("the server went away"));
				}
				return driver.query<T>(sql, params);
			},
			transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
				return fn(wrapper);
			},
		};
		return wrapper;
	}

	it("carries neither the token nor its hash out of a failing redemption", async () => {
		const failing = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: failingOn(/^DELETE/, connection), schema }),
		);
		const issued = await tokens.issue({ purpose: "magic_link", userId: user });

		const thrown = await failing
			.redeem({ token: issued.token, purpose: "magic_link" })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(Error);
		const text = everythingOn(thrown);
		expect(text).not.toContain(issued.token);
		expect(text).not.toContain(Buffer.from(hashSecretToken(issued.token)).toString("hex"));
	});

	it("carries neither the token nor its hash out of a failing issue", async () => {
		const empty: Driver = {
			query<T>(): Promise<T[]> {
				return Promise.resolve([] as T[]);
			},
			transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
				return fn(empty);
			},
		};
		const failing = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: empty, schema: "velve" }),
		);

		const thrown = await failing
			.issue({ purpose: "password_reset", userId: user, payload: { secretish: "value" } })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(Error);
		const text = everythingOn(thrown);
		expect(text).toContain("password_reset");
		expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/);
		expect(text).not.toContain("secretish");
		expect(text).not.toContain(user);
	});
});

function filesUnder(directory: string, extensions: readonly string[]): string[] {
	try {
		return readdirSync(directory, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && extensions.some((suffix) => entry.name.endsWith(suffix)))
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.sort();
	} catch {
		return [];
	}
}

// A committed 43-character base64url word decodes to exactly the 32 bytes of a token. There
// is no reason for one to be in the shipped tree.
describe("no plaintext token is committed", () => {
	it("finds no token-shaped literal in what ships or runs", () => {
		const shipped = [
			...filesUnder(`${repositoryRoot}src`, [".ts"]),
			...filesUnder(`${repositoryRoot}tools`, [".mjs"]),
			...filesUnder(`${repositoryRoot}migrations`, [".sql"]),
		];
		expect(shipped.length).toBeGreaterThan(50);

		const offenders: string[] = [];
		for (const path of shipped) {
			const text = readFileSync(path, "utf8");
			for (const match of text.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g)) {
				offenders.push(`${path}: ${match[0]}`);
			}
		}
		expect(offenders).toStrictEqual([]);
	});
});
