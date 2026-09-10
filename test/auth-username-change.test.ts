import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuthInMode, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

let mounted: MountedAuth<"username_email">;

const PASSWORD = "correct-horse-battery-staple";

const USERNAME_RULES = {
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: ["admin"],
};

beforeAll(async () => {
	mounted = await mountAuthInMode<"username_email">(
		"usernamechange",
		{ mode: "username_email", username: USERNAME_RULES },
		{
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		},
	);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function sessionOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error("the answer carried no session cookie");
}

let accounts = 0;

async function signUp(username: string): Promise<string> {
	accounts += 1;
	const answer = await mounted.handler(
		postTo("/sign-up", { email: `name${accounts}@example.com`, username, password: PASSWORD }),
	);
	if (answer.status !== 200) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return sessionOf(answer);
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

interface ChangeAnswer {
	readonly status: number;
	readonly body: { user?: { username: string }; error?: { code: string } };
}

async function change(sessionToken: string, newUsername: string): Promise<ChangeAnswer> {
	const answer = await mounted.handler(
		postTo("/username/change", { newUsername }, withSession(sessionToken)),
	);
	return { status: answer.status, body: (await answer.json()) as ChangeAnswer["body"] };
}

/** 3.15 B.5 and D.3's `POST /username/change`, which was the seventeenth row (E-1246). */
describe("changing a username from a fresh session", () => {
	it("answers the account as it now stands", async () => {
		const session = await signUp("firstname");
		const changed = await change(session, "secondname");

		expect(changed.status).toBe(200);
		expect(changed.body.user?.username).toBe("secondname");
	});

	it("resolves a sign-in through the new name and no longer through the old one", async () => {
		const session = await signUp("beforethechange");
		await change(session, "afterthechange");

		const byNewName = await mounted.handler(
			postTo("/sign-in/password", { emailOrUsername: "afterthechange", password: PASSWORD }),
		);
		const byOldName = await mounted.handler(
			postTo("/sign-in/password", { emailOrUsername: "beforethechange", password: PASSWORD }),
		);
		const refusal = (await byOldName.json()) as { error: { code: string } };

		expect(byNewName.status).toBe(200);
		expect(`${byOldName.status} ${refusal.error.code}`).toBe("401 invalid_credentials");
	});

	/**
	 * The name that is written and the name a sign-in is later resolved through come from the one
	 * normalisation in `core/identity`, so a spelling that folds onto a taken name is refused by
	 * the unique index rather than accepted as a second row (S-RATE-7's neighbouring hazard).
	 */
	it("refuses a name that is taken, in whatever case it is spelled", async () => {
		await signUp("occupied");
		const session = await signUp("hopeful");

		expect((await change(session, "occupied")).status).toBe(409);
		expect((await change(session, "OCCUPIED")).body.error?.code).toBe("username_taken");
	});

	it("refuses a name the rules reject, without asking the database", async () => {
		const session = await signUp("wellformed");

		expect((await change(session, "no")).body.error?.code).toBe("username_invalid");
		expect((await change(session, "admin")).body.error?.code).toBe("username_invalid");
		expect((await change(session, "not a username")).body.error?.code).toBe("username_invalid");
	});

	it("refuses a caller with no session at all", async () => {
		const answer = await mounted.handler(postTo("/username/change", { newUsername: "anything" }));
		const refusal = (await answer.json()) as { error: { code: string } };

		expect(`${answer.status} ${refusal.error.code}`).toBe("401 session_required");
	});

	/** S-CSRF-1: nothing this branch mounts joins the two routes that may skip the origin check. */
	it("refuses a foreign origin", async () => {
		const session = await signUp("origintest");
		const answer = await mounted.handler(
			new Request("https://api.example.com/username/change", {
				method: "POST",
				headers: {
					Origin: "https://evil.example.com",
					"Content-Type": "application/json",
					...withSession(session),
				},
				body: JSON.stringify({ newUsername: "somethingelse" }),
			}),
		);
		const refusal = (await answer.json()) as { error: { code: string } };

		expect(TEST_ORIGIN).not.toBe("https://evil.example.com");
		expect(`${answer.status} ${refusal.error.code}`).toBe("403 origin_not_allowed");
	});
});
