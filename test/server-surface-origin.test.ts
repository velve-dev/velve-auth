import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationService,
	type PendingToken,
	toPendingToken,
} from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { mountWidest, signUpOn, type WidestMount } from "./widest-mount-fixtures.js";

/**
 * S-CSRF-1 on the instance itself rather than on server methods rebuilt from the route table: every
 * leaf method the widest mount carries is called with a foreign origin, with `origin: null` and with
 * no origin at all. Which methods may skip the check is read out of 3.15 B.9 — the rows whose caller
 * is `server` and the rows without a rate limit — and out of B's `AuthInternals`, never from the
 * code, so a method the code wrongly leaves unchecked cannot exempt itself (E-2831).
 */

const SPECIFICATION = fileURLToPath(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url));
const FOREIGN_ORIGIN = "https://evil.example.com";

const B9_OPENS = "##### B.9 Vorbedingungen je Methode";
const B9_CLOSES = "`session.resolve` und `pending.resolve` sind nicht ratenbegrenzt";
const INTERNALS_OPENS = "interface AuthInternals {";
const SURFACE_OPENS = "interface AuthSurface<M extends IdentityMode> {";
const EXEMPT_ROUTES_SENTENCE = /Routen mit `exempt`, und das sind `([^`]+)` und `([^`]+)`/;
const COUNT_SENTENCE = /`AuthSurface` hat (\d+) Methoden im Modus `username_email`/;

/** the instance's HTTP environment, which `toWebHandler` reads and B does not list (E-2831) */
const ENVIRONMENT_NOT_A_NAMESPACE = "http";

function specification(): string {
	return readFileSync(SPECIFICATION, "utf8");
}

function between(text: string, opens: string, closes: string): string {
	const start = text.indexOf(opens);
	const end = text.indexOf(closes, start + opens.length);
	if (start < 0 || end < 0) {
		throw new Error(`"${opens}" … "${closes}" was not found in the specification`);
	}
	return text.slice(start + opens.length, end);
}

/** `session.resolve`, `resolveFromHeaders` names `session.resolveFromHeaders`, as B.9 abbreviates */
function qualifiedNamesIn(cell: string): readonly string[] {
	const names: string[] = [];
	let namespace = "";
	for (const [, name = ""] of cell.matchAll(/`([A-Za-z.]+)`/g)) {
		if (name.includes(".")) {
			namespace = name.slice(0, name.lastIndexOf("."));
			names.push(name);
		} else {
			names.push(namespace === "" ? name : `${namespace}.${name}`);
		}
	}
	return names;
}

/** B.9's rows with caller `server` or without a rate limit, the only methods S-CSRF-1 does not reach */
function exemptByB9(): ReadonlySet<string> {
	const exempt = new Set<string>();
	for (const line of between(specification(), B9_OPENS, B9_CLOSES).split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		const [, methods = "", caller = "", , limit = ""] = cells;
		if (caller === "server" || limit === "**nein**") {
			for (const name of qualifiedNamesIn(methods)) {
				exempt.add(name);
			}
		}
	}
	return exempt;
}

/** the two callbacks T-CSRF-1 names as the whole of `originCheck: "exempt"` */
function exemptFromTheOriginCheck(): readonly string[] {
	const matched = EXEMPT_ROUTES_SENTENCE.exec(specification());
	if (matched === null) {
		throw new Error("T-CSRF-1's sentence naming the exempt routes was not found");
	}
	return [matched[1] ?? "", matched[2] ?? ""];
}

function membersOfInterface(opens: string): readonly string[] {
	const body = between(specification(), opens, "\n}");
	return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z]+)[(:]/gm)].map(([, name = ""]) => name);
}

function surfaceMethodCountInUsernameEmail(): number {
	const matched = COUNT_SENTENCE.exec(specification());
	if (matched === null) {
		throw new Error("B's sentence counting the methods of AuthSurface was not found");
	}
	return Number(matched[1]);
}

type Leaf = readonly [path: string, method: (input: unknown) => Promise<unknown>];

function leavesUnder(node: unknown, prefix: string): readonly Leaf[] {
	if (typeof node === "function") {
		return [[prefix, node as Leaf[1]]];
	}
	if (typeof node !== "object" || node === null) {
		return [];
	}
	return Object.entries(node).flatMap(([key, child]) =>
		leavesUnder(child, prefix === "" ? key : `${prefix}.${key}`),
	);
}

async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "answered";
	} catch (cause) {
		return (cause as { code?: string }).code ?? String(cause);
	}
}

let widest: WidestMount;
let sessionToken: string;
let surfaceLeaves: readonly Leaf[];
let exempt: ReadonlySet<string>;

beforeAll(async () => {
	widest = await mountWidest("serversurface");
	const account = await signUpOn(widest);
	sessionToken = account.sessionCookie.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
	const internals = new Set(membersOfInterface(INTERNALS_OPENS));
	surfaceLeaves = Object.entries(widest.auth)
		.filter(([name]) => !internals.has(name) && name !== ENVIRONMENT_NOT_A_NAMESPACE)
		.flatMap(([name, node]) => leavesUnder(node, name));
	exempt = new Set([...exemptByB9(), ...exemptFromTheOriginCheck()]);
}, 120_000);

afterAll(async () => {
	await widest.close();
});

describe("every state-changing method on the instance checks the origin (S-CSRF-1, 3.11)", () => {
	it("reads its exemptions from B.9 and finds the methods the specification names", () => {
		expect([...exempt].sort()).toStrictEqual(
			[
				"maintenance.sweep",
				"pending.resolve",
				"pending.resolveFromHeaders",
				"session.resolve",
				"signIn.oauth.callback",
				"signIn.oauth.callbackFormPost",
				"session.resolveFromHeaders",
				"user.delete",
				"user.disable",
				"user.enable",
				"user.findByEmail",
				"user.findById",
				"user.findByUsername",
			].sort(),
		);
	});

	it("walks every method of AuthSurface that B counts for username_email", () => {
		const declared = new Set(membersOfInterface(SURFACE_OPENS));
		const outside = Object.keys(widest.auth).filter(
			(name) =>
				!declared.has(name) &&
				!membersOfInterface(INTERNALS_OPENS).includes(name) &&
				name !== ENVIRONMENT_NOT_A_NAMESPACE,
		);

		expect(outside).toStrictEqual([]);
		expect(surfaceLeaves).toHaveLength(surfaceMethodCountInUsernameEmail());
	});

	it("never refuses either callback for its origin, as T-CSRF-1 exempts exactly those two", async () => {
		const callbacks = surfaceLeaves.filter(([path]) => exemptFromTheOriginCheck().includes(path));
		const codes = await Promise.all(
			callbacks.map(([, method]) => codeOf(method({ origin: FOREIGN_ORIGIN }))),
		);

		expect(callbacks).toHaveLength(2);
		expect(codes).not.toContain("origin_not_allowed");
	});

	it.each([
		["a foreign origin", { origin: FOREIGN_ORIGIN }],
		["origin null", { origin: null }],
		["no origin field", {}],
	])("refuses %s on every method B.9 does not exempt", async (_label, originFields) => {
		const checked = surfaceLeaves.filter(([path]) => !exempt.has(path));
		const answers = await Promise.all(
			checked.map(async ([path, method]) => {
				const code = await codeOf(
					method({ ...originFields, sessionToken, pendingToken: "x".repeat(43) }),
				);
				return `${path} ${code}`;
			}),
		);

		expect(checked.length).toBeGreaterThan(40);
		expect(answers).toStrictEqual(checked.map(([path]) => `${path} origin_not_allowed`));
	});
});

describe("pending.cancel runs the route's pipeline on the direct call (3.11, E-531, E-2830)", () => {
	let mounted: MountedAuth;

	beforeAll(async () => {
		mounted = await mountAuth("pendingcancel");
	});

	afterAll(async () => {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	});

	async function rowsOfPendingState(): Promise<number> {
		const [row] = await mounted.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${mounted.schema}.pending_authentication`,
			[],
		);
		return row?.present ?? -1;
	}

	it("leaves the state standing when the origin is foreign and removes it when it is allowed", async () => {
		const [row] = await mounted.connection.query<{ id: string }>(
			`INSERT INTO ${mounted.schema}.user (email) VALUES ('cancel@example.com') RETURNING id`,
			[],
		);
		const begun = await createPendingFor(row?.id ?? "");

		await expect(
			mounted.auth.pending.cancel({ pendingToken: begun, origin: FOREIGN_ORIGIN }),
		).rejects.toMatchObject({ code: "origin_not_allowed" });
		expect(await rowsOfPendingState()).toBe(1);

		await mounted.auth.pending.cancel({ pendingToken: begun, origin: TEST_ORIGIN });
		expect(await rowsOfPendingState()).toBe(0);
	});

	it("counts the direct call against the address bucket the route declares", async () => {
		const outcomes: string[] = [];
		for (let call = 0; call < 40; call += 1) {
			outcomes.push(
				await codeOf(
					mounted.auth.pending.cancel({
						pendingToken: toPendingToken("x".repeat(43)),
						origin: TEST_ORIGIN,
						ipAddress: "203.0.113.9",
					}),
				),
			);
		}

		expect(outcomes[0]).toBe("answered");
		expect(outcomes.at(-1)).toBe("rate_limited");
	});

	async function createPendingFor(userId: string): Promise<PendingToken> {
		const service = createPendingAuthenticationService({
			driver: mounted.connection,
			schema: mounted.schema,
		});
		const begun = await service.begin({ userId, factorsCompleted: ["password"] });
		return begun.token;
	}
});
