import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth, type SecurityStateSealedEvent } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { memoryAnchor } from "./security-state-administration-fixtures.js";
import { testKeyProvider } from "./totp-fixtures.js";

//recordSeal must be called after the new seal has committed and never before (S-INTEG-6)

const PASSWORD = drawTestPassword();
const NEW_PASSWORD = drawTestPassword();

let connection: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("anchor_after_commit"));
	observer = await openTestConnection();
}, 60_000);

afterAll(async () => {
	await observer.close();
	await dropSchema(connection, schema);
	await connection.close();
});

type CommitMode = "normal" | "delayed" | "fails";

function controlledDriver(inner: Driver, mode: { current: CommitMode }): Driver {
	return {
		query: (sql, params) => inner.query(sql, params),
		transaction: (fn) =>
			inner.transaction(async (tx) => {
				const result = await fn(tx);
				if (mode.current === "delayed") {
					await new Promise((resolve) => setTimeout(resolve, 300));
				}
				if (mode.current === "fails") {
					throw new Error("the commit did not happen");
				}
				return result;
			}),
	};
}

async function committedVersionOf(userId: string): Promise<number> {
	const [row] = await observer.query<{ version: string }>(
		`SELECT version::text AS version FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return Number(row?.version);
}

function mount() {
	const mode = { current: "normal" as CommitMode };
	const anchor = memoryAnchor();
	const seenAtRecord: { event: SecurityStateSealedEvent; committed: Promise<number> }[] = [];
	const recordSeal = anchor.anchor.recordSeal.bind(anchor.anchor);
	const messages: EmailMessage[] = [];
	const alarms: SecurityStateAlarm[] = [];
	const auth = createVelveAuth(
		configFor({
			database: controlledDriver(connection, mode),
			schema,
			keys: testKeyProvider(),
			email: {
				send: (message) => {
					messages.push(message);
					return Promise.resolve();
				},
			},
			plugins: [
				{
					id: "anchor",
					securityStateAnchor: {
						recordSeal: (event, context) => {
							seenAtRecord.push({ event, committed: committedVersionOf(event.userId) });
							return recordSeal(event, context);
						},
						minimumVersion: anchor.anchor.minimumVersion.bind(anchor.anchor),
					},
				},
			],
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	return { auth, handler: toWebHandler(auth), mode, seenAtRecord, messages, alarms };
}

async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("a reset redeemed inside the redemption's own transaction", () => {
	it("tells the anchor its seal only once that seal is the committed one", async () => {
		const mounted = mount();
		const email = `${randomBytes(6).toString("hex")}@example.com`;
		const signedUp = await mounted.auth.signUp.withPassword({
			email,
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		await settled();
		await mounted.handler(postTo("/password/request-reset", { email }));
		const token = (mounted.messages.at(-1) as { token: string }).token;
		mounted.seenAtRecord.length = 0;
		mounted.mode.current = "delayed";
		const response = await mounted.handler(
			postTo("/password/redeem-reset", { token, newPassword: NEW_PASSWORD }),
		);
		mounted.mode.current = "normal";
		expect(response.status).toBe(200);
		const record = mounted.seenAtRecord.find((seen) => seen.event.userId === signedUp.user.id);
		expect(record, "the anchor learned the reset's seal").toBeDefined();
		expect(
			await record?.committed,
			"the version stored and committed when recordSeal was called",
		).toBe(record?.event.version);
	});

	it("does not lock a legitimate user out when the redemption's commit fails", async () => {
		const mounted = mount();
		const email = `${randomBytes(6).toString("hex")}@example.com`;
		const signedUp = await mounted.auth.signUp.withPassword({
			email,
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		await settled();
		await mounted.handler(postTo("/password/request-reset", { email }));
		const token = (mounted.messages.at(-1) as { token: string }).token;
		mounted.mode.current = "fails";
		await mounted.handler(postTo("/password/redeem-reset", { token, newPassword: NEW_PASSWORD }));
		mounted.mode.current = "normal";
		await settled();

		let status: string;
		try {
			status = (
				await mounted.auth.signIn.password({ email, password: PASSWORD, origin: TEST_ORIGIN })
			).status;
		} catch (error) {
			status = (error as { code?: string }).code ?? "thrown";
		}
		await settled();
		expect(
			mounted.alarms.filter((alarm) => alarm.userId === signedUp.user.id).map((a) => a.reason),
		).toStrictEqual([]);
		expect(status, "the old password still signs in after a reset that never committed").toBe(
			"signed_in",
		);
	});
});
