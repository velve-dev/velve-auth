import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";

/** One more than the two a race needs, so a report of "one winner" is not a report of "one pair". */
const RACING_CONNECTIONS = 4;
const PASSWORD = "correct horse battery staple";

let connections: TestConnection[] = [];
let handlers: ((request: Request) => Promise<Response>)[] = [];
let schema = "";

function handlerOn(connection: TestConnection) {
	return toWebHandler(
		createVelveAuth({
			identity: { mode: "email" },
			database: connection,
			schema,
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
			email: { send: () => Promise.resolve() },
		} as VelveAuthConfig<"email">),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("signuprace");
	schema = migrated.schema;
	connections = [migrated.connection];
	while (connections.length < RACING_CONNECTIONS) {
		connections.push(await openTestConnection());
	}
	handlers = connections.map(handlerOn);
}, 60_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

/** Every request starts from the same released promise, so the reads all precede the first insert. */
async function registerSimultaneously(path: string, address: string): Promise<Response[]> {
	const body = path === "/sign-up" ? { email: address, password: PASSWORD } : { email: address };
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	const sent = handlers.map((handler) => gate.then(() => handler(postTo(path, body))));
	release();
	return Promise.all(sent);
}

async function accountsHolding(address: string): Promise<number> {
	const [row] = await (connections[0] as TestConnection).query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${schema}.user WHERE email = $1`,
		[address],
	);
	return row?.total ?? -1;
}

/**
 * S-ENUM-3 under concurrency. Occupancy is read outside the transaction that inserts, so four
 * requests for one free address all read "free" and three of them meet the unique index. A caller
 * that loses that race is a caller registering an address that is now taken, and 3.13 fixes what
 * a taken address is answered with — so the enumeration argument only holds if the loser gets the
 * cover rather than a failure. It got `500 internal_error`, which is neither the cover nor a code
 * `/sign-up` declares (3.15 D.1).
 */
describe("S-ENUM-3: a registration that loses the insert race is answered as a taken address is", () => {
	it("answers every racing caller alike, and leaves one account behind", async () => {
		const address = "contended.first@example.com";

		const answers = await registerSimultaneously("/sign-up", address);

		expect(
			answers.map((answer) => answer.status),
			"every racing caller is answered as the winner is",
		).toStrictEqual(answers.map(() => 200));
		const shapes = await Promise.all(answers.map(normalisedAnswer));
		expect(shapes).toStrictEqual(shapes.map(() => shapes[0]));
		expect(await accountsHolding(address)).toBe(1);
	}, 60_000);

	it("answers the passwordless row alike too", async () => {
		const address = "contended.second@example.com";

		const answers = await registerSimultaneously("/sign-up/passwordless", address);

		expect(answers.map((answer) => answer.status)).toStrictEqual(answers.map(() => 200));
		const shapes = await Promise.all(answers.map(normalisedAnswer));
		expect(shapes).toStrictEqual(shapes.map(() => shapes[0]));
		expect(await accountsHolding(address)).toBe(1);
	}, 60_000);
});
