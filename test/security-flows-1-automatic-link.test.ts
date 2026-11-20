import { afterEach, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * FLOWS-1, the automatic link of S-LINK-2. The maintainer's ruling for this release: a provider
 * identity is attached to an existing account only from a signed-in session of that account, never
 * by the address, and a sign-in that would have needed one answers identity_link_required. Each
 * case below expects that ruling and fails while a trusted provider reporting the account's
 * verified address attaches its identity on its own.
 */

const VICTIM = "owner@example.com";
const PASSWORD = "the owner's long password";
const ATTACKER_SUBJECT = "subject-the-owner-never-linked";

interface Mounted {
	readonly auth: MountedAuth;
	readonly provider: StubProvider;
}

const mounted: MountedAuth[] = [];

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

async function mountTrusted(): Promise<Mounted> {
	const provider = await createStubProvider({
		claims: { sub: ATTACKER_SUBJECT, email: VICTIM, email_verified: true },
	});
	const auth = await mountAuth("secflowslink", {
		oauth: oauthConfigFor({ openIdConnect: false, trusted: true }),
		fetch: provider.fetch,
	});
	mounted.push(auth);
	return { auth, provider };
}

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error("the answer carried no session cookie");
}

//the owner signs up, and the address is confirmed as the owner would confirm it
async function verifiedOwner(mount: Mounted): Promise<{ userId: string; session: string }> {
	const answer = await mount.auth.handler(
		postTo("/sign-up", { email: VICTIM, password: PASSWORD }),
	);
	expect(answer.status).toBe(200);
	const session = sessionCookieOf(answer);
	const { user } = (await answer.json()) as { user: { id: string } };
	await mount.auth.connection.query(
		`UPDATE ${mount.auth.schema}.user SET email_verified_at = now() WHERE id = $1`,
		[user.id],
	);
	await mount.auth.reseal(user.id);
	return { userId: user.id, session };
}

async function enrolTotp(mount: Mounted, session: string): Promise<void> {
	const cookie = { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${session}` };
	const started = await mount.auth.handler(postTo("/factor/totp/enroll/start", {}, cookie));
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const code = totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(new Date()));
	const finished = await mount.auth.handler(postTo("/factor/totp/enroll/finish", { code }, cookie));
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
}

async function signInThroughTheProvider(mount: Mounted): Promise<Response> {
	const started = await mount.auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	const code = codeCarrying(url.searchParams.get("nonce"));
	return mount.auth.handler(
		requestTo(`/sign-in/oauth/callback/stubby?code=${code}&state=${encodeURIComponent(state)}`, {
			method: "GET",
			cookie: `__Host-velve_oauth_state=${body.stateCookie.value}`,
		}),
	);
}

async function identitiesOn(mount: Mounted, userId: string): Promise<number> {
	const [row] = await mount.auth.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${mount.auth.schema}.identity WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? 0;
}

async function pendingOn(mount: Mounted, userId: string): Promise<number> {
	const [row] = await mount.auth.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${mount.auth.schema}.pending_authentication WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? 0;
}

async function linkFromTheOwnersSession(mount: Mounted, session: string): Promise<Response> {
	const cookie = `${DEFAULT_COOKIE_NAMES.session}=${session}`;
	const started = await mount.auth.handler(
		requestTo("/identity/link/start", { body: { provider: "stubby" }, cookie }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	const code = codeCarrying(url.searchParams.get("nonce"));
	return mount.auth.handler(
		requestTo(`/sign-in/oauth/callback/stubby?code=${code}&state=${encodeURIComponent(state)}`, {
			method: "GET",
			cookie: `__Host-velve_oauth_state=${body.stateCookie.value}`,
		}),
	);
}

async function sessionsOn(mount: Mounted, userId: string): Promise<number> {
	const [row] = await mount.auth.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${mount.auth.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? 0;
}

describe("FLOWS: a provider identity never attaches to an existing account by its address", () => {
	it("leaves a verified account without the provider identity and without a new session", async () => {
		const mount = await mountTrusted();
		const owner = await verifiedOwner(mount);
		const sessionsBefore = await sessionsOn(mount, owner.userId);

		const answer = await signInThroughTheProvider(mount);

		expect(answer.status).toBe(409);
		expect(await answer.json()).toMatchObject({ error: { code: "identity_link_required" } });
		expect(await identitiesOn(mount, owner.userId)).toBe(0);
		expect(await sessionsOn(mount, owner.userId)).toBe(sessionsBefore);
	});

	it("does not attach the identity to an account with a second factor before or without that factor", async () => {
		const mount = await mountTrusted();
		const owner = await verifiedOwner(mount);
		await enrolTotp(mount, owner.session);

		const answer = await signInThroughTheProvider(mount);

		//the sign-in neither stops at the second factor nor leaves the identity behind
		expect(answer.status).toBe(409);
		expect(await answer.json()).toMatchObject({ error: { code: "identity_link_required" } });
		expect(await identitiesOn(mount, owner.userId)).toBe(0);
		expect(await pendingOn(mount, owner.userId)).toBe(0);
	});

	it("does not attach the identity or issue a session while the account has turned recovery off", async () => {
		const mount = await mountTrusted();
		const owner = await verifiedOwner(mount);
		await mount.auth.auth.user.disableRecovery({ userId: owner.userId });
		const sessionsBefore = await sessionsOn(mount, owner.userId);

		await signInThroughTheProvider(mount);

		expect(await identitiesOn(mount, owner.userId)).toBe(0);
		expect(await sessionsOn(mount, owner.userId)).toBe(sessionsBefore);
	});

	it("answers the same for an address the provider does not report verified", async () => {
		const mount = await mountTrusted();
		const owner = await verifiedOwner(mount);
		mount.provider.reportClaims({ sub: ATTACKER_SUBJECT, email: VICTIM, email_verified: false });

		const answer = await signInThroughTheProvider(mount);

		expect(answer.status).toBe(409);
		expect(await answer.json()).toMatchObject({ error: { code: "identity_link_required" } });
		expect(await identitiesOn(mount, owner.userId)).toBe(0);
	});

	it("still links the identity when the owner starts the link from a signed-in session", async () => {
		const mount = await mountTrusted();
		const owner = await verifiedOwner(mount);

		const linked = await linkFromTheOwnersSession(mount, owner.session);
		const signedIn = await signInThroughTheProvider(mount);

		expect(linked.status).toBe(302);
		expect(await identitiesOn(mount, owner.userId)).toBe(1);
		expect(signedIn.status).toBe(302);
		expect(sessionCookieOf(signedIn)).not.toBe("");
	});
});
