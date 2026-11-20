import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintArtefact } from "../src/core/flows/artefact.js";
import type { OneTimeTokenPurpose } from "../src/core/token/purpose.js";
import { type MountedAuth, mountAuth, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

/**
 * S-ENUM-9 against S-TOKEN-7: `oneTimeToken.resolve` names an account only for a token its
 * redemption would act on, so while an account has turned recovery off a reset link and a magic link
 * of that account resolve to the same `null` an unknown token does. A link of another purpose is not
 * a way into the account and still resolves.
 */

const PASSWORD = "correct-horse-battery-staple";
const keys = testKeyProvider();
let mounted: MountedAuth;
let accounts = 0;

beforeAll(async () => {
	mounted = await mountAuth("norecovery_resolve", {
		keys,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function signUp(): Promise<{ userId: string; email: string }> {
	accounts += 1;
	const email = `no-recovery-resolve-${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	return { userId, email };
}

//a link minted in the window between a request's lookup and the switch carries the new generation
async function mintedLink(
	account: { userId: string; email: string },
	purpose: OneTimeTokenPurpose,
): Promise<string> {
	const minted = await mounted.connection.transaction((transaction) =>
		mintArtefact(
			transaction,
			{ schema: mounted.schema, keys },
			{ purpose, subject: { userId: account.userId }, accountEmail: account.email },
		),
	);
	return minted.token;
}

describe("resolving a link of a switched-off account (S-ENUM-9, S-TOKEN-7)", () => {
	it("answers null for its reset and magic links, as their redemption refuses them", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		const reset = await mintedLink(account, "password_reset");
		const magic = await mintedLink(account, "magic_link");

		expect(await mounted.auth.oneTimeToken.resolve({ token: reset })).toBeNull();
		expect(await mounted.auth.oneTimeToken.resolve({ token: magic })).toBeNull();
		const redeemed = await mounted.handler(postTo("/sign-in/magic-link/redeem", { token: magic }));
		expect(redeemed.status).toBe(400);
	});

	it("still resolves a link that is not a way into the account", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		const verify = await mintedLink(account, "email_verify");

		expect(await mounted.auth.oneTimeToken.resolve({ token: verify })).toStrictEqual({
			userId: account.userId,
			purpose: "email_verify",
		});
	});

	it("resolves a link minted while recovery was off to nothing once it is back on, as its redemption refuses it", async () => {
		const account = await signUp();
		await mounted.auth.user.disableRecovery({ userId: account.userId });
		const magic = await mintedLink(account, "magic_link");
		await mounted.auth.user.enableRecovery({ userId: account.userId });

		expect(await mounted.auth.oneTimeToken.resolve({ token: magic })).toBeNull();
		const redeemed = await mounted.handler(postTo("/sign-in/magic-link/redeem", { token: magic }));
		expect(redeemed.status).toBe(400);
	});
});
