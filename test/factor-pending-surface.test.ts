import { describe, expectTypeOf, it } from "vitest";
import type { Actor, ResolvedSession } from "../src/core/db/actor.js";
import type {
	ConsumedPendingAuthentication,
	CountedAttempt,
	FailedAttempt,
	IssuedPendingAuthentication,
	PendingAuthenticationInsert,
	PendingAuthenticationRepository,
	PendingAuthenticationRepositoryOptions,
	PendingAuthenticationService,
	PendingAuthenticationServiceOptions,
	PendingAuthenticationWithOwner,
	PendingCallerRoute,
	PendingResolution,
	PendingToken,
	RemovedPendingAuthentication,
	SecondFactor,
	StoredPendingAuthentication,
} from "../src/core/factor/pending/index.js";
import type { SessionToken } from "../src/core/session/token.js";

/**
 * The barrel is what `factor-totp` and `factor-webauthn` consume, so every name it publishes is
 * pinned here. E-201 set the precedent: a type nothing in `src/` annotates yet is named in a test
 * rather than withheld, because withholding it means digging it out again at the call site.
 */
describe("the surface the pending module publishes", () => {
	it("keeps the pending token and the session token apart (S-RAND-6, S-FIX-4)", () => {
		expectTypeOf<PendingToken>().toExtend<string>();
		expectTypeOf<SessionToken>().not.toExtend<PendingToken>();
		expectTypeOf<PendingToken>().not.toExtend<SessionToken>();
	});

	/** S-FIX-4: the intermediate state must not be able to become a session, so it mints no actor. */
	it("hands out nothing an owner-scoped repository method would accept", () => {
		expectTypeOf<PendingResolution>().not.toExtend<ResolvedSession>();
		expectTypeOf<PendingResolution["userId"]>().not.toExtend<Actor>();
		expectTypeOf<ConsumedPendingAuthentication["userId"]>().not.toExtend<Actor>();
	});

	it("offers only the three factors a pending state can be finished with", () => {
		expectTypeOf<SecondFactor>().toEqualTypeOf<"totp" | "webauthn" | "recovery">();
		expectTypeOf<PendingCallerRoute>().toEqualTypeOf<
			| "factor.totp.verify"
			| "factor.webauthn.authenticate.start"
			| "factor.webauthn.authenticate.finish"
			| "factor.recovery.verify"
		>();
	});

	it("separates the outcome of a failed attempt from a count nobody has to interpret", () => {
		expectTypeOf<FailedAttempt>().toExtend<{ outcome: "attempts_remain" | "exhausted" }>();
		expectTypeOf<CountedAttempt>().toEqualTypeOf<{
			readonly attempts: number;
			readonly exhausted: boolean;
		}>();
	});

	it("carries the same option shape the session service takes, and no clock (E-247)", () => {
		expectTypeOf<PendingAuthenticationServiceOptions>().toHaveProperty("driver");
		expectTypeOf<keyof PendingAuthenticationServiceOptions>().toEqualTypeOf<"driver" | "schema">();
		expectTypeOf<keyof PendingAuthenticationRepositoryOptions>().toEqualTypeOf<
			"driver" | "schema"
		>();
	});

	it("publishes the repository and service contracts the factor features build against", () => {
		expectTypeOf<PendingAuthenticationService["begin"]>().toBeFunction();
		expectTypeOf<PendingAuthenticationRepository["countFailedAttempt"]>().toBeFunction();
		expectTypeOf<PendingAuthenticationInsert["lifetimeInSeconds"]>().toBeNumber();
		expectTypeOf<PendingAuthenticationWithOwner["availableFactors"]>().toEqualTypeOf<
			readonly SecondFactor[]
		>();
		expectTypeOf<StoredPendingAuthentication["attempts"]>().toBeNumber();
		expectTypeOf<RemovedPendingAuthentication["userId"]>().toBeString();
		expectTypeOf<IssuedPendingAuthentication["token"]>().toEqualTypeOf<PendingToken>();
	});
});
