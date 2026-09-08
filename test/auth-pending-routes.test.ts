import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationService,
	type PendingAuthenticationService,
	type PendingToken,
} from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;
let pending: PendingAuthenticationService;

beforeAll(async () => {
	mounted = await mountAuth("pendingroutes");
	pending = createPendingAuthenticationService({
		driver: mounted.connection,
		schema: mounted.schema,
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function openPendingState(): Promise<PendingToken> {
	const userId = await createUser(mounted.connection, mounted.schema);
	const issued = await pending.begin({
		userId,
		factorsCompleted: ["password"],
		availableFactors: ["totp"],
	});
	return issued.token;
}

function cookieFor(token: string): string {
	return `${DEFAULT_COOKIE_NAMES.pending}=${token}`;
}

async function get(path: string, cookie?: string): Promise<Response> {
	return mounted.handler(
		requestTo(path, { method: "GET", ...(cookie === undefined ? {} : { cookie }) }),
	);
}

async function post(path: string, cookie?: string): Promise<Response> {
	return mounted.handler(
		requestTo(path, { method: "POST", body: {}, ...(cookie === undefined ? {} : { cookie }) }),
	);
}

async function openStates(): Promise<number> {
	const [row] = await mounted.connection.query<{ present: number }>(
		`SELECT count(*)::int AS present FROM ${mounted.schema}.pending_authentication`,
		[],
	);
	return row?.present ?? -1;
}

/** 3.15 D.3, rows `GET /pending` and `POST /pending/cancel`; E-335 left both undeclared. */
describe("reading the intermediate state (B.7)", () => {
	it("reports the state the cookie names, and nothing an account could be built from", async () => {
		const token = await openPendingState();

		const answer = await get("/pending", cookieFor(token));
		const body = (await answer.json()) as Record<string, unknown>;

		expect(answer.status).toBe(200);
		expect(Object.keys(body).sort()).toStrictEqual([
			"attemptsRemaining",
			"availableFactors",
			"expiresAt",
			"factorsCompleted",
		]);
		expect(body.attemptsRemaining).toBe(5);
		expect(body.factorsCompleted).toStrictEqual(["password"]);
	});

	it("answers null without a cookie and null for a token nobody issued", async () => {
		const answers = await Promise.all([
			get("/pending"),
			get("/pending", cookieFor("z".repeat(43))),
		]);
		const bodies = await Promise.all(answers.map((answer) => answer.text()));

		expect(bodies).toHaveLength(2);
		expect(bodies).toStrictEqual(["null", "null"]);
		expect(answers.map((answer) => answer.status)).toStrictEqual([200, 200]);
	});

	it("reads the cookie without accepting it as authorization", async () => {
		const token = await openPendingState();

		const readable = await get("/pending", cookieFor(token));
		const authorised = await get("/session/list", cookieFor(token));

		expect(readable.status).toBe(200);
		expect(authorised.status).toBe(401);
	});
});

describe("cancelling the intermediate state (3.6, L-8)", () => {
	it("removes the row and clears the cookie", async () => {
		const token = await openPendingState();
		const before = await openStates();

		const answer = await post("/pending/cancel", cookieFor(token));

		expect(answer.status).toBe(204);
		expect(answer.headers.getSetCookie()).toStrictEqual([
			"__Host-velve_pending=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/",
		]);
		expect(await openStates()).toBe(before - 1);
		expect(await (await get("/pending", cookieFor(token))).text()).toBe("null");
	});

	it("clears the cookie for a token nobody issued, and for none at all", async () => {
		const answers = [
			await post("/pending/cancel", cookieFor("y".repeat(43))),
			await post("/pending/cancel"),
		];

		expect(answers).toHaveLength(2);
		expect(answers.map((answer) => answer.status)).toStrictEqual([204, 204]);
		expect(answers.map((answer) => answer.headers.getSetCookie().length)).toStrictEqual([1, 1]);
	});

	it("leaves another caller's state alone", async () => {
		const mine = await openPendingState();
		const theirs = await openPendingState();

		await post("/pending/cancel", cookieFor(mine));

		expect(await (await get("/pending", cookieFor(theirs))).status).toBe(200);
		expect(await (await get("/pending", cookieFor(theirs))).text()).not.toBe("null");
	});
});
