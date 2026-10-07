import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

//a link mailed to an address set only for the request must not redeem once the token and seal branches bind it (E-3312)

let mounted: MountedAuth;

beforeEach(async () => {
	mounted = await mountAuth("transient_email");
});

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const VICTIM = "victim@example.com";
const ATTACKER = "attacker@example.com";

async function post(path: string, body: unknown): Promise<Response> {
	return mounted.handler(requestTo(path, { body }));
}

async function setEmail(from: string, to: string): Promise<void> {
	await mounted.connection.query(`UPDATE ${mounted.schema}.user SET email = $2 WHERE email = $1`, [
		from,
		to,
	]);
}

async function magicLinkRedeemedAfterAnAddressFlip(): Promise<{
	readonly mailedTo: string | undefined;
	readonly status: number;
}> {
	const signedUp = await post("/sign-up", { email: VICTIM, password: "victim's own password 1" });
	expect(signedUp.status).toBe(200);
	await setEmail(VICTIM, ATTACKER);
	mounted.email.clear();
	await post("/sign-in/magic-link/request", { email: ATTACKER });
	const link = mounted.email.messages.at(-1) as EmailMessage & { to: string; token: string };
	expect(link?.kind).toBe("magic_link");
	await setEmail(ATTACKER, VICTIM);
	const redeemed = await post("/sign-in/magic-link/redeem", { token: link.token });
	return { mailedTo: link?.to, status: redeemed.status };
}

describe("a writer who flips the address only while the link is requested (section 3.18 point 3)", () => {
	it.fails("cannot redeem a magic link mailed to the address the seal never held", async () => {
		expect((await magicLinkRedeemedAfterAnAddressFlip()).status).not.toBe(200);
	});

	it("control: today the link goes to the writer's address and its redemption succeeds", async () => {
		expect(await magicLinkRedeemedAfterAnAddressFlip()).toStrictEqual({
			mailedTo: ATTACKER,
			status: 200,
		});
	});
});
