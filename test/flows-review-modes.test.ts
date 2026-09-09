import { afterEach, describe, expect, it } from "vitest";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { type MountedAuth, mountAuthInMode, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

const mounts: MountedAuth<IdentityMode>[] = [];

afterEach(async () => {
	for (const mount of mounts.splice(0)) {
		await dropSchema(mount.connection, mount.schema);
		await mount.connection.close();
	}
});

const USERNAME_RULES = {
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: [] as readonly string[],
};

/** 3.15 D.3: the eight rows of this feature that carry an address. */
const ADDRESS_ROUTES: readonly (readonly [string, string, unknown])[] = [
	["POST", "/sign-in/magic-link/request", { email: "someone@example.com" }],
	["POST", "/sign-in/magic-link/redeem", { token: "anything" }],
	["POST", "/email/request-verification", {}],
	["POST", "/email/redeem-verification", { token: "anything" }],
	["POST", "/email/request-change", { newEmail: "someone@example.com" }],
	["POST", "/email/redeem-change", { token: "anything" }],
	["POST", "/password/request-reset", { email: "someone@example.com" }],
	["POST", "/password/redeem-reset", { token: "anything", newPassword: "a long enough one" }],
];

/** 3.15 D.3: the three rows of this feature that exist in every mode. */
const EVERY_MODE_ROUTES: readonly string[] = [
	"/sign-up",
	"/sign-up/passwordless",
	"/password/redeem-reset-with-recovery-code",
];

function call(mount: MountedAuth<IdentityMode>, method: string, path: string, body: unknown) {
	return mount.handler(
		new Request(`https://api.example.com${path}`, {
			method,
			headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

async function mountUsernameOnly(prefix: string): Promise<MountedAuth<"username">> {
	const mount = await mountAuthInMode<"username">(
		prefix,
		{ mode: "username", username: USERNAME_RULES },
		{ recoveryCodes: { count: 10, groupSize: 5 } },
	);
	mounts.push(mount);
	return mount;
}

describe("3.15 D.3: a route a mode does not have does not exist", () => {
	it("answers 404 and not 403 on every address-bearing row in mode username", async () => {
		const mount = await mountUsernameOnly("modeuser");

		const answered = await Promise.all(
			ADDRESS_ROUTES.map(async ([method, path, body]) => {
				const answer = await call(mount, method, path, body);
				return `${path} ${answer.status}`;
			}),
		);

		expect(answered).toStrictEqual(ADDRESS_ROUTES.map(([, path]) => `${path} 404`));
	});

	it("carries none of the eight into the route table in mode username", async () => {
		const mount = await mountUsernameOnly("modeusertable");
		const paths = mount.auth.routes.map((route) => route.path);

		expect(paths.filter((path) => ADDRESS_ROUTES.some(([, row]) => row === path))).toStrictEqual(
			[],
		);
		expect(EVERY_MODE_ROUTES.filter((path) => !paths.includes(path))).toStrictEqual([]);
	});

	it("carries all eleven in mode username_email and in mode email", async () => {
		const usernameEmail = await mountAuthInMode<"username_email">("modeboth", {
			mode: "username_email",
			username: USERNAME_RULES,
		});
		mounts.push(usernameEmail);
		const email = await mountAuthInMode<"email">("modemail", { mode: "email" });
		mounts.push(email);
		const wanted = [...EVERY_MODE_ROUTES, ...ADDRESS_ROUTES.map(([, path]) => path)];

		for (const mount of [usernameEmail, email]) {
			const paths = mount.auth.routes.map((route) => route.path);
			expect(wanted.filter((path) => !paths.includes(path))).toStrictEqual([]);
		}
	});
});
