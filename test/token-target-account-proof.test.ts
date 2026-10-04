import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { withoutComments } from "../tools/source-text.mjs";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";
import { dropSchema, readUserOwnedTables } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { createStubProvider, oauthConfigFor } from "./oauth-provider.js";
import {
	issuedCookieValue,
	oauthCallbackRequest,
	oauthStateCookieHeader,
	PROOF_PASSWORD,
	sessionCookieHeader,
	startOAuthFlow,
	UNLIMITED_RATES,
} from "./proof-fixtures.js";

let mounted: MountedAuth;
let accounts = 0;

beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "linked-subject", email: "linked@example.com", email_verified: true },
	});
	mounted = await mountAuth("tokentarget", {
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		rateLimit: UNLIMITED_RATES,
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

interface Account {
	readonly id: string;
	readonly email: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `target${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PROOF_PASSWORD }));
	const sessionToken = issuedCookieValue(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user?: { id: string } };
	if (answer.status !== 200 || sessionToken === null || body.user === undefined) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { id: body.user.id, email, sessionToken };
}

/** The account row and every row a foreign key ties to it, as text, so any write to B shows. */
async function everythingOwnedBy(userId: string): Promise<readonly string[]> {
	const { connection, schema } = mounted;
	const rows: string[] = [];
	const [user] = await connection.query<{ row: string }>(
		`SELECT row_to_json(u)::text AS row FROM ${schema}.user u WHERE id = $1`,
		[userId],
	);
	rows.push(`user ${user?.row ?? "missing"}`);
	for (const owned of await readUserOwnedTables(connection, schema)) {
		const found = await connection.query<{ row: string }>(
			`SELECT row_to_json(t)::text AS row FROM ${schema}.${owned.table} t
			 WHERE ${owned.ownerColumn} = $1 ORDER BY 1`,
			[userId],
		);
		rows.push(...found.map((row) => `${owned.table} ${row.row}`));
	}
	return rows;
}

async function sessionIdOf(token: string): Promise<string> {
	const answer = await mounted.handler(
		requestTo("/session", { method: "GET", cookie: sessionCookieHeader(token) }),
	);
	const body = (await answer.json()) as { session: { id: string } } | null;
	if (body === null) {
		throw new Error("the presented session does not resolve");
	}
	return body.session.id;
}

async function emailOf(userId: string): Promise<string | null> {
	const [row] = await mounted.connection.query<{ email: string | null }>(
		`SELECT email FROM ${mounted.schema}.user WHERE id = $1`,
		[userId],
	);
	return row?.email ?? null;
}

function lastTokenSentTo(address: string): string {
	const message = [...mounted.email.messages].reverse().find((sent) => sent.to === address);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no token was sent to ${address}`);
	}
	return message.token;
}

describe("a one-time token acts on the account it was minted for (S-TOKEN-4, T-TOKEN-4 i)", () => {
	it("changes A's address when the redemption carries B's session, and leaves B untouched", async () => {
		const a = await signUp();
		const b = await signUp();
		const newAddress = `moved${accounts}@example.com`;
		const requested = await mounted.handler(
			postTo(
				"/email/request-change",
				{ newEmail: newAddress },
				{ Cookie: sessionCookieHeader(a.sessionToken) },
			),
		);
		expect(requested.status).toBe(204);
		const before = await everythingOwnedBy(b.id);

		const redeemed = await mounted.handler(
			postTo(
				"/email/redeem-change",
				{ token: lastTokenSentTo(newAddress) },
				{ Cookie: sessionCookieHeader(b.sessionToken) },
			),
		);
		const body = (await redeemed.json()) as { user: { id: string; email: string } };

		expect(redeemed.status).toBe(200);
		expect(body.user.id).toBe(a.id);
		expect(await emailOf(a.id)).toBe(newAddress);
		expect(await emailOf(b.id)).toBe(b.email);
		expect(await everythingOwnedBy(b.id)).toStrictEqual(before);
	});

	/**
	 * A reset signs A in, and every sign-in replaces the session the browser presented whoever owns
	 * it, so B's presented row goes by S-FIX-1 and S-FIX-3 and not by the token. Everything else of
	 * B's must stand, and B's credential above all.
	 */
	it("resets A's password when the redemption carries B's session, and leaves B's account untouched", async () => {
		const a = await signUp();
		const b = await signUp();
		const requested = await mounted.handler(postTo("/password/request-reset", { email: a.email }));
		expect(requested.status).toBe(204);
		const presentedSessionOfB = await sessionIdOf(b.sessionToken);
		const before = (await everythingOwnedBy(b.id)).filter(
			(row) => !(row.startsWith("session ") && row.includes(presentedSessionOfB)),
		);

		const redeemed = await mounted.handler(
			postTo(
				"/password/redeem-reset",
				{ token: lastTokenSentTo(a.email), newPassword: "a-new-password-for-account-a" },
				{ Cookie: sessionCookieHeader(b.sessionToken) },
			),
		);
		const issuedTo = await mounted.handler(
			requestTo("/session", {
				method: "GET",
				cookie: sessionCookieHeader(
					issuedCookieValue(redeemed, DEFAULT_COOKIE_NAMES.session) ?? "",
				),
			}),
		);
		const after = await everythingOwnedBy(b.id);
		const signInAsA = await mounted.handler(
			postTo("/sign-in/password", { email: a.email, password: "a-new-password-for-account-a" }),
		);
		const signInAsB = await mounted.handler(
			postTo("/sign-in/password", { email: b.email, password: PROOF_PASSWORD }),
		);

		expect(redeemed.status).toBe(200);
		expect(((await issuedTo.json()) as { user: { id: string } }).user.id).toBe(a.id);
		expect(signInAsA.status).toBe(200);
		expect(signInAsB.status).toBe(200);
		expect(after).toStrictEqual(before);
	});
});

describe("a link acts on the account the flow began in (S-TOKEN-4, T-TOKEN-4 ii)", () => {
	it("writes the identity to A when the callback carries A's pointer and B's session", async () => {
		const a = await signUp();
		const b = await signUp();
		const flow = await startOAuthFlow(
			mounted.handler,
			"/identity/link/start",
			sessionCookieHeader(a.sessionToken),
		);
		const before = await everythingOwnedBy(b.id);

		const linked = await mounted.handler(
			oauthCallbackRequest(flow, [
				oauthStateCookieHeader(flow.pointer),
				sessionCookieHeader(b.sessionToken),
			]),
		);
		const identities = await mounted.connection.query<{ user_id: string }>(
			`SELECT user_id FROM ${mounted.schema}.identity WHERE subject = $1`,
			["linked-subject"],
		);

		expect(linked.status).toBe(302);
		expect(identities.map((identity) => identity.user_id)).toStrictEqual([a.id]);
		expect(await everythingOwnedBy(b.id)).toStrictEqual(before);
	});
});

const REDEMPTION_ROUTES = [
	"email.redeemChange",
	"email.redeemVerification",
	"password.redeemReset",
	"password.redeemResetWithRecoveryCode",
	"signIn.magicLink.redeem",
	"signIn.oauth.callback",
	"signIn.oauth.callbackFormPost",
] as const;

/** `AnyRoute` hides the validator so no caller can reach past the checks; this scan needs its field list. */
interface DeclaredRoute {
	readonly name: string;
	readonly input: { readonly fields: readonly string[] };
}

const ACCOUNT_IDENTIFIER_FIELDS = ["userId", "user_id", "sub", "subject", "accountId"];

const READS_AN_ACCOUNT_FROM_INPUT = new RegExp(
	`\\binput\\s*(\\?\\.|\\.|\\[\\s*["'\`])\\s*(${ACCOUNT_IDENTIFIER_FIELDS.join("|")})\\b`,
);

const sourceRoot = fileURLToPath(new URL("../src/core", import.meta.url));

/** The function a redemption route hands its input to, and the file that defines it. */
const REDEMPTION_IMPLEMENTATIONS = [
	["flows/address.ts", "redeemVerification"],
	["flows/address.ts", "redeemChange"],
	["flows/reset.ts", "redeemReset"],
	["flows/reset.ts", "redeemResetWithRecoveryCode"],
	["flows/magic-link.ts", "redeemMagicLink"],
	["oauth/routes.ts", "completeFlow"],
] as const;

/** From the function's name to the end of its body, by counting braces in comment-free text. */
function bodyOf(source: string, name: string): string {
	const start = source.search(new RegExp(`function ${name}\\(`));
	if (start < 0) {
		throw new Error(`no function ${name} in the scanned source`);
	}
	const open = source.indexOf("{", source.indexOf(")", source.indexOf("(", start)));
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") {
			depth += 1;
		} else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(start, index + 1);
			}
		}
	}
	throw new Error(`the body of ${name} never closes`);
}

describe("no redemption reads an account from its input (S-TOKEN-4, T-TOKEN-4 scan)", () => {
	it("declares no account identifier in the input of any redemption route", () => {
		const routes = widestVelveAuth().routes as unknown as readonly DeclaredRoute[];
		const declared = REDEMPTION_ROUTES.map((name) => {
			const fields = routes.find((candidate) => candidate.name === name)?.input.fields;
			if (fields === undefined) {
				throw new Error(`${name} is not served or declares no field list`);
			}
			return { name, fields };
		});
		const offending = declared.filter(({ fields }) =>
			fields.some((field) => ACCOUNT_IDENTIFIER_FIELDS.includes(field)),
		);

		expect(declared).toHaveLength(REDEMPTION_ROUTES.length);
		expect(offending).toStrictEqual([]);
	});

	it("reads no account identifier off the input in any redemption implementation", () => {
		const scanned = REDEMPTION_IMPLEMENTATIONS.map(([file, name]) => ({
			name,
			body: bodyOf(withoutComments(readFileSync(`${sourceRoot}/${file}`, "utf8")), name),
		}));
		const hits = scanned
			.filter(({ body }) => READS_AN_ACCOUNT_FROM_INPUT.test(body))
			.map((s) => s.name);

		expect(scanned.every(({ body }) => /\binput\b/.test(body))).toBe(true);
		expect(hits).toStrictEqual([]);
	});

	it("finds a planted read, so a clean scan means something", () => {
		const planted = [
			"function redeemPlanted(input) { return lookup(input.userId); }",
			"function redeemPlanted(input) { return lookup(input?.sub); }",
			'function redeemPlanted(input) { return lookup(input["user_id"]); }',
		];

		for (const source of planted) {
			expect([
				source,
				READS_AN_ACCOUNT_FROM_INPUT.test(bodyOf(source, "redeemPlanted")),
			]).toStrictEqual([source, true]);
		}
	});
});
