import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";
import {
	enrolTotp,
	issuedCookieValue,
	mountWidest,
	PROOF_PASSWORD,
	pendingCookieHeader,
	sessionCookieHeader,
	totpCodeNow,
	type WidestMount,
} from "./proof-fixtures.js";

let mounted: WidestMount;
let clock: TestClock;
let totpSecret: string;
let recoveryCodes: string[];

const PENDING_ACCOUNT = { email: "pending-owner@example.com", username: "pendingowner" };
const SIGNING_IN_ACCOUNT = { email: "signing-in@example.com", username: "signingin" };
const UNKNOWN_TOKEN = "x".repeat(43);
const NO_SUCH_ROW = "00000000-0000-0000-0000-000000000000";
const WELL_FORMED_ASSERTION = {
	id: "AAAA",
	rawId: "AAAA",
	response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA" },
	clientExtensionResults: {},
	type: "public-key",
};

async function signUpWithTotp(account: { email: string; username: string }): Promise<{
	sessionToken: string;
	secretBase32: string;
}> {
	const signedUp = await mounted.handler(
		postTo("/sign-up", { ...account, password: PROOF_PASSWORD }),
	);
	const sessionToken = issuedCookieValue(signedUp, DEFAULT_COOKIE_NAMES.session) ?? "";
	return { sessionToken, secretBase32: await enrolTotp(mounted.handler, clock, sessionToken) };
}

/** A real intermediate state: the password was right and the account owes a second factor. */
async function freshPendingState(): Promise<string> {
	const answer = await mounted.handler(
		postTo("/sign-in/password", {
			emailOrUsername: PENDING_ACCOUNT.username,
			password: PROOF_PASSWORD,
		}),
	);
	const token = issuedCookieValue(answer, DEFAULT_COOKIE_NAMES.pending);
	if (token === null) {
		throw new Error(`the sign-in answered ${answer.status} without a pending state`);
	}
	return token;
}

beforeAll(async () => {
	clock = createTestClock(new Date());
	mounted = await mountWidest("cachepending", { clock });
	const owner = await signUpWithTotp(PENDING_ACCOUNT);
	totpSecret = owner.secretBase32;
	const generated = await mounted.handler(
		postTo("/factor/recovery/generate", {}, { Cookie: sessionCookieHeader(owner.sessionToken) }),
	);
	recoveryCodes = ((await generated.json()) as { codes: string[] }).codes;
	await signUpWithTotp(SIGNING_IN_ACCOUNT);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

/** What each route is sent; a route the instance serves and this table does not name fails the census. */
const INPUT_OF: Readonly<Record<string, () => Record<string, unknown>>> = {
	signOut: () => ({}),
	"session.read": () => ({}),
	"session.list": () => ({}),
	"session.revoke": () => ({ targetSessionId: NO_SUCH_ROW }),
	"session.revokeAllOther": () => ({}),
	"session.revokeAll": () => ({}),
	"session.refresh": () => ({}),
	"username.isAvailable": () => ({ username: "stillfree" }),
	"username.change": () => ({ newUsername: "renamed" }),
	"pending.read": () => ({}),
	"pending.cancel": () => ({}),
	"signIn.oauth.start": () => ({ provider: "stubby" }),
	"signIn.oauth.callback": () => ({ code: "a-code", state: "a-state" }),
	"signIn.oauth.callbackFormPost": () => ({ code: "a-code", state: "a-state" }),
	"identity.list": () => ({}),
	"identity.link.start": () => ({ provider: "stubby" }),
	"identity.unlink": () => ({ identityId: NO_SUCH_ROW }),
	"signUp.withPassword": () => ({
		email: "new-account@example.com",
		username: "newaccount",
		password: PROOF_PASSWORD,
	}),
	"signUp.withoutPassword": () => ({ email: "no-password@example.com", username: "nopassword" }),
	"password.redeemResetWithRecoveryCode": () => ({
		emailOrUsername: SIGNING_IN_ACCOUNT.username,
		recoveryCode: "AAAAA-BBBBB",
		newPassword: "another-password-of-length",
	}),
	"signIn.magicLink.request": () => ({ email: "nobody@example.com" }),
	"signIn.magicLink.redeem": () => ({ token: UNKNOWN_TOKEN }),
	"email.requestVerification": () => ({}),
	"email.redeemVerification": () => ({ token: UNKNOWN_TOKEN }),
	"email.requestChange": () => ({ newEmail: "elsewhere@example.com" }),
	"email.redeemChange": () => ({ token: UNKNOWN_TOKEN }),
	"password.requestReset": () => ({ email: "nobody@example.com" }),
	"password.redeemReset": () => ({
		token: UNKNOWN_TOKEN,
		newPassword: "another-password-of-length",
	}),
	"signIn.password": () => ({
		emailOrUsername: SIGNING_IN_ACCOUNT.username,
		password: PROOF_PASSWORD,
	}),
	"password.set": () => ({ newPassword: "another-password-of-length" }),
	"password.change": () => ({
		currentPassword: PROOF_PASSWORD,
		newPassword: "another-password-of-length",
	}),
	"factor.totp.enroll.start": () => ({}),
	"factor.totp.enroll.finish": () => ({ code: "000000" }),
	"factor.totp.verify": () => ({ code: totpCodeNow(totpSecret, clock) }),
	"factor.totp.remove": () => ({ code: "000000" }),
	"factor.recovery.generate": () => ({}),
	"factor.recovery.verify": () => ({ code: recoveryCodes[0] ?? "" }),
	"factor.recovery.remaining": () => ({}),
	"factor.webauthn.register.start": () => ({}),
	"factor.webauthn.register.finish": () => ({
		challengeToken: UNKNOWN_TOKEN,
		response: {
			...WELL_FORMED_ASSERTION,
			response: { clientDataJSON: "AAAA", attestationObject: "AAAA" },
		},
		label: "a key",
	}),
	"factor.webauthn.authenticate.start": () => ({}),
	"factor.webauthn.authenticate.finish": () => ({
		challengeToken: UNKNOWN_TOKEN,
		response: WELL_FORMED_ASSERTION,
	}),
	"factor.webauthn.list": () => ({}),
	"factor.webauthn.rename": () => ({ credentialId: NO_SUCH_ROW, label: "renamed" }),
	"factor.webauthn.remove": () => ({ credentialId: NO_SUCH_ROW }),
	"signIn.passkey.start": () => ({}),
	"signIn.passkey.finish": () => ({
		challengeToken: UNKNOWN_TOKEN,
		response: WELL_FORMED_ASSERTION,
	}),
};

//the reader set is six and not four because the two pending routes are declared readers (E-530)
const PENDING_READERS = [...PENDING_CALLER_ROUTES, "pending.read", "pending.cancel"].sort();

/**
 * Routes whose answer to two identical cookie-less requests in a row already differs, because it
 * mints a token, an identifier or a challenge. Byte identity cannot be asked of them by anyone;
 * they are compared after T-ENUM-1's normalisation instead, and the list is exact.
 */
const ANSWERS_DIFFER_BETWEEN_IDENTICAL_REQUESTS = [
	"signIn.oauth.start",
	"signIn.passkey.start",
	"signIn.password",
].sort();

interface Route {
	readonly name: string;
	readonly method: string;
	readonly path: string;
	readonly requestBody?: string;
}

function requestFor(route: Route, cookie: string | null): Request {
	const input = INPUT_OF[route.name]?.() ?? {};
	const path = route.path.replace(":provider", "stubby");
	const headers: Record<string, string> = { Origin: TEST_ORIGIN };
	if (cookie !== null) {
		headers.Cookie = cookie;
	}
	if (route.method === "GET") {
		const query = new URLSearchParams(input as Record<string, string>).toString();
		return new Request(`https://api.example.com${path}${query === "" ? "" : `?${query}`}`, {
			method: "GET",
			headers,
		});
	}
	if (route.requestBody === "form") {
		headers["Content-Type"] = "application/x-www-form-urlencoded";
		return new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers,
			body: new URLSearchParams(input as Record<string, string>),
		});
	}
	headers["Content-Type"] = "application/json";
	return new Request(`https://api.example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
}

/** Status, every header but Date in a fixed order, and the body's bytes. */
async function verbatim(answer: Response): Promise<string> {
	const headers = [...answer.headers]
		.filter(([name]) => name !== "date")
		.map(([name, value]) => `${name}: ${value}`)
		.sort()
		.join("\n");
	return `${answer.status}\n${headers}\n${Buffer.from(await answer.arrayBuffer()).toString("hex")}`;
}

interface Comparison {
	readonly name: string;
	readonly withPending: string;
	readonly withoutCookie: string;
	readonly deterministic: boolean;
	readonly handsBackThePresentedToken: boolean;
}

/**
 * Whether the presented token comes back in any header or in the body. The normalisation above
 * replaces every 43-character secret, so a route that wrote the presented token into its own
 * cookie or answer would compare equal to one that minted a fresh token.
 */
async function carriesToken(answer: Response, token: string): Promise<boolean> {
	const headers = [...answer.headers].map(([, value]) => value).join("\n");
	return `${headers}\n${await answer.text()}`.includes(token);
}

/** The presented intermediate state's row as text, so a call that spends, counts or deletes it shows. */
async function presentedStateRow(pendingToken: string): Promise<string> {
	const [row] = await mounted.connection.query<{ row: string }>(
		`SELECT row_to_json(p)::text AS row FROM ${mounted.schema}.pending_authentication p
		 WHERE token_sha256 = $1`,
		[createHash("sha256").update(pendingToken, "utf8").digest()],
	);
	return row?.row ?? "absent";
}

/** One request, and what it did to the presented intermediate state as well as what it answered. */
async function observe(
	route: Route,
	cookie: string | null,
	pendingToken: string,
): Promise<{ answer: Response; touchedTheState: boolean }> {
	const before = await presentedStateRow(pendingToken);
	const answer = await mounted.handler(requestFor(route, cookie));
	return { answer, touchedTheState: (await presentedStateRow(pendingToken)) !== before };
}

/**
 * Three requests per route, the second carrying the pending cookie. The first absorbs whatever a
 * first call changes, the third is what the second must equal, and a fourth without a cookie says
 * whether two identical requests are byte-identical at all.
 */
async function compare(route: Route, pendingToken: string): Promise<Comparison> {
	await mounted.handler(requestFor(route, null));
	const withPending = await observe(route, pendingCookieHeader(pendingToken), pendingToken);
	const withoutCookie = await observe(route, null, pendingToken);
	const control = await mounted.handler(requestFor(route, null));
	const [pendingText, withoutText, controlText] = await Promise.all([
		verbatim(withPending.answer.clone()),
		verbatim(withoutCookie.answer.clone()),
		verbatim(control.clone()),
	]);
	const deterministic = withoutText === controlText;
	const handsBackThePresentedToken = await carriesToken(withPending.answer.clone(), pendingToken);
	const answered = (text: string, touched: boolean) => `${text}\nstate touched: ${touched}`;
	return {
		name: route.name,
		withPending: answered(
			deterministic ? pendingText : await normalisedAnswer(withPending.answer),
			withPending.touchedTheState,
		),
		withoutCookie: answered(
			deterministic ? withoutText : await normalisedAnswer(withoutCookie.answer),
			withoutCookie.touchedTheState,
		),
		deterministic,
		handsBackThePresentedToken,
	};
}

describe("only the pending readers see the intermediate state (S-CACHE-4, T-CACHE-4)", () => {
	let comparisons: readonly Comparison[] = [];
	let sharedPendingToken = "";

	beforeAll(async () => {
		const routes = mounted.auth.routes as unknown as readonly Route[];
		sharedPendingToken = await freshPendingState();
		const results: Comparison[] = [];
		for (const route of routes.filter((candidate) => !PENDING_READERS.includes(candidate.name))) {
			results.push(await compare(route, sharedPendingToken));
		}
		for (const route of routes.filter((candidate) => PENDING_READERS.includes(candidate.name))) {
			results.push(await compare(route, await freshPendingState()));
		}
		comparisons = results;
	});

	it("names an input for every route the widest instance serves, and for no other", () => {
		const served = mounted.auth.routes.map((route) => route.name).sort();

		expect(Object.keys(INPUT_OF).sort()).toStrictEqual(served);
		expect(comparisons).toHaveLength(served.length);
	});

	/**
	 * Behaviour is the answer and what the call did to the presented state: `pending.cancel` answers
	 * byte for byte alike with and without the cookie and differs only in deleting the row.
	 */
	it("behaves differently with the cookie on exactly the six reading routes", () => {
		const differing = comparisons
			.filter((comparison) => comparison.withPending !== comparison.withoutCookie)
			.map((comparison) => comparison.name)
			.sort();

		expect(differing).toStrictEqual(PENDING_READERS);
	});

	it("answers every other route byte for byte as if no cookie had been sent, and spends nothing", () => {
		const others = comparisons.filter((comparison) => !PENDING_READERS.includes(comparison.name));
		const notByteIdentical = others
			.filter((comparison) => comparison.withPending !== comparison.withoutCookie)
			.map((comparison) => comparison.name);
		const comparedOnlyAfterNormalisation = others
			.filter((comparison) => !comparison.deterministic)
			.map((comparison) => comparison.name)
			.sort();

		expect(notByteIdentical).toStrictEqual([]);
		expect(comparedOnlyAfterNormalisation).toStrictEqual(ANSWERS_DIFFER_BETWEEN_IDENTICAL_REQUESTS);
	});

	it("hands the presented pending token back on no route, which the normalisation would hide", () => {
		const echoing = comparisons
			.filter((comparison) => comparison.handsBackThePresentedToken)
			.map((comparison) => comparison.name);

		expect(echoing).toStrictEqual([]);
	});

	it("leaves the shared intermediate state standing through every other route", async () => {
		const answer = await mounted.handler(
			new Request("https://api.example.com/pending", {
				method: "GET",
				headers: { Origin: TEST_ORIGIN, Cookie: pendingCookieHeader(sharedPendingToken) },
			}),
		);

		expect(await answer.json()).not.toBeNull();
	});
});
