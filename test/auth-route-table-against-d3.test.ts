import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnyRoute } from "../src/core/http/route.js";
import {
	addressOf,
	everyRowDeclaredByD3,
	rowsServedUnder,
	type ServedConfiguration,
} from "./architecture-route-table.js";
import { type MountedAuth, mountAuthInMode, TEST_ORIGIN } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

const USERNAME_RULES = {
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: [],
};

const WEBAUTHN = {
	relyingPartyId: "app.example.com",
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

function servedAddresses(routes: readonly AnyRoute[]): readonly string[] {
	return [...routes.map(addressOf)].sort();
}

function declaredAddresses(configuration: ServedConfiguration): readonly string[] {
	return [...rowsServedUnder(configuration).map(addressOf)].sort();
}

/**
 * D.3 is the table, and this is the comparison against it in both directions: a row the tree serves
 * that D.3 does not declare fails here exactly as a row D.3 declares that the tree does not serve.
 * It replaces a floor of seven that twelve assertions rested on, which could not have noticed three
 * rows going missing from a table of twenty-nine (E-1245).
 */
describe("the mounted table against 3.15 D.3", () => {
	it("serves every row the widest configuration declares, and no row D.3 does not", () => {
		const widest = widestVelveAuth();

		expect(everyRowDeclaredByD3()).toHaveLength(47);
		expect(servedAddresses(widest.routes)).toStrictEqual(
			declaredAddresses({ mode: "username_email", webauthn: true }),
		);
	});

	it("counts what D.3's closing paragraph counts, in each of the three modes", () => {
		expect(declaredAddresses({ mode: "username_email", webauthn: true })).toHaveLength(47);
		expect(declaredAddresses({ mode: "email", webauthn: true })).toHaveLength(45);
		expect(declaredAddresses({ mode: "username", webauthn: true })).toHaveLength(39);
		expect(declaredAddresses({ mode: "username_email", webauthn: false })).toHaveLength(47 - 9);
	});
});

/**
 * The other half of E-1192's class. The shadowing guard refuses a stated namespace that replaces a
 * derived one; nothing refuses a row that is served over HTTP and reachable through no server
 * method, because the core rows are wired by hand and a hand can miss one. 3.15 D.2 makes the
 * dotted name the object path, so the check is that walking it arrives at a function (E-1247).
 */
describe("every row the table serves is reachable as the server method its name spells", () => {
	/**
	 * The two rows whose route name and method name differ, and both because 3.15 B gives the
	 * method a signature the row cannot have: `session.resolve` and `pending.resolve` take the
	 * token as an argument, where the row reads it from a cookie. Named here rather than filtered
	 * out by a pattern, so a third divergence has to be added deliberately.
	 */
	const NAMED_DIFFERENTLY_IN_B: Readonly<Record<string, string>> = {
		"session.read": "session.resolve",
		"pending.read": "pending.resolve",
	};

	it("walks the dotted name of every row to a function", () => {
		const widest = widestVelveAuth() as unknown as Record<string, unknown>;
		const served = widest.routes as readonly AnyRoute[];

		expect(served).toHaveLength(47);
		expect(Object.keys(NAMED_DIFFERENTLY_IN_B)).toHaveLength(2);
		expect(
			served
				.map((route) => NAMED_DIFFERENTLY_IN_B[route.name] ?? route.name)
				.filter((name) => typeof methodAt(widest, name) !== "function"),
		).toStrictEqual([]);
	});
});

function methodAt(surface: Record<string, unknown>, dottedName: string): unknown {
	let node: unknown = surface;
	for (const segment of dottedName.split(".")) {
		if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
			return undefined;
		}
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

describe("what an identity mode and a configuration take out of the table", () => {
	const mounts: MountedAuth<"email">[] = [];
	let withoutWebAuthn: MountedAuth<"email">;
	let usernameOnly: MountedAuth<"username">;

	beforeAll(async () => {
		withoutWebAuthn = await mountAuthInMode<"email">("d3email", { mode: "email" });
		usernameOnly = await mountAuthInMode<"username">(
			"d3username",
			{ mode: "username", username: USERNAME_RULES },
			{ recoveryCodes: { count: 10, groupSize: 5 }, webauthn: WEBAUTHN },
		);
		mounts.push(withoutWebAuthn);
	});

	afterAll(async () => {
		for (const mount of [...mounts, usernameOnly]) {
			await dropSchema(mount.connection, mount.schema);
			await mount.connection.close();
		}
	});

	it("serves the email rows without the nine an unconfigured webauthn removes", () => {
		expect(servedAddresses(withoutWebAuthn.auth.routes)).toStrictEqual(
			declaredAddresses({ mode: "email", webauthn: false }),
		);
	});

	it("serves the username rows, which is where a recovery code is the only way back in", () => {
		expect(servedAddresses(usernameOnly.auth.routes)).toStrictEqual(
			declaredAddresses({ mode: "username", webauthn: true }),
		);
	});
});
