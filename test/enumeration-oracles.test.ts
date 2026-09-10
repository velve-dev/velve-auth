import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuthInMode, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

const WEBAUTHN = {
	relyingPartyId: "app.example.com",
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

const USERNAME_RULES = { minimumLength: 3, maximumLength: 32 } as const;

/**
 * T-ENUM-7's allow-list. Every route the `email` mode serves is judged here for one thing only:
 * whether its answer differs according to whether an address exists. The list must equal the
 * mounted table exactly, so a row added to 3.15 D.3 cannot join the surface without being judged —
 * which is what a set-equality against D.3 alone cannot do.
 */
const ANSWER_DEPENDS_ON_WHETHER_AN_ADDRESS_EXISTS: ReadonlyMap<string, boolean> = new Map([
	["email.redeemChange", false],
	["email.redeemVerification", false],
	["email.requestChange", false],
	["email.requestVerification", false],
	["factor.recovery.generate", false],
	["factor.recovery.remaining", false],
	["factor.recovery.verify", false],
	["factor.totp.enroll.finish", false],
	["factor.totp.enroll.start", false],
	["factor.totp.remove", false],
	["factor.totp.verify", false],
	["factor.webauthn.authenticate.finish", false],
	["factor.webauthn.authenticate.start", false],
	["factor.webauthn.list", false],
	["factor.webauthn.register.finish", false],
	["factor.webauthn.register.start", false],
	["factor.webauthn.remove", false],
	["factor.webauthn.rename", false],
	["identity.link.start", false],
	["identity.list", false],
	["identity.unlink", false],
	["password.change", false],
	["password.redeemReset", false],
	["password.redeemResetWithRecoveryCode", false],
	["password.requestReset", false],
	["password.set", false],
	["pending.cancel", false],
	["pending.read", false],
	["session.list", false],
	["session.read", false],
	["session.refresh", false],
	["session.revoke", false],
	["session.revokeAll", false],
	["session.revokeAllOther", false],
	["signIn.magicLink.redeem", false],
	["signIn.magicLink.request", false],
	["signIn.oauth.callback", false],
	["signIn.oauth.callbackFormPost", false],
	["signIn.oauth.start", false],
	["signIn.passkey.finish", false],
	["signIn.passkey.start", false],
	["signIn.password", false],
	["signOut", false],
	["signUp.withPassword", false],
	["signUp.withoutPassword", false],
]);

let addressesOnly: MountedAuth<"email">;
let withUsernames: MountedAuth<"username_email">;
/** The bucket is a row in the schema, so the eleventh request needs a schema nothing else spends. */
let untouchedBucket: MountedAuth<"username_email">;

beforeAll(async () => {
	addressesOnly = await mountAuthInMode<"email">(
		"enumoracleemail",
		{ mode: "email" },
		{ recoveryCodes: { count: 10, groupSize: 5 }, webauthn: WEBAUTHN },
	);
	untouchedBucket = await mountAuthInMode<"username_email">(
		"enumoraclebucket",
		{ mode: "username_email", username: USERNAME_RULES },
		{
			recoveryCodes: { count: 10, groupSize: 5 },
			webauthn: WEBAUTHN,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		},
	);
	withUsernames = await mountAuthInMode<"username_email">(
		"enumoracleusername",
		{ mode: "username_email", username: USERNAME_RULES },
		{
			recoveryCodes: { count: 10, groupSize: 5 },
			webauthn: WEBAUTHN,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		},
	);
});

afterAll(async () => {
	for (const mount of [addressesOnly, withUsernames, untouchedBucket]) {
		await dropSchema(mount.connection, mount.schema);
		await mount.connection.close();
	}
});

describe("T-ENUM-7: nothing in the email mode answers whether an address exists (S-ENUM-7)", () => {
	it("judges every route the mode serves, and no route it does not", () => {
		const served = addressesOnly.auth.routes.map((route) => route.name).sort();

		expect(served).toEqual([...ANSWER_DEPENDS_ON_WHETHER_AN_ADDRESS_EXISTS.keys()].sort());
	});

	it("finds none whose answer depends on it", () => {
		const oracles = [...ANSWER_DEPENDS_ON_WHETHER_AN_ADDRESS_EXISTS]
			.filter(([, depends]) => depends)
			.map(([name]) => name);

		expect(oracles).toEqual([]);
	});

	/**
	 * The one endpoint in the library that does answer existence as a boolean answers it for
	 * usernames, and 3.4 admits it. It must not be reachable where the identifier is an address.
	 */
	it("serves the username availability row where usernames exist and not where they do not", () => {
		const namesIn = (mount: { auth: { routes: readonly { name: string }[] } }): string[] =>
			mount.auth.routes.map((route) => route.name);

		expect(namesIn(withUsernames)).toContain("username.isAvailable");
		expect(namesIn(addressesOnly)).not.toContain("username.isAvailable");
	});

	it("answers 404 to the availability path in the email mode", async () => {
		const answer = await addressesOnly.handler(
			requestTo("/username/available?username=someone", { method: "GET" }),
		);

		expect(answer.status).toBe(404);
	});
});

describe("T-ENUM-8: what the username availability row gives away (S-ENUM-8)", () => {
	function ask(mount: MountedAuth<"username_email">, username: string): Promise<Response> {
		return mount.handler(
			requestTo(`/username/available?username=${encodeURIComponent(username)}`, { method: "GET" }),
		);
	}

	it("answers with the two fields the row allows and no others, taken names included", async () => {
		const taken = await withUsernames.handler(
			postTo("/sign-up", {
				email: "taken@example.com",
				username: "taken-name",
				password: "correct-horse-battery-staple",
			}),
		);
		const free = (await (await ask(withUsernames, "brand-new-name")).json()) as Record<
			string,
			unknown
		>;
		const spoken = (await (await ask(withUsernames, "taken-name")).json()) as Record<
			string,
			unknown
		>;
		const refused = (await (await ask(withUsernames, "*")).json()) as Record<string, unknown>;

		expect(taken.status).toBe(200);
		expect(free).toEqual({ available: true });
		expect(spoken).toEqual({ available: false, reason: "taken" });
		expect(Object.keys(refused).sort()).toEqual(["available", "reason"]);
	});

	it("refuses a prefix wildcard by its characters and returns no list of near matches", async () => {
		for (const wildcard of ["*", "%", "ali*", "ali%"]) {
			const body = (await (await ask(withUsernames, wildcard)).json()) as Record<string, unknown>;

			expect([wildcard, body]).toEqual([
				wildcard,
				{ available: false, reason: "invalid_characters" },
			]);
		}
	});

	it("declares a bucket of its own rather than the configured one", () => {
		const route = withUsernames.auth.routes.find((entry) => entry.name === "username.isAvailable");

		expect(route?.rateLimit).toEqual({
			perIpAddress: { capacity: 10, refillPerSecond: 10 / 60 },
			perAccount: "none",
		});
	});

	/**
	 * The bucket above is a declaration; this is the eleventh request. The mount widens every other
	 * bucket to a hundred thousand, so a refusal here is this row's own and not the shared one, and
	 * it is a mount of its own because `trustedProxies` is empty — every request in this file
	 * arrives from the same unknown address and spends the same row (S-RATE-3).
	 */
	it("refuses the eleventh request within the minute", async () => {
		const outcomes: string[] = [];
		for (let attempt = 1; attempt <= 11; attempt += 1) {
			const answer = await ask(untouchedBucket, `candidate-${attempt}`);
			outcomes.push(
				answer.status === 200
					? "available"
					: (((await answer.json()) as { error?: { code?: string } }).error?.code ?? "unknown"),
			);
		}

		expect(outcomes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => "available"));
		expect(outcomes[10]).toBe("rate_limited");
	});
});
