import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { jsonPost, mountWidest, signUpOn, type WidestMount } from "./widest-mount-fixtures.js";

let mount: WidestMount;

beforeAll(async () => {
	mount = await mountWidest("redirseven");
});

afterAll(async () => {
	await mount.close();
});

const CANARY = "zqcanary7x3k";

type DeclaredRoute = AnyRoute & { readonly input: { readonly fields: readonly string[] } };

//each route gets its own canary so one route storing it cannot make the next refuse it as taken
function canaryFor(field: string, route: number): string {
	const canary = `${CANARY}r${route}`;
	return /email/i.test(field) ? `${canary}@example.com` : canary;
}

//these four answers return the caller's own stored input and are the only echoes allowed (S-REDIR-7)
const PERMITTED_ECHOES: Readonly<Record<string, readonly string[]>> = {
	"signUp.withPassword": ["user.email", "user.username"],
	"signUp.withoutPassword": ["user.email", "user.username"],
	"username.change": ["user.username"],
	"factor.webauthn.rename": ["credential.label"],
};

async function cookieFor(route: AnyRoute): Promise<string | undefined> {
	if (route.caller === "session") {
		return (await signUpOn(mount)).sessionCookie;
	}
	if (route.caller === "pending") {
		const account = await signUpOn(mount);
		const pending = createPendingAuthenticationService({
			driver: mount.connection,
			schema: mount.schema,
		});
		const begun = await pending.begin({ userId: account.userId, factorsCompleted: ["password"] });
		return `${DEFAULT_COOKIE_NAMES.pending}=${begun.token}`;
	}
	return undefined;
}

function requestWithCanaries(
	route: DeclaredRoute,
	index: number,
	cookie: string | undefined,
): Request {
	const pathFields = new Set(
		route.path
			.split("/")
			.filter((segment) => segment.startsWith(":"))
			.map((segment) => segment.slice(1)),
	);
	const path = route.path.replace(/:(\w+)/g, (_match, field: string) => canaryFor(field, index));
	const fields = route.input.fields.filter((field) => !pathFields.has(field));
	const values = new URLSearchParams(fields.map((field) => [field, canaryFor(field, index)]));
	const headers: Record<string, string> = {
		Origin: TEST_ORIGIN,
		...(cookie === undefined ? {} : { Cookie: cookie }),
	};
	if (route.method === "GET") {
		return new Request(`https://api.example.com${path}?${values}`, { headers });
	}
	if (route.requestBody === "form") {
		return new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
			body: values.toString(),
		});
	}
	return new Request(`https://api.example.com${path}`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(Object.fromEntries(values)),
	});
}

function pathsHolding(value: unknown, needle: string, at = ""): string[] {
	if (typeof value === "string") {
		return value.includes(needle) ? [at] : [];
	}
	if (typeof value !== "object" || value === null) {
		return [];
	}
	return Object.entries(value).flatMap(([key, inner]) =>
		pathsHolding(inner, needle, at === "" ? key : `${at}.${key}`),
	);
}

interface Swept {
	readonly route: string;
	readonly status: number;
	readonly contentType: string | null;
	readonly body: string;
}

async function sweep(): Promise<Swept[]> {
	const swept: Swept[] = [];
	for (const [index, route] of (mount.auth.routes as readonly DeclaredRoute[]).entries()) {
		const answer = await mount.handler(requestWithCanaries(route, index, await cookieFor(route)));
		swept.push({
			route: route.name,
			status: answer.status,
			contentType: answer.headers.get("Content-Type"),
			body: await answer.text(),
		});
	}
	return swept;
}

let answers: Swept[];

describe("T-REDIR-7: JSON only, and no input reflected (S-REDIR-7)", () => {
	beforeAll(async () => {
		answers = await sweep();
	}, 60_000);

	it("sends a canary into every input of every route the widest table serves", () => {
		expect(answers).toHaveLength(47);
		expect(
			(mount.auth.routes as readonly DeclaredRoute[]).flatMap((r) => r.input.fields).length,
		).toBeGreaterThan(30);
	});

	it("answers application/json wherever there is a body", () => {
		const withBody = answers.filter((answer) => answer.body.length > 0);

		expect(withBody.length).toBeGreaterThan(30);
		expect(
			withBody
				.filter((answer) => answer.contentType !== "application/json")
				.map((answer) => `${answer.route} ${answer.status} ${answer.contentType}`),
		).toStrictEqual([]);
		expect(answers.filter((answer) => /<html|<!doctype/i.test(answer.body))).toStrictEqual([]);
	});

	it("reflects the canary nowhere outside the stored input a permitted answer returns", () => {
		const reflected = answers.flatMap((answer) => {
			if (!answer.body.includes(CANARY)) {
				return [];
			}
			const permitted = PERMITTED_ECHOES[answer.route] ?? [];
			const paths = pathsHolding(JSON.parse(answer.body), CANARY);
			const outside = paths.filter((path) => !permitted.includes(path));
			return outside.length === 0 && paths.length > 0
				? []
				: [`${answer.route}: ${outside.join(", ")}`];
		});

		expect(reflected).toStrictEqual([]);
	});

	it("does see the canary where a permitted answer returns it, so the search can find one", () => {
		const signUp = answers.find((answer) => answer.route === "signUp.withPassword");

		expect(signUp?.status).toBe(200);
		expect(pathsHolding(JSON.parse(signUp?.body ?? "null"), CANARY).sort()).toStrictEqual([
			"user.email",
			"user.username",
		]);
	});

	it("echoes only in the answers it names, so the list of permitted echoes is not wider than the tree", () => {
		const echoing = answers.filter((answer) => answer.body.includes(CANARY));

		expect(echoing.map((answer) => answer.route)).toStrictEqual([
			"username.change",
			"signUp.withPassword",
			"signUp.withoutPassword",
		]);
	});

	//a canary credential id finds no row, so the rename's echo is shown on a credential that exists
	it("returns a renamed label only where the permitted echo names it", async () => {
		const account = await signUpOn(mount);
		const [row] = await mount.connection.query<{ id: string }>(
			`INSERT INTO ${mount.schema}.webauthn_credential
			 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
			 VALUES ($1, $2, $3, false, false, true) RETURNING id`,
			[account.userId, randomBytes(32), randomBytes(32)],
		);
		const renamed = await mount.handler(
			jsonPost(
				"/factor/webauthn/rename",
				{ credentialId: row?.id, label: `${CANARY}label` },
				account.sessionCookie,
			),
		);

		expect(renamed.status).toBe(200);
		expect(renamed.headers.get("Content-Type")).toBe("application/json");
		expect(pathsHolding(await renamed.json(), CANARY)).toStrictEqual(
			PERMITTED_ECHOES["factor.webauthn.rename"],
		);
	});
});
