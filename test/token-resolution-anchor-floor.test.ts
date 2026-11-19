import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * S-TOKEN-7 with E-3696: the resolve records no seal with an anchor, but it still asks the anchors
 * for their floors. A seal below an anchor's floor is a state a writer rolled back, which the
 * redemption refuses, so the resolve answers it with null and the alarm a check would raise.
 */

const PASSWORD = "correct-horse-battery-staple";
const FLOOR_ABOVE_EVERY_SEAL = { version: 1_000_000, digest: encodeBase64Url(new Uint8Array(32)) };

let mounted: MountedAuth;
let floorFor: string | null = null;
const alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	mounted = await mountAuth("token_resolution_anchor_floor", {
		securityState: { sealing: "required", alarm: (event) => alarms.push(event) },
		plugins: [
			{
				id: "floor",
				securityStateAnchor: {
					minimumVersion: ({ userId }) =>
						Promise.resolve(userId === floorFor ? FLOOR_ABOVE_EVERY_SEAL : null),
					recordSeal: () => Promise.resolve(),
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

describe("a seal below an anchor's floor resolves to null (S-TOKEN-7)", () => {
	it("answers null and raises one alarm version_below_anchor", async () => {
		const email = "floor@example.com";
		const signedUp = await mounted.handler(
			requestTo("/sign-up", { body: { email, password: PASSWORD } }),
		);
		const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
		await mounted.handler(requestTo("/sign-in/magic-link/request", { body: { email } }));
		const message = mounted.email.messages.find((sent) => sent.kind === "magic_link");
		if (message === undefined || !("token" in message)) {
			throw new Error("no magic link mailed");
		}
		expect(await mounted.auth.oneTimeToken.resolve({ token: message.token })).toStrictEqual({
			userId,
			purpose: "magic_link",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		alarms.length = 0;

		floorFor = userId;
		const answer = await mounted.auth.oneTimeToken.resolve({ token: message.token });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(answer).toBeNull();
		expect(
			alarms.filter((alarm) => alarm.userId === userId).map((alarm) => alarm.reason),
		).toStrictEqual(["version_below_anchor"]);
	}, 30_000);
});
