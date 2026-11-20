import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { AuthenticationFactor } from "../src/core/http/caller.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * 3.15 G: a hook observes or refuses and cannot replace the response, and "all event fields are
 * readonly". `readonly` is a compile-time word; `SessionCreateEvent.factors` is handed over as the
 * very array the flow then writes into the session row and its token MAC. A listener that pushes
 * into it decides which factors the new session claims.
 */

let pushInto = false;
const pushedInto: AuthenticationFactor[][] = [];

const ELEVATOR: VelvePlugin<"elevator"> = {
	id: "elevator",
	hooks: {
		beforeSessionCreate: (event) => {
			if (pushInto) {
				//a frozen event answers the push with a TypeError the hook keeps to itself
				try {
					(event.factors as AuthenticationFactor[]).push("totp");
					pushedInto.push(event.factors as AuthenticationFactor[]);
				} catch {
					return Promise.resolve();
				}
			}
			return Promise.resolve();
		},
	},
};

let mounted: MountedAuth;
let bystander: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("secplugfactors", { plugins: [ELEVATOR] });
	bystander = await mountAuth("secplugbystander");
});

afterAll(async () => {
	for (const array of pushedInto) {
		const index = array.lastIndexOf("totp");
		if (index !== -1) {
			array.splice(index, 1);
		}
	}
	for (const each of [mounted, bystander]) {
		await dropSchema(each.connection, each.schema);
		await each.connection.close();
	}
});

function tokenOf(message: EmailMessage | undefined): string {
	if (message === undefined || !("token" in message)) {
		throw new Error("the reset message carries no token");
	}
	return message.token;
}

async function resetOn(
	target: MountedAuth,
	email: string,
): Promise<readonly AuthenticationFactor[]> {
	await target.auth.signUp.withPassword({
		email,
		password: "correct-horse-battery-staple",
		origin: TEST_ORIGIN,
	});
	target.email.clear();
	await target.auth.password.requestReset({ email, origin: TEST_ORIGIN });
	const redeemed = await target.auth.password.redeemReset({
		token: tokenOf(target.email.messages.at(-1)),
		newPassword: "an entirely new password",
		origin: TEST_ORIGIN,
	});
	return (redeemed as { readonly session: { readonly factors: readonly AuthenticationFactor[] } })
		.session.factors;
}

describe("a hook cannot change the factors a session records (3.11, 3.15 G)", () => {
	it("issues a sign-up session with the password alone when a beforeSessionCreate listener pushes a factor", async () => {
		pushInto = true;
		let answered: readonly AuthenticationFactor[] = [];
		let stored = "";
		try {
			const signedUp = await mounted.auth.signUp.withPassword({
				email: "elevated@example.com",
				password: "correct-horse-battery-staple",
				origin: TEST_ORIGIN,
			});
			answered = signedUp.session.factors;
			const [row] = await mounted.connection.query<{ factors: string }>(
				`SELECT factors FROM ${mounted.schema}.session WHERE id = $1`,
				[signedUp.session.id],
			);
			stored = row?.factors ?? "";
		} finally {
			pushInto = false;
		}

		expect(answered, "the session the sign-up answered with").toStrictEqual(["password"]);
		//the test connection reads a text array in its literal form
		expect(stored, "the session row the sign-up wrote").toBe("{password}");
	});

	it("issues a reset session on another instance, with no plugin, with the password alone after a plugin pushed into a reset's factors", async () => {
		pushInto = true;
		try {
			await resetOn(mounted, "first-reset@example.com");
		} finally {
			pushInto = false;
		}
		const elsewhere = await resetOn(bystander, "bystander@example.com");

		expect(elsewhere, "a reset on an instance that has no plugin at all").toStrictEqual([
			"password",
		]);
	});
});
