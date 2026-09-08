declare const entityIdBrand: unique symbol;

/**
 * S-RAND-6: a database key is not a secret. `SecretToken` closes one direction — an account
 * identifier cannot arrive where a token belongs — and this closes the other: a token cannot
 * arrive where a row identifier belongs, and neither can the identifier of a different table.
 */
export type EntityId<Entity extends string> = string & { readonly [entityIdBrand]: Entity };

export type UserId = EntityId<"user">;
export type SessionId = EntityId<"session">;
export type IdentityId = EntityId<"identity">;
export type WebAuthnCredentialId = EntityId<"webauthn_credential">;

/** The other half of the `(provider, subject)` linking key of 3.10, and not a `uuid` column. */
export type ProviderId = EntityId<"oauth_provider">;

/** Unchecked for the reason E-260 gives: a rejected shape is a second answer beside "no row". */
export function toEntityId<Entity extends string>(value: string): EntityId<Entity> {
	return value as EntityId<Entity>;
}
