import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * A way into an account that section 5.22 does not name: an account pre-created at the victim's
 * address without a password. L-12 and S-LINK-4 take a password set elsewhere away at the first
 * confirmation, and E-608 leaves everything else standing when there is no password, so the
 * creator's session outlives the moment the address's owner proves the mailbox and starts using the
 * account. The map lists neither a guard nor an open gap for it.
 */

let mounted: MountedAuth;

beforeEach(async () => {
	mounted = await mountAuth("mapprehijack");
});

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const VICTIM = "owner-of-the-mailbox@example.com";

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function readSession(cookie?: string): Promise<Response> {
	return mounted.handler(
		requestTo("/session", { method: "GET", ...(cookie === undefined ? {} : { cookie }) }),
	);
}

function sessionCookieOf(answer: Response): string {
	const value = /__Host-velve_session=([^;]*)/.exec(answer.headers.get("Set-Cookie") ?? "")?.[1];
	if (value === undefined || value === "") {
		throw new Error(`the answer ${answer.status} carried no session cookie`);
	}
	return `__Host-velve_session=${value}`;
}

function lastTokenOf(kind: EmailMessage["kind"]): string {
	const message = mounted.email.messages.filter((each) => each.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message with a token was sent`);
	}
	return message.token;
}

async function answerOf(answer: Response): Promise<string> {
	return `${answer.status} ${await answer.clone().text()}`;
}

async function readsAnAccount(cookie: string): Promise<boolean> {
	const body = (await (await readSession(cookie)).json()) as { session?: unknown } | null;
	return body !== null && body.session !== undefined;
}

describe("an account pre-created at the victim's address without a password", () => {
	it("leaves the creator no session once the owner of the mailbox confirms it and signs in", async () => {
		const preCreation = await post("/sign-up/passwordless", { email: VICTIM });
		expect(preCreation.status).toBe(200);
		const creatorsCookie = sessionCookieOf(preCreation);
		expect(await readsAnAccount(creatorsCookie)).toBe(true);

		await post("/sign-in/magic-link/request", { email: VICTIM });
		const ownersSignIn = await post("/sign-in/magic-link/redeem", {
			token: lastTokenOf("magic_link"),
		});
		expect(ownersSignIn.status).toBe(200);
		expect(await readsAnAccount(sessionCookieOf(ownersSignIn))).toBe(true);

		//the creator never proved the mailbox and must read the account the owner now uses no more
		expect(await answerOf(await readSession(creatorsCookie))).toBe(
			await answerOf(await readSession()),
		);
	});
});
