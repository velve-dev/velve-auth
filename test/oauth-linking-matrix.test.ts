import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	CALLBACK_BASE_URL,
	codeCarrying,
	createStubProvider,
	type ProviderClaims,
	type StubProvider,
} from "./oauth-provider.js";

const PROVIDER_ORIGIN = "https://provider.example";

interface Mounted {
	readonly auth: MountedAuth;
	readonly provider: StubProvider;
}

const mounted: MountedAuth[] = [];

function stubEndpoints(): Record<string, unknown> {
	return {
		clientId: "velve-test-client",
		clientSecret: "client-secret",
		authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
		tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
		userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
	};
}

function configWith(input: {
	readonly providerIds: readonly string[];
	readonly trusted: readonly string[];
}): OAuthConfig {
	const providers: Record<string, unknown> = {};
	for (const id of input.providerIds) {
		providers[id] = stubEndpoints();
	}
	return {
		providers,
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: input.trusted,
	} as unknown as OAuthConfig;
}

async function mountWith(input: {
	readonly providerIds: readonly string[];
	readonly trusted: readonly string[];
	readonly claims: ProviderClaims;
}): Promise<Mounted> {
	const provider = await createStubProvider({ claims: input.claims });
	const auth = await mountAuth("oauthlink", {
		oauth: configWith({ providerIds: input.providerIds, trusted: input.trusted }),
		fetch: provider.fetch,
	});
	mounted.push(auth);
	return { auth, provider };
}

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

async function signInThrough(mount: Mounted, providerId: string): Promise<Response> {
	const started = await mount.auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: providerId } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	const code = codeCarrying(url.searchParams.get("nonce"));
	return mount.auth.handler(
		requestTo(
			`/sign-in/oauth/callback/${providerId}?code=${code}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
}

async function rowsOf<T>(mount: Mounted, sql: string, values: readonly unknown[]): Promise<T[]> {
	return mount.auth.connection.query<T>(sql.replaceAll("$schema", mount.auth.schema), values);
}

/* ------------------------------------------------------------------ *
 * T-LINK-2: three local states x two provider states x two trust
 * states. The expectation table is the fixture and it is written out
 * in full rather than derived, so a rule that moves has to move it.
 * ------------------------------------------------------------------ */

type LocalState = "absent" | "unverified" | "verified";
type LinkOutcome = "new_account" | "linked" | "refused";

interface MatrixCase {
	readonly localAccount: LocalState;
	readonly providerReportsVerified: boolean;
	readonly providerIsTrusted: boolean;
	readonly expected: LinkOutcome;
}

/**
 * S-LINK-2: an automatic link needs all three conditions. Only the last row has all three, and the
 * row this matrix exists for is `unverified / true / true` — the shape of CVE-2026-53516.
 */
const T_LINK_2_EXPECTATIONS: readonly MatrixCase[] = [
	{
		localAccount: "absent",
		providerReportsVerified: false,
		providerIsTrusted: false,
		expected: "new_account",
	},
	{
		localAccount: "absent",
		providerReportsVerified: false,
		providerIsTrusted: true,
		expected: "new_account",
	},
	{
		localAccount: "absent",
		providerReportsVerified: true,
		providerIsTrusted: false,
		expected: "new_account",
	},
	{
		localAccount: "absent",
		providerReportsVerified: true,
		providerIsTrusted: true,
		expected: "new_account",
	},
	{
		localAccount: "unverified",
		providerReportsVerified: false,
		providerIsTrusted: false,
		expected: "refused",
	},
	{
		localAccount: "unverified",
		providerReportsVerified: false,
		providerIsTrusted: true,
		expected: "refused",
	},
	{
		localAccount: "unverified",
		providerReportsVerified: true,
		providerIsTrusted: false,
		expected: "refused",
	},
	{
		localAccount: "unverified",
		providerReportsVerified: true,
		providerIsTrusted: true,
		expected: "refused",
	},
	{
		localAccount: "verified",
		providerReportsVerified: false,
		providerIsTrusted: false,
		expected: "refused",
	},
	{
		localAccount: "verified",
		providerReportsVerified: false,
		providerIsTrusted: true,
		expected: "refused",
	},
	{
		localAccount: "verified",
		providerReportsVerified: true,
		providerIsTrusted: false,
		expected: "refused",
	},
	{
		localAccount: "verified",
		providerReportsVerified: true,
		providerIsTrusted: true,
		expected: "linked",
	},
];

function addressFor(matrixCase: MatrixCase): string {
	return `${matrixCase.localAccount}.${matrixCase.providerReportsVerified}.${matrixCase.providerIsTrusted}@example.com`;
}

async function seedLocalAccount(mount: Mounted, matrixCase: MatrixCase): Promise<string | null> {
	if (matrixCase.localAccount === "absent") {
		return null;
	}
	const verified = matrixCase.localAccount === "verified" ? "now()" : "NULL";
	const [row] = await rowsOf<{ id: string }>(
		mount,
		`INSERT INTO $schema.user (email, email_verified_at) VALUES ($1, ${verified}) RETURNING id`,
		[addressFor(matrixCase)],
	);
	return row?.id ?? null;
}

async function runMatrixCase(mount: Mounted, matrixCase: MatrixCase): Promise<LinkOutcome> {
	const subject = `subject-${addressFor(matrixCase)}`;
	const seeded = await seedLocalAccount(mount, matrixCase);
	mount.provider.reportClaims({
		sub: subject,
		email: addressFor(matrixCase),
		email_verified: matrixCase.providerReportsVerified,
	});

	const answer = await signInThrough(mount, "stubby");
	if (answer.status !== 302) {
		return "refused";
	}
	const [identity] = await rowsOf<{ user_id: string }>(
		mount,
		"SELECT user_id FROM $schema.identity WHERE subject = $1",
		[subject],
	);
	return identity !== undefined && identity.user_id === seeded ? "linked" : "new_account";
}

describe("T-LINK-2: the twelve-case state matrix (S-LINK-2)", () => {
	it("declares three local states, two provider states and two trust states", () => {
		const localStates = new Set(T_LINK_2_EXPECTATIONS.map((one) => one.localAccount));
		const keys = T_LINK_2_EXPECTATIONS.map(
			(one) => `${one.localAccount}/${one.providerReportsVerified}/${one.providerIsTrusted}`,
		);

		expect(T_LINK_2_EXPECTATIONS).toHaveLength(12);
		expect(localStates.size).toBe(3);
		expect(new Set(keys).size).toBe(12);
		expect(T_LINK_2_EXPECTATIONS.filter((one) => one.expected === "linked")).toHaveLength(1);
	});

	it("runs all twelve against the flow and matches the expectation table", async () => {
		const observed: string[] = [];
		const expected: string[] = [];

		for (const trusted of [false, true]) {
			const mount = await mountWith({
				providerIds: ["stubby"],
				trusted: trusted ? ["stubby"] : [],
				claims: { sub: "unused" },
			});
			for (const matrixCase of T_LINK_2_EXPECTATIONS.filter(
				(one) => one.providerIsTrusted === trusted,
			)) {
				const key = `${matrixCase.localAccount}/${matrixCase.providerReportsVerified}/${matrixCase.providerIsTrusted}`;
				observed.push(`${key} -> ${await runMatrixCase(mount, matrixCase)}`);
				expected.push(`${key} -> ${matrixCase.expected}`);
			}
		}

		expect(observed).toHaveLength(12);
		expect(observed).toStrictEqual(expected);
	});

	it("does not silently link an unverified local account to a trusted, verified provider", async () => {
		const mount = await mountWith({
			providerIds: ["stubby"],
			trusted: ["stubby"],
			claims: { sub: "unused" },
		});
		const singled: MatrixCase = {
			localAccount: "unverified",
			providerReportsVerified: true,
			providerIsTrusted: true,
			expected: "refused",
		};

		const outcome = await runMatrixCase(mount, singled);
		const identities = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.identity", []);
		const sessions = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.session", []);

		expect(outcome).toBe("refused");
		expect(identities).toHaveLength(0);
		expect(sessions).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------ *
 * T-LINK-1: the pair is the key, and the address is not.
 * ------------------------------------------------------------------ */

describe("T-LINK-1: two providers reporting one address (S-LINK-1)", () => {
	it("does not join them on the strength of the address alone", async () => {
		const mount = await mountWith({
			providerIds: ["stubby", "stubbier"],
			trusted: [],
			claims: { sub: "first-subject", email: "shared@example.com", email_verified: true },
		});

		const first = await signInThrough(mount, "stubby");
		mount.provider.reportClaims({
			sub: "second-subject",
			email: "shared@example.com",
			email_verified: true,
		});
		const second = await signInThrough(mount, "stubbier");

		const identities = await rowsOf<{ provider: string; user_id: string }>(
			mount,
			"SELECT provider, user_id FROM $schema.identity ORDER BY provider",
			[],
		);

		expect(first.status).toBe(302);
		expect(second.status).not.toBe(302);
		expect(identities.map((one) => one.provider)).toStrictEqual(["stubby"]);
	});

	it("reaches an identity by the pair and by nothing else", () => {
		const repository = readFileSync(
			join(process.cwd(), "src/core/oauth/identity-repository.ts"),
			"utf8",
		);
		const predicates = [...repository.matchAll(/WHERE ([^\n]+)/g)].map((match) => match[1] ?? "");

		expect(predicates).toHaveLength(3);
		expect(predicates.filter((one) => /email/i.test(one))).toStrictEqual([]);
		expect(predicates.filter((one) => /provider = \$1 AND subject = \$2/.test(one))).toHaveLength(
			2,
		);
	});
});

/* ------------------------------------------------------------------ *
 * T-LINK-3 and T-LINK-5: the subject is the `sub`, and nothing builds
 * an address out of anything.
 * ------------------------------------------------------------------ */

function sourceFiles(): readonly { readonly path: string; readonly text: string }[] {
	const files: { path: string; text: string }[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.name.endsWith(".ts")) {
				files.push({ path, text: readFileSync(path, "utf8") });
			}
		}
	};
	walk(join(process.cwd(), "src"));
	return files;
}

describe("T-LINK-3: the subject is the provider's stable id (S-LINK-3)", () => {
	it("stores the `sub` value even when the provider puts an address in it", async () => {
		const mount = await mountWith({
			providerIds: ["stubby"],
			trusted: [],
			claims: {
				sub: "victim@example.com",
				email: "someone.else@example.com",
				email_verified: true,
			},
		});

		const answer = await signInThrough(mount, "stubby");
		const [identity] = await rowsOf<{ subject: string; provider_email: string }>(
			mount,
			"SELECT subject, provider_email FROM $schema.identity",
			[],
		);

		expect(answer.status).toBe(302);
		expect(identity?.subject).toBe("victim@example.com");
		expect(identity?.provider_email).toBe("someone.else@example.com");
	});

	it("assigns the subject from the subject claim and never from the address claim", () => {
		const assignments = sourceFiles()
			.flatMap((file) => [...file.text.matchAll(/\bsubject:\s*([^,\n]+)/g)])
			.map((match) => match[1] ?? "");

		expect(assignments.length).toBeGreaterThan(0);
		expect(assignments.filter((one) => /email/i.test(one))).toStrictEqual([]);
	});
});

describe("T-LINK-5: nothing invents an address (S-LINK-5)", () => {
	it("leaves no account behind when the provider reports none", async () => {
		const mount = await mountWith({
			providerIds: ["stubby"],
			trusted: [],
			claims: { sub: "a-subject-and-no-address" },
		});

		const refused = await signInThrough(mount, "stubby");
		const users = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.user", []);
		const identities = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.identity", []);

		expect(refused.status).toBe(502);
		expect(users).toHaveLength(0);
		expect(identities).toHaveLength(0);
	});

	it("builds no address by concatenation anywhere in the tree", () => {
		const suspects = sourceFiles().flatMap((file) =>
			[
				...file.text.matchAll(/\bemail\w*\s*[:=]\s*(`[^`]*@[^`]*`|"[^"]*@[^"]*"|'[^']*@[^']*')/g),
			].map((match) => `${file.path}: ${match[0]}`),
		);

		expect(suspects).toStrictEqual([]);
	});
});

/* ------------------------------------------------------------------ *
 * T-LINK-6 and T-LINK-7.
 * ------------------------------------------------------------------ */

function sessionCookieOf(response: Response): string {
	const line = response.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith("__Host-velve_session="));
	return line === undefined ? "" : (line.split(";")[0] ?? "");
}

async function linkThrough(mount: Mounted, providerId: string, cookie: string): Promise<Response> {
	const started = await mount.auth.handler(
		requestTo("/identity/link/start", { body: { provider: providerId }, cookie }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	const code = codeCarrying(url.searchParams.get("nonce"));
	return mount.auth.handler(
		requestTo(
			`/sign-in/oauth/callback/${providerId}?code=${code}&state=${encodeURIComponent(state)}`,
			{
				method: "GET",
				cookie: `__Host-velve_oauth_state=${body.stateCookie.value}; ${cookie}`,
			},
		),
	);
}

describe("T-LINK-6: the verification flag is per identity (S-LINK-6)", () => {
	it("does not move one identity's flag onto another of the same account", async () => {
		const mount = await mountWith({
			providerIds: ["stubby", "stubbier"],
			trusted: [],
			claims: { sub: "verified-subject", email: "one@example.com", email_verified: true },
		});
		const signedIn = await signInThrough(mount, "stubby");

		mount.provider.reportClaims({
			sub: "unverified-subject",
			email: "two@example.com",
			email_verified: false,
		});
		const linked = await linkThrough(mount, "stubbier", sessionCookieOf(signedIn));

		const before = await rowsOf<{ provider: string; provider_email_verified: boolean }>(
			mount,
			"SELECT provider, provider_email_verified FROM $schema.identity ORDER BY provider",
			[],
		);

		mount.provider.reportClaims({
			sub: "unverified-subject",
			email: "two@example.com",
			email_verified: true,
		});
		await signInThrough(mount, "stubbier");
		mount.provider.reportClaims({
			sub: "verified-subject",
			email: "one@example.com",
			email_verified: false,
		});
		await signInThrough(mount, "stubby");

		const after = await rowsOf<{ provider: string; provider_email_verified: boolean }>(
			mount,
			"SELECT provider, provider_email_verified FROM $schema.identity ORDER BY provider",
			[],
		);

		expect(linked.status).toBe(302);
		expect(before.map((one) => one.provider_email_verified)).toStrictEqual([false, true]);
		expect(after.map((one) => one.provider_email_verified)).toStrictEqual([true, false]);
	});
});

describe("T-LINK-7: linking re-issues the session (S-LINK-7)", () => {
	it("replaces the token and leaves no row behind for the old one", async () => {
		const mount = await mountWith({
			providerIds: ["stubby", "stubbier"],
			trusted: [],
			claims: { sub: "first", email: "first@example.com", email_verified: true },
		});
		const signedIn = await signInThrough(mount, "stubby");
		const first = sessionCookieOf(signedIn);
		const before = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.session", []);

		mount.provider.reportClaims({ sub: "second", email: "second@example.com" });
		const linked = await linkThrough(mount, "stubbier", first);
		const second = sessionCookieOf(linked);
		const after = await rowsOf<{ id: string }>(mount, "SELECT id FROM $schema.session", []);

		expect(linked.status).toBe(302);
		expect(second).not.toBe("");
		expect(second).not.toBe(first);
		expect(before).toHaveLength(1);
		expect(after).toHaveLength(1);
		expect(after[0]?.id).not.toBe(before[0]?.id);
	});
});
