import { describe, expect, it } from "vitest";
import {
	type IdentifierRejection,
	identityColumns,
	type ProvidedIdentifiers,
	REQUIRED_IDENTIFIERS,
} from "../src/core/identity/columns.js";
import {
	type IdentityConfiguration,
	resolveIdentityConfiguration,
} from "../src/core/identity/configuration.js";

const email = resolveIdentityConfiguration({ mode: "email" });
const username = resolveIdentityConfiguration({ mode: "username" });
const usernameEmail = resolveIdentityConfiguration({ mode: "username_email" });

function rejectionOf(
	configuration: IdentityConfiguration,
	provided: ProvidedIdentifiers,
): IdentifierRejection | null {
	const outcome = identityColumns(configuration, provided);
	return outcome.accepted ? null : outcome.rejection;
}

describe("identity columns", () => {
	it("names the identifier each configuration insists on", () => {
		expect(REQUIRED_IDENTIFIERS).toEqual({
			email: ["email"],
			username: ["username"],
			username_email: ["email", "username"],
		});
	});

	it("writes both username columns or neither", () => {
		expect(identityColumns(usernameEmail, { email: "A@b.test", username: "Alice" })).toEqual({
			accepted: true,
			value: { email: "a@b.test", username: "Alice", usernameKey: "alice" },
		});
		expect(identityColumns(username, { username: "Alice" })).toEqual({
			accepted: true,
			value: { email: null, username: "Alice", usernameKey: "alice" },
		});
	});

	it("leaves the address NULL where a provider reported none (E-16, S-LINK-5)", () => {
		expect(identityColumns(username, { username: "alice", email: null })).toEqual({
			accepted: true,
			value: { email: null, username: "alice", usernameKey: "alice" },
		});
	});

	it("refuses instead of inventing an address the mode insists on", () => {
		expect(rejectionOf(usernameEmail, { username: "alice", email: null })).toEqual({
			identifier: "email",
			rejection: "required",
		});
		expect(rejectionOf(email, {})).toEqual({ identifier: "email", rejection: "required" });
	});

	it("refuses a username the configuration has no rules for", () => {
		expect(rejectionOf(email, { email: "a@b.test", username: "alice" })).toEqual({
			identifier: "username",
			rejection: "not_configured",
		});
	});

	it("passes the normalisation rejection through under the identifier it belongs to", () => {
		expect(rejectionOf(usernameEmail, { email: "not-an-address", username: "alice" })).toEqual({
			identifier: "email",
			rejection: "malformed",
		});
		expect(rejectionOf(usernameEmail, { email: "a@b.test", username: "al" })).toEqual({
			identifier: "username",
			rejection: "too_short",
		});
	});
});
