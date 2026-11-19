import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import type { SecurityStateSealedEvent } from "../src/index.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * Review of S-TOKEN-7 after E-3696: the resolve now verifies the seal and the anchors' floors on a
 * path of its own instead of through checkAccount. It must refuse exactly what the redemption's
 * check refuses — a floor above the seal, a digest unlike the floor's at its version, an anchor
 * that throws or answers what cannot be read, a broken or missing seal — with the same alarm, must
 * accept what the redemption accepts, and must record nothing with any anchor while doing so.
 */

const PASSWORD = "correct-horse-battery-staple";

type FloorAnswer = () => Promise<unknown>;

const floors = new Map<string, FloorAnswer>();
const secondFloors = new Map<string, FloorAnswer>();
const recorded: SecurityStateSealedEvent[] = [];
const alarms: SecurityStateAlarm[] = [];
let mounted: MountedAuth;
let resolving = false;
let recordedWhileResolving = 0;

function anchorOver(answers: Map<string, FloorAnswer>) {
	return {
		minimumVersion: ({ userId }: { readonly userId: string }) =>
			(answers.get(userId) ?? (() => Promise.resolve(null)))() as Promise<never>,
		recordSeal: (event: SecurityStateSealedEvent) => {
			recorded.push(event);
			if (resolving) {
				recordedWhileResolving += 1;
			}
			return Promise.resolve();
		},
	};
}

beforeAll(async () => {
	mounted = await mountAuth("token_resolution_review_floors", {
		securityState: { sealing: "required", alarm: (event) => alarms.push(event) },
		plugins: [
			{ id: "floors", securityStateAnchor: anchorOver(floors) },
			{ id: "second", securityStateAnchor: anchorOver(secondFloors) },
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

interface Account {
	readonly userId: string;
	readonly token: string;
}

async function accountWithMagicLink(): Promise<Account> {
	const email = `floors-${randomBytes(4).toString("hex")}@example.com`;
	const signedUp = await mounted.handler(
		requestTo("/sign-up", { body: { email, password: PASSWORD } }),
	);
	const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
	await mounted.handler(requestTo("/sign-in/magic-link/request", { body: { email } }));
	const message = mounted.email.messages
		.filter((sent) => sent.kind === "magic_link" && sent.to === email)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error("no magic link mailed");
	}
	return { userId, token: message.token };
}

async function sealOf(userId: string): Promise<{ version: number; digest: string }> {
	const [row] = await mounted.connection.query<{ version: string; digest: string }>(
		`SELECT version::text AS version, encode(digest, 'hex') AS digest
		 FROM ${mounted.schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	if (row === undefined) {
		throw new Error("no seal row");
	}
	return {
		version: Number(row.version),
		digest: Buffer.from(row.digest, "hex").toString("base64url"),
	};
}

function answering(value: unknown): FloorAnswer {
	return () => Promise.resolve(value);
}

async function resolvedWithAlarms(
	account: Account,
): Promise<{ answer: unknown; reasons: readonly string[] }> {
	await new Promise((resolve) => setTimeout(resolve, 30));
	alarms.length = 0;
	resolving = true;
	const answer = await mounted.auth.oneTimeToken.resolve({ token: account.token });
	await new Promise((resolve) => setTimeout(resolve, 30));
	resolving = false;
	const reasons = alarms
		.filter((alarm) => alarm.userId === account.userId)
		.map((alarm) => `${alarm.occasion} ${alarm.reason}`);
	return { answer, reasons };
}

async function redemptionTookEffect(account: Account): Promise<boolean> {
	const answer = await mounted.handler(
		requestTo("/sign-in/magic-link/redeem", { body: { token: account.token } }),
	);
	if (answer.status === 200) {
		return true;
	}
	expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("invalid_token");
	return false;
}

type Arrange = (account: Account) => Promise<void>;

const cases: readonly (readonly [string, Arrange, string | null])[] = [
	["no anchor has a floor", () => Promise.resolve(), null],
	[
		"the floor is the seal itself",
		async ({ userId }) => {
			floors.set(userId, answering(await sealOf(userId)));
		},
		null,
	],
	[
		"the floor is below the seal",
		async ({ userId }) => {
			const seal = await sealOf(userId);
			floors.set(userId, answering({ version: seal.version - 1, digest: seal.digest }));
		},
		null,
	],
	[
		"the floor is above the seal",
		async ({ userId }) => {
			const seal = await sealOf(userId);
			floors.set(userId, answering({ version: seal.version + 1, digest: seal.digest }));
		},
		"version_below_anchor",
	],
	[
		"the floor names the seal's version with another digest",
		async ({ userId }) => {
			const seal = await sealOf(userId);
			floors.set(
				userId,
				answering({ version: seal.version, digest: randomBytes(32).toString("base64url") }),
			);
		},
		"anchor_mismatch",
	],
	[
		"the anchor throws",
		async ({ userId }) => {
			floors.set(userId, () => Promise.reject(new Error("anchor down")));
		},
		"anchor_unavailable",
	],
	[
		"the anchor answers a version that is not an integer",
		async ({ userId }) => {
			const seal = await sealOf(userId);
			floors.set(userId, answering({ version: Number.NaN, digest: seal.digest }));
		},
		"anchor_unavailable",
	],
	[
		"one anchor holds the seal and the other cannot answer",
		async ({ userId }) => {
			floors.set(userId, answering(await sealOf(userId)));
			secondFloors.set(userId, answering("not a floor"));
		},
		"anchor_unavailable",
	],
	[
		"a writer changed a sealed component",
		async ({ userId }) => {
			floors.set(userId, answering(await sealOf(userId)));
			await mounted.connection.query(
				`UPDATE ${mounted.schema}.user SET email_verified_at = now() WHERE id = $1`,
				[userId],
			);
		},
		"seal_mismatch",
	],
	[
		"a writer removed the seal row",
		async ({ userId }) => {
			await mounted.connection.query(
				`DELETE FROM ${mounted.schema}.security_state WHERE user_id = $1`,
				[userId],
			);
		},
		"seal_missing",
	],
	[
		"a writer removed the seal row of an account an anchor holds",
		async ({ userId }) => {
			floors.set(userId, answering(await sealOf(userId)));
			await mounted.connection.query(
				`DELETE FROM ${mounted.schema}.security_state WHERE user_id = $1`,
				[userId],
			);
		},
		"seal_missing",
	],
];

describe("the resolve's own seal check refuses what the redemption's check refuses (S-TOKEN-7, E-3696)", () => {
	for (const [state, arrange, refusal] of cases) {
		it(`${state}: ${refusal ?? "resolves"}, as the redemption does, recording nothing`, async () => {
			const account = await accountWithMagicLink();
			await arrange(account);

			const { answer, reasons } = await resolvedWithAlarms(account);
			const tookEffect = await redemptionTookEffect(account);

			expect(recordedWhileResolving).toBe(0);
			expect(tookEffect).toBe(refusal === null);
			expect(answer).toStrictEqual(
				refusal === null ? { userId: account.userId, purpose: "magic_link" } : null,
			);
			expect(reasons).toStrictEqual(refusal === null ? [] : [`token_redemption ${refusal}`]);
		}, 30_000);
	}
});
