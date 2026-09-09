import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, VelveAuthConfig } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/** T-RACE-1's width. Its twenty repetitions are a nightly threshold; five run on every commit here. */
const RACERS = 50;
const REPETITIONS = 5;

type Handler = (request: Request) => Promise<Response>;

let connections: TestConnection[] = [];
let handlers: Handler[] = [];
let schema: string;
const outbox: EmailMessage[] = [];

function handlerOn(connection: TestConnection): Handler {
	const auth = createVelveAuth({
		identity: { mode: "email" },
		database: connection,
		schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		// The race is the subject; a bucket that refuses the forty-ninth request would measure itself.
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
		email: {
			send: (message) => {
				outbox.push(message);
				return Promise.resolve();
			},
		},
	} as VelveAuthConfig<"email">);
	return toWebHandler(auth);
}

function post(handler: Handler, path: string, body: unknown, cookie?: string): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: {
				Origin: TEST_ORIGIN,
				"Content-Type": "application/json",
				...(cookie === undefined ? {} : { Cookie: cookie }),
			},
			body: JSON.stringify(body),
		}),
	);
}

const first = (): Handler => handlers[0] as Handler;
const connection = (): TestConnection => connections[0] as TestConnection;

beforeAll(async () => {
	const migrated = await openMigratedSchema("flowsrace");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < RACERS; index += 1) {
		connections.push(await openTestConnection());
	}
	handlers = connections.map(handlerOn);
}, 120_000);

afterAll(async () => {
	await dropSchema(connection(), schema);
	await Promise.all(connections.map((each) => each.close()));
});

function tokenOf(kind: EmailMessage["kind"]): string {
	const message = outbox.filter((each) => each.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message with a token`);
	}
	return message.token;
}

async function freshAccount(address: string): Promise<void> {
	outbox.length = 0;
	await connection().query(`DELETE FROM ${schema}.user`, []);
	await connection().query(`DELETE FROM ${schema}.one_time_token`, []);
	await connection().query(`DELETE FROM ${schema}.rate_bucket`, []);
	const created = await post(first(), "/sign-up", {
		email: address,
		password: "a password long enough",
	});
	if (created.status !== 200) {
		throw new Error(`the account was not created: ${created.status} ${await created.text()}`);
	}
}

describe("S-RACE-1 through the routes that redeem a mailed artefact", () => {
	it("lets exactly one of fifty simultaneous magic-link redemptions through", async () => {
		const outcomes: string[] = [];
		for (let run = 0; run < REPETITIONS; run += 1) {
			await freshAccount(`racer${run}@example.com`);
			await post(first(), "/sign-in/magic-link/request", { email: `racer${run}@example.com` });
			const token = tokenOf("magic_link");

			const answers = await Promise.all(
				handlers.map((handler) => post(handler, "/sign-in/magic-link/redeem", { token })),
			);

			const [row] = await connection().query<{ total: number }>(
				`SELECT count(*)::int AS total FROM ${schema}.one_time_token WHERE purpose = 'magic_link'`,
				[],
			);
			outcomes.push(
				`${answers.filter((answer) => answer.status === 200).length}/${answers.length} left ${row?.total ?? -1}`,
			);
		}

		expect(outcomes).toStrictEqual(Array.from({ length: REPETITIONS }, () => `1/50 left 0`));
	}, 120_000);

	it("lets exactly one of fifty simultaneous reset redemptions through", async () => {
		const outcomes: string[] = [];
		for (let run = 0; run < REPETITIONS; run += 1) {
			await freshAccount(`resetter${run}@example.com`);
			await post(first(), "/password/request-reset", { email: `resetter${run}@example.com` });
			const token = tokenOf("password_reset");

			const answers = await Promise.all(
				handlers.map((handler) =>
					post(handler, "/password/redeem-reset", { token, newPassword: "the replacement one" }),
				),
			);

			const [row] = await connection().query<{ total: number }>(
				`SELECT count(*)::int AS total FROM ${schema}.password_credential`,
				[],
			);
			outcomes.push(
				`${answers.filter((answer) => answer.status === 200).length}/${answers.length} credentials ${row?.total ?? -1}`,
			);
		}

		expect(outcomes).toStrictEqual(Array.from({ length: REPETITIONS }, () => `1/50 credentials 1`));
	}, 120_000);
});

describe("S-LINK-4: two confirmations arriving together settle on one first", () => {
	it("marks the address once and leaves no password behind", async () => {
		const outcomes: string[] = [];
		for (let run = 0; run < REPETITIONS; run += 1) {
			const address = `both${run}@example.com`;
			await freshAccount(address);
			const confirmation = tokenOf("email_verification");
			await post(first(), "/sign-in/magic-link/request", { email: address });
			const link = tokenOf("magic_link");

			const answers = await Promise.all([
				post(handlers[0] as Handler, "/email/redeem-verification", { token: confirmation }),
				post(handlers[1] as Handler, "/sign-in/magic-link/redeem", { token: link }),
			]);

			const [row] = await connection().query<{ credentials: number; verified: number }>(
				`SELECT (SELECT count(*)::int FROM ${schema}.password_credential) AS credentials,
				        (SELECT count(*)::int FROM ${schema}.user WHERE email_verified_at IS NOT NULL) AS verified`,
				[],
			);
			outcomes.push(
				`${answers.map((answer) => answer.status).join(",")} credentials ${row?.credentials ?? -1} verified ${row?.verified ?? -1}`,
			);
		}

		expect(outcomes).toStrictEqual(
			Array.from({ length: REPETITIONS }, () => "200,200 credentials 0 verified 1"),
		);
	}, 120_000);
});
