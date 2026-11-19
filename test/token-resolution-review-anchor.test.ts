import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecurityStateSealedEvent } from "../src/index.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * Review of S-TOKEN-7: the resolve spends, extends, locks and writes nothing. A plugin's anchor is
 * a store the library writes to, so a resolve that records a seal with it writes; this holds the
 * resolve to the requirement as given, "must not write anything", for an anchor that is behind.
 */

const PASSWORD = "correct-horse-battery-staple";

let mounted: MountedAuth;
const recorded: SecurityStateSealedEvent[] = [];

beforeAll(async () => {
	mounted = await mountAuth("token_resolution_review_anchor", {
		securityState: { sealing: "required" },
		plugins: [
			{
				id: "anchor",
				securityStateAnchor: {
					//an anchor that has lost what it was told is behind on every seal
					minimumVersion: () => Promise.resolve(null),
					recordSeal: (event) => {
						recorded.push(event);
						return Promise.resolve();
					},
				},
			},
		],
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("the resolve writes nothing, not even to an anchor (S-TOKEN-7)", () => {
	it("records no seal with an anchor that is behind", async () => {
		const email = "anchor-review@example.com";
		const signedUp = await mounted.handler(
			requestTo("/sign-up", { body: { email, password: PASSWORD } }),
		);
		const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
		await mounted.handler(requestTo("/sign-in/magic-link/request", { body: { email } }));
		const message = mounted.email.messages.find((sent) => sent.kind === "magic_link");
		if (message === undefined || !("token" in message)) {
			throw new Error("no magic link mailed");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		recorded.length = 0;

		const answer = await mounted.auth.oneTimeToken.resolve({ token: message.token });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(answer).toStrictEqual({ userId, purpose: "magic_link" });
		expect(recorded).toStrictEqual([]);
	}, 30_000);
});
