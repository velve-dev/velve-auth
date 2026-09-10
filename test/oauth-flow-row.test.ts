import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

interface StartedFlow {
	readonly pointer: string;
	readonly state: string;
	readonly nonce: string | null;
}

let mounted: MountedAuth;

beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "provider-subject-1", email: "signed.in@example.com", email_verified: true },
	});
	mounted = await mountAuth("oauthflowrow", {
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function start(): Promise<StartedFlow> {
	const response = await mounted.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	return {
		pointer: body.stateCookie.value,
		state: url.searchParams.get("state") ?? "",
		nonce: url.searchParams.get("nonce"),
	};
}

function callback(flow: StartedFlow): Request {
	return requestTo(
		`/sign-in/oauth/callback/stubby?code=${codeCarrying(flow.nonce)}&state=${encodeURIComponent(flow.state)}`,
		{ method: "GET", cookie: `__Host-velve_oauth_state=${flow.pointer}` },
	);
}

async function flowRows(): Promise<number> {
	const [row] = await mounted.connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${mounted.schema}.oauth_flow`,
		[],
	);
	return row?.count ?? 0;
}

/**
 * S-CSRF-5's pointer check runs before the flow row is consumed, so a callback that fails it never
 * reaches the clause S-REPLAY-6 is about. These two carry a pointer the start issued and reach it.
 */
describe("T-REPLAY-6: the flow row is what admits a callback (S-REPLAY-6)", () => {
	it("refuses a state whose row is gone, without the pointer check catching it first", async () => {
		const flow = await start();
		await mounted.connection.query(`DELETE FROM ${mounted.schema}.oauth_flow`, []);

		const answer = await mounted.handler(callback(flow));

		expect(answer.status).toBe(400);
		expect(await flowRows()).toBe(0);
	});

	it("refuses a state whose row has expired, and leaves the expired row unconsumed", async () => {
		const flow = await start();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.oauth_flow SET expires_at = now() - interval '1 second'`,
			[],
		);

		const answer = await mounted.handler(callback(flow));

		expect(answer.status).toBe(400);
		expect(await flowRows()).toBe(1);
		await mounted.connection.query(`DELETE FROM ${mounted.schema}.oauth_flow`, []);
	});

	/**
	 * Without this the two above hold for a callback that refuses everything, which is the reading
	 * that satisfies the requirement and breaks third-party sign-in.
	 */
	it("takes the same callback when the row is there and unexpired", async () => {
		const flow = await start();

		const answer = await mounted.handler(callback(flow));

		expect(answer.status).toBe(302);
		expect(await flowRows()).toBe(0);
	});
});

describe("no option turns PKCE off (S-REPLAY-6)", () => {
	const FORBIDDEN = ["disablePkce", "pkce:", "codeChallengeMethod", "usePkce", "pkceMethod"];

	function everySourceFile(): string[] {
		return readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
			.filter((entry) => entry.endsWith(".ts"))
			.map((entry) => `${sourceRoot}/${entry}`);
	}

	it("names no switch for it anywhere in the library, over a set that is not empty", () => {
		const files = everySourceFile();
		const carrying = files.flatMap((path) => {
			const text = readFileSync(path, "utf8");
			return FORBIDDEN.filter((name) => text.includes(name)).map((name) => `${path}: ${name}`);
		});

		expect(files.length).toBeGreaterThan(20);
		expect(carrying).toEqual([]);
	});

	it("reaches the OAuth configuration, which is where such a switch would live", () => {
		const files = everySourceFile();

		expect(files.filter((path) => path.endsWith("core/oauth/config.ts"))).toHaveLength(1);
	});

	it("writes S256 into the authorization request with no branch behind it", async () => {
		const flow = await start();
		const url = new URL(
			(
				(await (
					await mounted.handler(requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }))
				).json()) as { authorizationUrl: string }
			).authorizationUrl,
		);

		expect(flow.state).not.toBe("");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toHaveLength(43);
	});
});
