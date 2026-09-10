import type { Driver } from "../src/core/db/driver.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";

/** Assembling an instance asks the database nothing, and a route that would ask answers `internal_error` rather than a miss. */
const NO_DATABASE: Driver = {
	query: () => Promise.reject(new Error("this test mounts no database")),
	transaction: () => Promise.reject(new Error("this test mounts no database")),
};

/**
 * The widest configuration there is: `username_email` serves the username routes and the address
 * routes at once, and the OAuth rows exist whether or not a provider is configured. A row the
 * client offers that this instance does not serve is a row the library never serves.
 */
export function widestVelveAuth(): VelveAuth<"username_email"> {
	return createVelveAuth<"username_email">({
		identity: { mode: "username_email" },
		database: NO_DATABASE,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		email: { send: () => Promise.resolve() },
		oauth: {
			providers: { github: { clientId: "id", clientSecret: "secret" } },
			callbackBaseUrl: `${TEST_ORIGIN}/api/auth/sign-in/oauth/callback`,
			trustedProviders: [],
		},
		// A.2: without this the nine webauthn and passkey rows are not served, and the widest
		// configuration is what the client table is compared against (E-1242).
		webauthn: {
			relyingPartyId: "app.example.com",
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
	});
}
