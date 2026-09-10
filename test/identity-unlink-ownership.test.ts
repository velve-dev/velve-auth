import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";

const PASSWORD = "correct-horse-battery-staple";
const INVENTED_IDENTITY = "00000000-0000-4000-8000-000000000000";

interface Account {
	readonly userId: string;
	readonly cookie: string;
	readonly identityId: string;
}

let mounted: MountedAuth;
let owner: Account;
let stranger: Account;

async function signUp(email: string): Promise<{ userId: string; cookie: string }> {
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	const body = (await answer.json()) as { user: { id: string } };
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return {
				userId: body.user.id,
				cookie: `${DEFAULT_COOKIE_NAMES.session}=${pair.slice(separator + 1)}`,
			};
		}
	}
	throw new Error("the sign-up issued no session cookie");
}

/**
 * The row is written directly because S-OWNER-5 is about the delete predicate, and driving two
 * complete provider flows to reach it would put the linking rule of 5.11 in front of the subject.
 */
async function linkAnIdentity(userId: string, subject: string): Promise<string> {
	const [row] = await mounted.connection.query<{ id: string }>(
		`INSERT INTO ${mounted.schema}.identity (user_id, provider, subject)
		 VALUES ($1, 'stubby', $2) RETURNING id`,
		[userId, subject],
	);
	return row?.id ?? "";
}

async function accountWith(email: string, subject: string): Promise<Account> {
	const { userId, cookie } = await signUp(email);
	return { userId, cookie, identityId: await linkAnIdentity(userId, subject) };
}

async function unlink(account: Account, identityId: string): Promise<Response> {
	return mounted.handler(
		requestTo("/identity/unlink", { body: { identityId }, cookie: account.cookie }),
	);
}

async function identityIds(): Promise<string[]> {
	const rows = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.identity ORDER BY id`,
		[],
	);
	return rows.map((row) => row.id);
}

beforeAll(async () => {
	mounted = await mountAuth("identityunlinkownership", {
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
	owner = await accountWith("owner@example.com", "owner-subject");
	stranger = await accountWith("stranger@example.com", "stranger-subject");
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("T-OWNER-5: unlinking reaches only the caller's own identity rows (S-OWNER-5)", () => {
	it("changes no row when the stranger names the owner's identity", async () => {
		const before = await identityIds();

		const answer = await unlink(stranger, owner.identityId);

		expect(answer.status).toBe(204);
		expect(await identityIds()).toEqual(before);
	});

	/** S-OWNER-8: the two cases must not be distinguishable, or the refusal is an existence oracle. */
	it("answers a foreign identity exactly as it answers an invented one", async () => {
		const foreign = await unlink(stranger, owner.identityId);
		const invented = await unlink(stranger, INVENTED_IDENTITY);

		expect(await difference(foreign, invented)).toEqual([]);
	});

	/**
	 * Without this the two assertions above hold for a route that deletes nothing at all, which is
	 * the reading of the requirement that costs nothing to satisfy and means nothing.
	 */
	it("removes the caller's own identity, so the refusals above are the owner predicate", async () => {
		const before = await identityIds();

		const answer = await unlink(stranger, stranger.identityId);
		const after = await identityIds();

		expect(answer.status).toBe(204);
		expect(after).toEqual(before.filter((id) => id !== stranger.identityId));
		expect(after).toContain(owner.identityId);
	});
});
