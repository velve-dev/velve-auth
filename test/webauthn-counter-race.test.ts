import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { createWebAuthnCredentialRepository } from "../src/core/factor/webauthn/credential-repository.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { backendPidOf, waitUntilWaitingForALock } from "./lock-order-fixtures.js";
import {
	beginSecondFactor,
	createAccount,
	enrol,
	openWebAuthnFixture,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";
import type { VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * The stored counter is the highest one seen (E-3050). Comparing in the application and writing the
 * winner back would let two assertions that read the same row overwrite each other, so the cases
 * here hand the repository a stale read and hold one write open while the other runs into it.
 */

let fixture: WebAuthnFixture;
let holder: TestConnection;
let observer: TestConnection;

beforeAll(async () => {
	fixture = await openWebAuthnFixture("webauthn_counter_race");
	holder = await openTestConnection();
	observer = await openTestConnection();
}, 120_000);

afterAll(async () => {
	await Promise.all([holder.close(), observer.close()]);
	await fixture.close();
});

async function storedCounterOf(actor: Actor): Promise<number> {
	const [row] = await observer.query<{ sign_count: unknown }>(
		`SELECT sign_count FROM ${fixture.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return Number(row?.sign_count ?? -1);
}

async function signInWith(account: Actor, authenticator: VirtualAuthenticator, signCount: number) {
	const pending = await beginSecondFactor(fixture, account);
	const started = await fixture.service.authenticate.start({ pending });
	return fixture.service.authenticate.finish({
		pending,
		challengeToken: started.challengeToken,
		response: await authenticator.assert({ challenge: started.challengeToken, signCount }),
	});
}

describe("the stored signature counter under assertions that read the same row", () => {
	it("keeps the higher count when the lower one is written from a read taken before it", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");
		await signInWith(account, authenticator, 10);
		const repository = createWebAuthnCredentialRepository({
			driver: fixture.connection,
			schema: fixture.schema,
		});
		const [readByBoth] = await repository.listDescriptorsOwnedBy({ owner: account });
		if (readByBoth === undefined) {
			throw new Error("the credential was not created");
		}

		await repository.recordAssertion({
			verified: readByBoth,
			signCount: 40,
			isBackupEligible: false,
			isCurrentlyBackedUp: false,
		});
		const second = await repository.recordAssertion({
			verified: readByBoth,
			signCount: 3,
			isBackupEligible: false,
			isCurrentlyBackedUp: false,
		});

		expect(readByBoth.signCount).toBe(10);
		expect(await storedCounterOf(account)).toBe(40);
		expect(second?.signCount).toBe(40);
	});

	it("reports a copy whose write waits behind the original's, though both read the same counter", async () => {
		const account = await createAccount(fixture);
		const { authenticator } = await enrol(fixture, account, "key");
		await signInWith(account, authenticator, 10);
		const [readByOriginal] = await createWebAuthnCredentialRepository({
			driver: holder,
			schema: fixture.schema,
		}).listDescriptorsOwnedBy({ owner: account });
		if (readByOriginal === undefined) {
			throw new Error("the credential was not created");
		}
		const pidOfCopy = await backendPidOf(fixture.connection);

		let releaseOriginal = (): void => {};
		const originalMayCommit = new Promise<void>((resolve) => {
			releaseOriginal = resolve;
		});
		let originalHasWritten = (): void => {};
		const originalWrote = new Promise<void>((resolve) => {
			originalHasWritten = resolve;
		});
		const original = holder.transaction(async (tx) => {
			await createWebAuthnCredentialRepository({
				driver: tx,
				schema: fixture.schema,
			}).recordAssertion({
				verified: readByOriginal,
				signCount: 12,
				isBackupEligible: false,
				isCurrentlyBackedUp: false,
			});
			originalHasWritten();
			await originalMayCommit;
		});
		await originalWrote;

		const copy = signInWith(account, authenticator, 11);
		await waitUntilWaitingForALock(observer, pidOfCopy, () => "the copy's sign-in");
		releaseOriginal();
		await original;
		const copied = await copy;

		expect(copied.signCountRegressed).toBe(true);
		expect(copied.userId).toBe(account);
		expect(await storedCounterOf(account)).toBe(12);
	});
});
