import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { createArgon2idHash } from "../src/core/password/argon2.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink, type LogSink } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, storedHashesFor } from "./password-fixtures.js";

/**
 * T-RACE-6 through the mounted handler. Each instance holds a connection of its own, as two
 * processes would, and the compare-and-swap of every rehash is held at a gate until the test lets
 * it go, so the two swaps are known to have read the same stored hash.
 */

const PASSWORD = drawTestPassword();
const THIRD_PARTY_PASSWORD = drawTestPassword();
const SETTLE_LIMIT_MS = 20_000;
const COMPARE_AND_SWAP = /^\s*UPDATE \S+\.password_credential\b[\s\S]*\bAND phc = \$5/;

const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

interface SwapGate {
	readonly results: number[];
	arrivals: number;
	release: () => void;
	released: Promise<void>;
}

function newGate(): SwapGate {
	let release = (): void => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { results: [], arrivals: 0, release, released };
}

let gate = newGate();

function gatingTheSwap(inner: Driver): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			if (!COMPARE_AND_SWAP.test(sql)) {
				return inner.query<T>(sql, params);
			}
			const current = gate;
			current.arrivals += 1;
			await current.released;
			const rows = await inner.query<T>(sql, params);
			current.results.push(rows.length);
			return rows;
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return inner.transaction((tx) => work(gatingTheSwap(tx)));
		},
	};
}

interface Process {
	readonly connection: TestConnection;
	readonly handler: (request: Request) => Promise<Response>;
	readonly log: LogSink;
}

let primary: TestConnection;
let schema: string;
const instances: Instance[] = [];
let accounts = 0;

async function startInstance(): Promise<Process> {
	const connection = await openTestConnection();
	const log = createLogSink();
	const auth = createVelveAuth(
		configFor({
			database: gatingTheSwap(connection),
			schema,
			keys,
			log: log.write,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	return { connection, handler: toWebHandler(auth), log };
}

beforeAll(async () => {
	({ connection: primary, schema } = await openMigratedSchema("racerehash"));
	instances.push(await startInstance(), await startInstance());
}, 60_000);

afterAll(async () => {
	for (const instance of instances) {
		await instance.connection.close();
	}
	await dropSchema(primary, schema);
	await primary.close();
});

async function accountWithBcrypt(): Promise<{ email: string; userId: string }> {
	accounts += 1;
	const email = `rehashrace${accounts}@example.com`;
	const [row] = await primary.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	const userId = (row as { id: string }).id;
	await createPasswordCredentialRepository({ driver: primary, keys, schema }).write({
		userId,
		phc: (await storedHashesFor(PASSWORD)).byScheme.bcrypt,
		scheme: "bcrypt",
		setBySessionId: null,
	});
	return { email, userId };
}

async function storedCredential(userId: string): Promise<{ scheme: string; phc: string }> {
	const [row] = await primary.query<{ scheme: string; phc: string }>(
		`SELECT scheme, encode(phc, 'hex') AS phc FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return row as { scheme: string; phc: string };
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + SETTLE_LIMIT_MS;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`${what} did not happen within ${SETTLE_LIMIT_MS} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function signIn(instance: Process, email: string, password: string): Promise<Response> {
	return instance.handler(postTo("/sign-in/password", { email, password }));
}

function failedDeferredWork(): readonly string[] {
	return instances.flatMap((instance) =>
		instance.log.lines
			.filter((line) => line.message === "deferred work failed" || line.level === "error")
			.map((line) => line.message),
	);
}

describe("T-RACE-6 — the rehash writes by compare-and-swap (S-RACE-6)", () => {
	it("lets exactly one of two simultaneous rehashes take effect", async () => {
		const account = await accountWithBcrypt();
		const [first, second] = instances as [Instance, Instance];
		gate = newGate();

		const answers = await Promise.all([
			signIn(first, account.email, PASSWORD),
			signIn(second, account.email, PASSWORD),
		]);
		await until(() => gate.arrivals === 2, "both rehashes reaching their swap");
		expect((await storedCredential(account.userId)).scheme, "nothing swapped yet").toBe("bcrypt");
		gate.release();
		await until(() => gate.results.length === 2, "both swaps returning");

		expect(answers.map((answer) => answer.status)).toStrictEqual([200, 200]);
		expect([...gate.results].sort()).toStrictEqual([0, 1]);
		expect(failedDeferredWork()).toStrictEqual([]);
		expect((await storedCredential(account.userId)).scheme).toBe("argon2id");
		expect((await signIn(first, account.email, PASSWORD)).status, "the stored hash").toBe(200);
		expect((await signIn(second, account.email, PASSWORD)).status).toBe(200);
	}, 60_000);

	it("leaves a hash a third party wrote between the read and the swap untouched", async () => {
		const account = await accountWithBcrypt();
		const [first] = instances as [Instance, Instance];
		gate = newGate();

		const answer = await signIn(first, account.email, PASSWORD);
		await until(() => gate.arrivals === 1, "the rehash reaching its swap");
		await createPasswordCredentialRepository({ driver: primary, keys, schema }).write({
			userId: account.userId,
			phc: await createArgon2idHash(new TextEncoder().encode(THIRD_PARTY_PASSWORD), {
				memoryKiB: 19456,
				iterations: 2,
				parallelism: 1,
			}),
			scheme: "argon2id",
			setBySessionId: null,
		});
		const writtenByTheThirdParty = await storedCredential(account.userId);
		gate.release();
		await until(() => gate.results.length === 1, "the swap returning");

		expect(answer.status).toBe(200);
		expect(gate.results).toStrictEqual([0]);
		expect(failedDeferredWork()).toStrictEqual([]);
		expect(await storedCredential(account.userId)).toStrictEqual(writtenByTheThirdParty);
		expect((await signIn(first, account.email, THIRD_PARTY_PASSWORD)).status).toBe(200);
		expect((await signIn(first, account.email, PASSWORD)).status).toBe(401);
	}, 60_000);
});
