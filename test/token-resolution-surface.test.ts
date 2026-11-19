import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createVelveClient, VELVE_CLIENT_ROUTES } from "../src/client/index.js";
import type {
	OneTimeTokenNamespace,
	OneTimeTokenPurpose,
	ResolvedOneTimeToken,
	VelveAuth,
} from "../src/index.js";
import { type MountedAuth, mountAuth, mountAuthInMode } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * S-TOKEN-7: the resolve is a method of the instance and nothing else. No route is declared for
 * it, so the HTTP handler cannot reach it and the client has no call for it; it exists in the two
 * identity modes that mail a link and is absent from mode `username`, which mails none.
 */

const USERNAME_RULES = {
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: [],
};

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("token_resolution_surface");
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("the resolve is a server method only (S-TOKEN-7)", () => {
	it("is on the instance and has no route in the route table", () => {
		expect(typeof mounted.auth.oneTimeToken.resolve).toBe("function");
		expect(
			mounted.auth.routes.filter((route) => route.name.startsWith("oneTimeToken")),
		).toStrictEqual([]);
		expect(mounted.auth.routes.filter((route) => /resolve/i.test(route.path))).toStrictEqual([]);
	});

	it("is not in the client's route table nor on a client", () => {
		const client = createVelveClient({ baseURL: "https://app.example.com/api/auth" });

		expect(
			VELVE_CLIENT_ROUTES.filter((route) => route.name.startsWith("oneTimeToken")),
		).toStrictEqual([]);
		expect(Object.keys(client)).not.toContain("oneTimeToken");
	});

	it("answers no HTTP request for a path that would name it", async () => {
		const paths = ["/one-time-token/resolve", "/oneTimeToken/resolve", "/token/resolve"];
		const statuses = await Promise.all(
			paths.map(async (path) => {
				const answer = await mounted.handler(
					new Request(`https://app.example.com/api/auth${path}`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
						body: JSON.stringify({ token: "A".repeat(43) }),
					}),
				);
				return answer.status;
			}),
		);

		expect(statuses).toStrictEqual([404, 404, 404]);
	});

	it("takes a token and answers an account and a purpose, or null", () => {
		expectTypeOf<OneTimeTokenNamespace["resolve"]>().parameters.toEqualTypeOf<
			[{ token: string }]
		>();
		expectTypeOf<OneTimeTokenNamespace["resolve"]>().returns.toEqualTypeOf<
			Promise<ResolvedOneTimeToken | null>
		>();
		expectTypeOf<ResolvedOneTimeToken>().toEqualTypeOf<{
			readonly userId: string;
			readonly purpose: OneTimeTokenPurpose;
		}>();
		expectTypeOf<OneTimeTokenPurpose>().toEqualTypeOf<
			"email_verify" | "password_reset" | "email_change" | "magic_link"
		>();
	});
});

describe("the resolve exists where a link is mailed (S-TOKEN-7)", () => {
	it("is typed in modes email and username_email and absent in mode username", () => {
		expectTypeOf<VelveAuth<"email">["oneTimeToken"]>().toEqualTypeOf<OneTimeTokenNamespace>();
		expectTypeOf<
			VelveAuth<"username_email">["oneTimeToken"]
		>().toEqualTypeOf<OneTimeTokenNamespace>();
		expectTypeOf<VelveAuth<"username">>().not.toHaveProperty("oneTimeToken");
	});

	it.each([
		["username_email", true],
		["username", false],
	] as const)("is on an instance in mode %s: %s", async (mode, present) => {
		const instance = await mountAuthInMode(
			`token_resolution_${mode}`,
			{ mode, username: USERNAME_RULES },
			{ recoveryCodes: { count: 10, groupSize: 5 } },
		);
		const carried = Object.hasOwn(instance.auth, "oneTimeToken");
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();

		expect(carried).toBe(present);
	});
});
