import type { Actor } from "../src/core/db/actor.js";
import type { WebAuthnConfig } from "../src/core/factor/webauthn/config.js";
import {
	createWebAuthnService,
	type WebAuthnService,
} from "../src/core/factor/webauthn/service.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

export const RELYING_PARTY_ID = "example.com";
export const ORIGIN = "https://example.com";

export const TEST_WEBAUTHN_CONFIG: WebAuthnConfig = {
	relyingPartyId: RELYING_PARTY_ID,
	relyingPartyName: "Velve Auth test",
	origins: [ORIGIN],
};

export interface WebAuthnFixture {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly service: WebAuthnService;
	close(): Promise<void>;
}

export async function openWebAuthnFixture(
	prefix: string,
	config: WebAuthnConfig = TEST_WEBAUTHN_CONFIG,
): Promise<WebAuthnFixture> {
	const { connection, schema } = await openMigratedSchema(prefix);
	const service = createWebAuthnService({ driver: connection, schema, webauthn: config });
	return {
		connection,
		schema,
		service,
		async close() {
			await dropSchema(connection, schema);
			await connection.close();
		},
	};
}

export async function createAccount(fixture: WebAuthnFixture): Promise<Actor> {
	const [row] = await fixture.connection.query<{ id: string }>(
		`INSERT INTO ${fixture.schema}.user (email) VALUES ($1) RETURNING id`,
		[`${crypto.randomUUID()}@example.com`],
	);
	if (row === undefined) {
		throw new Error("the account was not created");
	}
	return actorOfTestUser(row.id);
}

export function newAuthenticator(
	options: {
		backupEligible?: boolean;
		backupState?: boolean;
		transports?: readonly string[];
		signCount?: number;
	} = {},
): Promise<VirtualAuthenticator> {
	return createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: ORIGIN,
		...(options.transports === undefined ? {} : { transports: options.transports }),
		...(options.signCount === undefined ? {} : { signCount: options.signCount }),
		flags: {
			...(options.backupEligible === undefined ? {} : { backupEligible: options.backupEligible }),
			...(options.backupState === undefined ? {} : { backupState: options.backupState }),
		},
	});
}

/** Registering is the precondition of nearly every case here, so it is one call rather than
 * four lines repeated. */
export async function enrol(
	fixture: WebAuthnFixture,
	actor: Actor,
	label: string,
	authenticator?: VirtualAuthenticator,
): Promise<{ authenticator: VirtualAuthenticator; credentialId: string }> {
	const device = authenticator ?? (await newAuthenticator());
	const started = await fixture.service.register.start({ actor, userName: "someone" });
	const response = await device.attest({ challenge: started.challengeToken });
	const { credential } = await fixture.service.register.finish({
		actor,
		challengeToken: started.challengeToken,
		response,
		label,
	});
	return { authenticator: device, credentialId: credential.id };
}
