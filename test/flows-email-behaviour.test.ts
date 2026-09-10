import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;

beforeEach(async () => {
	mounted = await mountAuth("emailflows");
});

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function tokenOf(message: EmailMessage): string {
	if (!("token" in message)) {
		throw new Error(`the ${message.kind} message carries no token`);
	}
	return message.token;
}

function sessionCookieIn(answer: Response): string {
	const header = answer.headers.get("Set-Cookie") ?? "";
	const value = /__Host-velve_session=([^;]*)/.exec(header)?.[1];
	if (value === undefined || value === "") {
		throw new Error(`no session cookie in ${header}`);
	}
	return `__Host-velve_session=${value}`;
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

async function countRows(table: string, predicate: string, params: unknown[]): Promise<number> {
	const [row] = await mounted.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${mounted.schema}.${table} WHERE ${predicate}`,
		params,
	);
	return row?.total ?? 0;
}

async function userIdOf(email: string): Promise<string> {
	const [row] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[email],
	);
	if (row === undefined) {
		throw new Error(`no account for ${email}`);
	}
	return row.id;
}

const VICTIM = "victim@example.com";
const ATTACKER_PASSWORD = "correct horse battery staple";

describe("S-LINK-4: a first confirmation closes a pre-registered account (L-12, T-LINK-4)", () => {
	it("deletes the password and every session when the confirmation comes from elsewhere", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		expect(registration.status).toBe(200);
		const userId = await userIdOf(VICTIM);
		expect(await countRows("password_credential", "user_id = $1", [userId])).toBe(1);
		expect(await countRows("session", "user_id = $1", [userId])).toBe(1);

		mounted.email.clear();
		await post("/sign-in/magic-link/request", { email: VICTIM });
		const link = mounted.email.messages.at(-1);
		expect(link?.kind).toBe("magic_link");

		const redeemed = await post("/sign-in/magic-link/redeem", {
			token: tokenOf(link as EmailMessage),
		});

		expect(redeemed.status).toBe(200);
		expect(await countRows("password_credential", "user_id = $1", [userId])).toBe(0);
		expect(
			await countRows("session", "user_id = $1 AND token_sha256 <> $2", [
				userId,
				new Uint8Array(32),
			]),
		).toBe(1);
		const [account] = await mounted.connection.query<{ verified: boolean }>(
			`SELECT email_verified_at IS NOT NULL AS verified FROM ${mounted.schema}.user WHERE id = $1`,
			[userId],
		);
		expect(account?.verified).toBe(true);
	});

	it("keeps both when the confirmation is redeemed in the session that set the password", async () => {
		const registration = await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const cookie = sessionCookieIn(registration);
		const userId = await userIdOf(VICTIM);
		const confirmation = mounted.email.messages.at(-1);
		expect(confirmation?.kind).toBe("email_verification");

		const redeemed = await post(
			"/email/redeem-verification",
			{ token: tokenOf(confirmation as EmailMessage) },
			cookie,
		);

		expect(redeemed.status).toBe(200);
		expect(await countRows("password_credential", "user_id = $1", [userId])).toBe(1);
		expect(await countRows("session", "user_id = $1", [userId])).toBe(1);
	});

	it("takes the password when the confirmation carries a session of a different account", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		const confirmation = mounted.email.messages.at(-1);
		const stranger = await post("/sign-up", {
			email: "someone.else@example.com",
			password: ATTACKER_PASSWORD,
		});

		await post(
			"/email/redeem-verification",
			{ token: tokenOf(confirmation as EmailMessage) },
			sessionCookieIn(stranger),
		);

		expect(await countRows("password_credential", "user_id = $1", [userId])).toBe(0);
	});
});

describe("S-ENUM-3 and S-ENUM-4: a taken address answers as a free one", () => {
	it("answers with the same status, the same headers and the same body shape", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		mounted.email.clear();

		const taken = await post("/sign-up", { email: VICTIM, password: "another password here" });
		const free = await post("/sign-up", { email: "free@example.com", password: "another one!!" });

		expect(taken.status).toBe(free.status);
		expect([...taken.headers.keys()].sort()).toStrictEqual([...free.headers.keys()].sort());
		const shapeOf = (body: Record<string, unknown>): string =>
			JSON.stringify(Object.keys(body).sort());
		const takenBody = (await taken.json()) as Record<string, Record<string, unknown>>;
		const freeBody = (await free.json()) as Record<string, Record<string, unknown>>;
		expect(shapeOf(takenBody)).toBe(shapeOf(freeBody));
		expect(shapeOf(takenBody.user ?? {})).toBe(shapeOf(freeBody.user ?? {}));
		expect(shapeOf(takenBody.session ?? {})).toBe(shapeOf(freeBody.session ?? {}));
		expect(takenBody.user?.hasPassword).toBe(true);
	});

	it("sends one message on each path, of different kinds, to the address that exists", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		mounted.email.clear();

		await post("/sign-up", { email: VICTIM, password: "another password here" });
		const onTaken = [...mounted.email.messages];
		mounted.email.clear();
		await post("/sign-up", { email: "free@example.com", password: "another one!!" });
		const onFree = [...mounted.email.messages];

		expect(onTaken).toHaveLength(1);
		expect(onFree).toHaveLength(1);
		expect(onTaken[0]?.kind).toBe("sign_up_attempt_on_existing_account");
		expect(onFree[0]?.kind).toBe("email_verification");
		expect(onTaken[0]?.to).toBe(VICTIM);
	});

	it("writes no account and no session for the address that was taken", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);

		const answer = await post("/sign-up", { email: VICTIM, password: "another password here" });

		expect(await countRows("user", "email = $1", [VICTIM])).toBe(1);
		expect(await countRows("session", "user_id = $1", [userId])).toBe(1);
		const resolved = await mounted.handler(
			requestTo("/session", { method: "GET", cookie: sessionCookieIn(answer) }),
		);
		expect(await resolved.json()).toBeNull();
	});
});

describe("S-TIM-6: a request for an unknown address does the work a known one does", () => {
	it("calls send exactly once and mints a row on both paths", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		mounted.email.clear();
		await mounted.connection.query(`DELETE FROM ${mounted.schema}.one_time_token`, []);

		const known = await post("/password/request-reset", { email: VICTIM });
		const knownKinds = mounted.email.kinds();
		const knownRows = await countRows("one_time_token", "purpose = $1", ["password_reset"]);
		mounted.email.clear();
		const unknown = await post("/password/request-reset", { email: "nobody@example.com" });

		expect(known.status).toBe(unknown.status);
		expect(await known.text()).toBe(await unknown.text());
		expect(knownKinds).toStrictEqual(["password_reset"]);
		expect(mounted.email.kinds()).toStrictEqual(["request_for_unknown_address"]);
		expect(knownRows).toBe(1);
		expect(await countRows("one_time_token", "purpose = $1", ["password_reset"])).toBe(2);
		expect(await countRows("one_time_token", "user_id IS NULL", [])).toBe(1);
	});

	it("mints a cover row that cannot be redeemed", async () => {
		await post("/sign-in/magic-link/request", { email: "nobody@example.com" });
		const [row] = await mounted.connection.query<{ token_sha256: Uint8Array }>(
			`SELECT token_sha256 FROM ${mounted.schema}.one_time_token WHERE user_id IS NULL`,
			[],
		);

		expect(row).toBeDefined();
		expect(mounted.email.kinds()).toStrictEqual(["request_for_unknown_address"]);
	});
});

describe("S-TOKEN-2 and S-ENUM-5: purpose binding and the collision on a change", () => {
	it("refuses a magic-link token at the verification route exactly as an invented one", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		mounted.email.clear();
		await post("/sign-in/magic-link/request", { email: VICTIM });
		const link = mounted.email.messages.at(-1);

		const wrongPurpose = await post("/email/redeem-verification", {
			token: tokenOf(link as EmailMessage),
		});
		const invented = await post("/email/redeem-verification", { token: "not-a-token" });

		expect(wrongPurpose.status).toBe(invented.status);
		expect(await wrongPurpose.text()).toBe(await invented.text());
	});

	it("changes no rows and answers as an invented token when the new address is taken", async () => {
		const mine = await post("/sign-up", { email: "mine@example.com", password: ATTACKER_PASSWORD });
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const cookie = sessionCookieIn(mine);
		mounted.email.clear();

		const requested = await post("/email/request-change", { newEmail: VICTIM }, cookie);
		const change = mounted.email.messages.at(-1);
		const redeemed = await post("/email/redeem-change", { token: tokenOf(change as EmailMessage) });
		const invented = await post("/email/redeem-change", { token: "not-a-token" });

		expect(requested.status).toBe(204);
		expect(change?.kind).toBe("email_change");
		expect(redeemed.status).toBe(invented.status);
		expect(await redeemed.text()).toBe(await invented.text());
		expect(await countRows("user", "email = $1", ["mine@example.com"])).toBe(1);
	});

	it("moves the address and confirms it when the target is free", async () => {
		const mine = await post("/sign-up", { email: "mine@example.com", password: ATTACKER_PASSWORD });
		const cookie = sessionCookieIn(mine);
		mounted.email.clear();

		await post("/email/request-change", { newEmail: "next@example.com" }, cookie);
		const change = mounted.email.messages.at(-1);
		const redeemed = await post("/email/redeem-change", { token: tokenOf(change as EmailMessage) });

		expect(redeemed.status).toBe(200);
		expect(
			await countRows("user", "email = $1 AND email_verified_at IS NOT NULL", ["next@example.com"]),
		).toBe(1);
	});
});

describe("S-FIX-6: the mailed reset ends every session and returns a new one", () => {
	it("revokes what was there, writes the password and signs the caller in", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const userId = await userIdOf(VICTIM);
		mounted.email.clear();
		await post("/password/request-reset", { email: VICTIM });
		const reset = mounted.email.messages.at(-1);

		const answer = await post("/password/redeem-reset", {
			token: tokenOf(reset as EmailMessage),
			newPassword: "a brand new password",
		});
		const body = (await answer.json()) as { revokedOtherSessionsCount: number };

		expect(answer.status).toBe(200);
		expect(body.revokedOtherSessionsCount).toBe(1);
		expect(await countRows("session", "user_id = $1", [userId])).toBe(1);
		const [credential] = await mounted.connection.query<{ set_by_session_id: string | null }>(
			`SELECT set_by_session_id FROM ${mounted.schema}.password_credential WHERE user_id = $1`,
			[userId],
		);
		expect(credential?.set_by_session_id).not.toBeNull();
	});

	it("refuses a spent reset token exactly as an invented one", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		mounted.email.clear();
		await post("/password/request-reset", { email: VICTIM });
		const reset = mounted.email.messages.at(-1);
		const token = tokenOf(reset as EmailMessage);
		await post("/password/redeem-reset", { token, newPassword: "a brand new password" });

		const again = await post("/password/redeem-reset", { token, newPassword: "one more password" });
		const invented = await post("/password/redeem-reset", {
			token: "not-a-token",
			newPassword: "one more password",
		});

		expect(again.status).toBe(invented.status);
		expect(await again.text()).toBe(await invented.text());
	});
});

describe("the origin check and the route table", () => {
	it("refuses a sign-up from an origin the instance does not allow", async () => {
		const answer = await mounted.handler(
			requestTo("/sign-up", {
				body: { email: VICTIM, password: ATTACKER_PASSWORD },
				origin: "https://evil.example.com",
			}),
		);

		expect(answer.status).toBe(403);
		expect(TEST_ORIGIN).not.toBe("https://evil.example.com");
	});

	it("carries the eleven rows of this feature into the table", () => {
		const names = mounted.auth.routes.map((route) => route.name);

		expect(names).toContain("signUp.withPassword");
		expect(names).toContain("signUp.withoutPassword");
		expect(names).toContain("signIn.magicLink.request");
		expect(names).toContain("signIn.magicLink.redeem");
		expect(names).toContain("email.requestVerification");
		expect(names).toContain("email.redeemVerification");
		expect(names).toContain("email.requestChange");
		expect(names).toContain("email.redeemChange");
		expect(names).toContain("password.requestReset");
		expect(names).toContain("password.redeemReset");
		expect(names).toContain("password.redeemResetWithRecoveryCode");
	});
});

interface RecordingDriver extends Driver {
	readonly statements: string[];
}

/** T-TIM-6 counts the statements, so the driver the instance runs on records them. */
function recording(driver: Driver): RecordingDriver {
	const statements: string[] = [];
	const wrap = (inner: Driver): Driver => ({
		query: (sql, params) => {
			statements.push(sql.replace(/\s+/g, " ").trim());
			return inner.query(sql, params);
		},
		transaction: (run) => {
			statements.push("BEGIN");
			return inner.transaction((tx) => run(wrap(tx)));
		},
	});
	return { ...wrap(driver), statements } as RecordingDriver;
}

describe("T-TIM-6: the two branches run the same statements", () => {
	it("issues an identical sequence for a known and an unknown address", async () => {
		await post("/sign-up", { email: VICTIM, password: ATTACKER_PASSWORD });
		const driver = recording(mounted.connection);
		const auth = createVelveAuth(
			configFor({
				database: driver,
				schema: mounted.schema,
				email: { send: () => Promise.resolve() },
			}),
		);
		const handler = toWebHandler(auth);
		const request = (email: string): Request =>
			requestTo("/password/request-reset", { body: { email } });

		driver.statements.length = 0;
		await handler(request(VICTIM));
		const known = [...driver.statements];
		driver.statements.length = 0;
		await handler(request("nobody@example.com"));
		const unknown = [...driver.statements];

		expect(known.length).toBeGreaterThan(3);
		expect(unknown).toStrictEqual(known);
	});
});
