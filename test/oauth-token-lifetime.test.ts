import { afterEach, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";

/**
 * The provider's `expires_in` becomes `token_expires_at` when the application stores tokens. A
 * lifetime outside one second to one year is stored as no lifetime, so a huge one cannot write a
 * deadline that decodes to an Invalid Date and a negative one cannot write a past instant (E-2875).
 */

const ONE_YEAR_IN_SECONDS = 365 * 86_400;
const mounted: MountedAuth[] = [];

afterEach(async () => {
	for (const each of mounted.splice(0)) {
		await dropSchema(each.connection, each.schema);
		await each.connection.close();
	}
});

interface Stored {
	readonly status: number;
	readonly secondsFromNow: number | null;
}

async function signInReporting(expiresInSeconds: number): Promise<Stored> {
	const provider = await createStubProvider({
		claims: { sub: "lifetime-subject", email: "lifetime@example.com", email_verified: true },
		expiresInSeconds,
	});
	const auth = await mountAuth("oauthlifetime", {
		oauth: oauthConfigFor({ openIdConnect: false, storeTokens: true }),
		fetch: provider.fetch,
	});
	mounted.push(auth);

	const started = await auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	const answered = await auth.handler(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
	const [row] = await auth.connection.query<{ seconds: string | null }>(
		`SELECT round(extract(epoch FROM token_expires_at - now()))::float8 AS seconds
		 FROM ${auth.schema}.identity`,
		[],
	);
	const seconds = row?.seconds ?? null;
	return { status: answered.status, secondsFromNow: seconds === null ? null : Number(seconds) };
}

describe("the lifetime a provider states for its tokens", () => {
	it("stores an ordinary lifetime", async () => {
		const stored = await signInReporting(3600);

		expect(stored.status).toBe(302);
		expect(stored.secondsFromNow).toBeGreaterThan(3590);
		expect(stored.secondsFromNow).toBeLessThanOrEqual(3600);
	});

	it("stores a lifetime of exactly one year", async () => {
		const stored = await signInReporting(ONE_YEAR_IN_SECONDS);

		expect(stored.secondsFromNow).toBeGreaterThan(ONE_YEAR_IN_SECONDS - 10);
	});

	it.each([
		["one second past a year", ONE_YEAR_IN_SECONDS + 1],
		["one that would end past the range a Date holds", 600_000_000_000_000],
		["zero", 0],
		["a negative one", -60],
	])("stores no lifetime for %s and still signs the caller in", async (_, expiresInSeconds) => {
		const stored = await signInReporting(expiresInSeconds);

		expect(stored.status).toBe(302);
		expect(stored.secondsFromNow).toBeNull();
	});
});
