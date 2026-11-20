import type { Migration } from "../migration.js";

export const verifiedAttestationSchema: Migration = {
	version: 8,
	name: "verified_attestation",
	sql: `/* An account can be limited to authenticators whose attestation verified against roots the
   application configures (section 3.18, S-INTEG-13). allowed_aaguids holds the list while one is
   set and is null otherwise; attestation_verified records, next to the AAGUID a registration
   already stored, whether the attestation chain verified, and only a credential that names its
   model can carry it. The seal covers the list and the AAGUID of every attested credential
   (S-INTEG-2), so a writer without the root key can neither add an AAGUID, remove the list nor
   flip a flag. Adding a nullable column and a column with a default rewrites no row, and an
   account without a list or an attested credential keeps the seal it had, so nobody is signed
   out and no pending state ends. */
ALTER TABLE velve.user
  ADD COLUMN allowed_aaguids uuid[]
    CONSTRAINT user_allowed_aaguids_not_empty CHECK (cardinality(allowed_aaguids) > 0);

ALTER TABLE velve.webauthn_credential
  ADD COLUMN attestation_verified boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT webauthn_credential_attestation_names_its_model
    CHECK (NOT attestation_verified OR aaguid IS NOT NULL);

ALTER TABLE velve.passkey_recovery
  ADD COLUMN attestation_verified boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT passkey_recovery_attestation_names_its_model
    CHECK (NOT attestation_verified OR aaguid IS NOT NULL);
`,
};
