import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo as request } from "./flows-fixtures.js";

let mounted: MountedAuth;

afterEach(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

const TAKEN = "taken.address@example.com";
const FREE = "free..address@example.com";
const PASSWORD = "correct horse battery staple";
const BROWSER =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0";

describe("S-ENUM-3: POST /sign-up answers a taken address as it answers a free one", () => {
	beforeEach(async () => {
		mounted = await mountAuth("enumreview");
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
	});

	it("differs in no byte of status, header set or body", async () => {
		const taken = await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
		const free = await mounted.handler(request("/sign-up", { email: FREE, password: PASSWORD }));

		expect(TAKEN).toHaveLength(FREE.length);
		expect(await difference(taken, free)).toStrictEqual([]);
	});

	it("differs in no byte on the passwordless row either", async () => {
		const taken = await mounted.handler(request("/sign-up/passwordless", { email: TAKEN }));
		const free = await mounted.handler(request("/sign-up/passwordless", { email: FREE }));

		expect(await difference(taken, free)).toStrictEqual([]);
	});
});

describe("S-ENUM-3: the cover is built from the settings the instance runs under", () => {
	it("keeps the two answers identical when the account carries no request metadata", async () => {
		mounted = await mountAuth("enumnone", { sessionMetadata: "none" });
		const header = { "User-Agent": BROWSER };
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }, header));

		const taken = await mounted.handler(
			request("/sign-up", { email: TAKEN, password: PASSWORD }, header),
		);
		const free = await mounted.handler(
			request("/sign-up", { email: FREE, password: PASSWORD }, header),
		);

		expect(await difference(taken, free)).toStrictEqual([]);
	});

	it("keeps the two answers identical when the account carries the full metadata", async () => {
		mounted = await mountAuth("enumfull", { sessionMetadata: "full" });
		const header = { "User-Agent": BROWSER };
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }, header));

		const taken = await mounted.handler(
			request("/sign-up", { email: TAKEN, password: PASSWORD }, header),
		);
		const free = await mounted.handler(
			request("/sign-up", { email: FREE, password: PASSWORD }, header),
		);

		expect(await difference(taken, free)).toStrictEqual([]);
	});
});

describe("S-ENUM-3: how many requests the cover survives", () => {
	beforeEach(async () => {
		mounted = await mountAuth("enumcover");
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
	});

	/**
	 * S-ENUM-3 speaks about one response, and the cover meets it once the two faults above are gone.
	 * What it does not survive is the caller's next request: the cover's token names no row. This
	 * pins the count rather than asserting the property, because the count is what is open — the day
	 * it becomes one the cover has broken, and the day it becomes three somebody closed the gap
	 * E-602 declares (S-ENUM-3, 3.13).
	 */
	it("needs a second request, and no more than a second, to tell the two apart", async () => {
		const cookieOf = (answer: Response): string =>
			`__Host-velve_session=${/__Host-velve_session=([^;]*)/.exec(answer.headers.get("Set-Cookie") ?? "")?.[1] ?? ""}`;
		const taken = await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
		const free = await mounted.handler(request("/sign-up", { email: FREE, password: PASSWORD }));
		const resolve = async (answer: Response): Promise<unknown> =>
			(
				await mounted.handler(
					new Request("https://api.example.com/session", {
						method: "GET",
						headers: { Origin: TEST_ORIGIN, Cookie: cookieOf(answer) },
					}),
				)
			).json();

		expect(await resolve(taken)).toBeNull();
		expect(await resolve(free)).not.toBeNull();
	});
});

describe("S-ENUM-4: the side effect is symmetric and the message is not", () => {
	beforeEach(async () => {
		mounted = await mountAuth("enummail");
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
	});

	it("sends exactly one message on each path, of different kinds, to the address that exists", async () => {
		mounted.email.clear();
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
		const onTaken = [...mounted.email.messages];
		mounted.email.clear();
		await mounted.handler(request("/sign-up", { email: FREE, password: PASSWORD }));
		const onFree = [...mounted.email.messages];

		expect(onTaken).toHaveLength(1);
		expect(onFree).toHaveLength(1);
		expect(onTaken[0]?.kind).not.toBe(onFree[0]?.kind);
		expect(onTaken[0]?.to).toBe(TAKEN);
	});

	/**
	 * S-ENUM-4 asks for "a sign-in link instead of a confirmation link" and A.7 gives the kind for
	 * that row no token, because the library builds no URL on either path — a confirmation link is
	 * the application's too. The sign-in link is therefore a link to the application's sign-in page,
	 * and the emptiness is pinned here so that nobody later mints a magic link for a requester who
	 * has proved nothing about the address.
	 */
	it("sends that message without a token, and mints no artefact for it", async () => {
		mounted.email.clear();
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
		const [message] = mounted.email.messages as readonly EmailMessage[];
		const [row] = await mounted.connection.query<{ total: number }>(
			`SELECT count(*)::int AS total FROM ${mounted.schema}.one_time_token WHERE purpose = 'magic_link'`,
			[],
		);

		expect(message?.kind).toBe("sign_up_attempt_on_existing_account");
		expect(message === undefined ? { token: "" } : message).not.toHaveProperty("token");
		expect(row?.total).toBe(0);
	});
});

describe("S-ENUM-5: the two requesting routes and the collision on a change", () => {
	beforeEach(async () => {
		mounted = await mountAuth("enumfive");
		await mounted.handler(request("/sign-up", { email: TAKEN, password: PASSWORD }));
	});

	it("answers /password/request-reset alike for a known and an unknown address", async () => {
		const known = await mounted.handler(request("/password/request-reset", { email: TAKEN }));
		const unknown = await mounted.handler(request("/password/request-reset", { email: FREE }));

		expect(await difference(known, unknown)).toStrictEqual([]);
	});

	it("answers /email/request-change alike for a taken and a free target", async () => {
		const mine = await mounted.handler(
			request("/sign-up", { email: "mine@example.com", password: PASSWORD }),
		);
		const cookie = {
			Cookie: `__Host-velve_session=${/__Host-velve_session=([^;]*)/.exec(mine.headers.get("Set-Cookie") ?? "")?.[1] ?? ""}`,
		};

		const collides = await mounted.handler(
			request("/email/request-change", { newEmail: TAKEN }, cookie),
		);
		const free = await mounted.handler(
			request("/email/request-change", { newEmail: FREE }, cookie),
		);

		expect(await difference(collides, free)).toStrictEqual([]);
	});

	it("changes no row and answers as an invented token when the change collides", async () => {
		const mine = await mounted.handler(
			request("/sign-up", { email: "mine@example.com", password: PASSWORD }),
		);
		const cookie = {
			Cookie: `__Host-velve_session=${/__Host-velve_session=([^;]*)/.exec(mine.headers.get("Set-Cookie") ?? "")?.[1] ?? ""}`,
		};
		mounted.email.clear();
		await mounted.handler(request("/email/request-change", { newEmail: TAKEN }, cookie));
		const message = mounted.email.messages.at(-1);
		const token = message !== undefined && "token" in message ? message.token : "";

		const before = await mounted.connection.query(
			`SELECT id, email, email_verified_at, updated_at FROM ${mounted.schema}.user ORDER BY id`,
			[],
		);
		const redeemed = await mounted.handler(request("/email/redeem-change", { token }));
		const invented = await mounted.handler(request("/email/redeem-change", { token: "nope" }));
		const after = await mounted.connection.query(
			`SELECT id, email, email_verified_at, updated_at FROM ${mounted.schema}.user ORDER BY id`,
			[],
		);

		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
		expect(await difference(redeemed, invented)).toStrictEqual([]);
	});
});
