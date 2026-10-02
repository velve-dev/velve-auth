declare const entityIdBrand: unique symbol;

/** a row identifier of one table, which neither a token nor another table's id can replace */
export type EntityId<Entity extends string> = string & { readonly [entityIdBrand]: Entity };

export type UserId = EntityId<"user">;
export type SessionId = EntityId<"session">;
export type IdentityId = EntityId<"identity">;
export type WebAuthnCredentialId = EntityId<"webauthn_credential">;

/** the provider half of the provider and subject linking key, and not a `uuid` column */
export type ProviderId = EntityId<"oauth_provider">;

/** brands a string as a row identifier without checking its shape */
export function toEntityId<Entity extends string>(value: string): EntityId<Entity> {
	return value as EntityId<Entity>;
}
