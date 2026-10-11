import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";
import { backendPidOf, HeldDriver, waitUntilWaitingForALock } from "./lock-order-fixtures.js";

/**
 * Two accounts confirm a change to one address at the same time. Both pass the `NOT EXISTS` of the
 * move, and the second then meets `user_email_key` once the first commits. That second answer has
 * to be the one a taken address gets without a race, which S-ENUM-5 makes the one an invented
 * token gets, or a 500 tells the caller the address was claimed in that instant.
 */

const PASSWORD = "correct-horse-battery-staple";
const CONTESTED = "contested@example.com";
const AFTER_THE_MOVE = /DELETE FROM \S*password_credential/;

type Handler = (request: Request) => Promise<Response>;

let schema: string;
let observer: TestConnection;
let firstConnection: TestConnection;
let secondConnection: TestConnection;
let held: HeldDriver;
let first: Handler;
let second: Handler;
const outbox: EmailMessage[] = [];
const keys = testKeyProvider();

function handlerOn(database: Driver): Handler {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database,
				schema,
				keys,
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
			}),
		),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("emailchangerace");
	schema = migrated.schema;
	observer = migrated.connection;
	firstConnection = await openTestConnection();
	secondConnection = await openTestConnection();
	held = new HeldDriver(firstConnection);
	first = handlerOn(held);
	second = handlerOn(secondConnection);
}, 120_000);

afterAll(async () => {
	await dropSchema(observer, schema);
	await Promise.all([observer.close(), firstConnection.close(), secondConnection.close()]);
});

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error("the answer carried no session cookie");
}

async function changeTokenOf(address: string): Promise<string> {
	const signedUp = await second(postTo("/sign-up", { email: address, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	const requested = await second(
		postTo("/email/request-change", { newEmail: CONTESTED }, { Cookie: sessionCookieOf(signedUp) }),
	);
	expect(requested.status).toBe(204);
	const message = outbox.filter((each) => each.kind === "email_change").at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error("no email_change message carried a token");
	}
	return message.token;
}

describe("two confirmed changes to one address at the same time (S-ENUM-5)", () => {
	it("answers the one that loses on the unique key as the same change is answered without a race", async () => {
		const winnerToken = await changeTokenOf("winner@example.com");
		const loserToken = await changeTokenOf("loser@example.com");
		const pidOfSecond = await backendPidOf(secondConnection);

		const reachedAfterTheMove = held.holdBefore(AFTER_THE_MOVE);
		const winning = first(postTo("/email/redeem-change", { token: winnerToken }));
		await reachedAfterTheMove;
		const losing = second(postTo("/email/redeem-change", { token: loserToken }));
		await waitUntilWaitingForALock(observer, pidOfSecond, () => held.statements.join("\n"));
		held.release();

		const [won, lost] = await Promise.all([winning, losing]);
		const withoutARace = await second(postTo("/email/redeem-change", { token: loserToken }));
		const invented = await second(
			postTo("/email/redeem-change", { token: `${loserToken.slice(0, -4)}AAAA` }),
		);

		expect(won.status).toBe(200);
		expect(withoutARace.status).toBe(400);
		const racing = await normalisedAnswer(lost);
		//the racing answer must be the one an invalid token gets with its header set (S-ENUM-5)
		expect(racing).toBe(await normalisedAnswer(withoutARace));
		expect(racing).toBe(await normalisedAnswer(invented));
		const [row] = await observer.query<{ total: number }>(
			`SELECT count(*)::integer AS total FROM ${schema}.user WHERE email = $1`,
			[CONTESTED],
		);
		expect(row?.total).toBe(1);
	});
});
