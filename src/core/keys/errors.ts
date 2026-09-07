export type KeyErrorCode =
	| "root_key_missing"
	| "root_key_too_short"
	| "root_key_malformed"
	| "key_version_out_of_range"
	| "key_version_unknown"
	| "key_material_not_exportable"
	| "ciphertext_malformed"
	| "envelope_malformed"
	| "envelope_algorithm_unsupported";

const KEY_ERROR_MESSAGES: Record<KeyErrorCode, string> = {
	root_key_missing: "no root key is configured for the current key version",
	root_key_too_short: "a configured root key is shorter than 32 bytes",
	root_key_malformed: "a configured root key is not base64url",
	key_version_out_of_range: "a key version is not a positive 32-bit integer",
	key_version_unknown: "the key version is no longer part of the key ring",
	key_material_not_exportable: "the key cannot be exported for the fallback cipher",
	ciphertext_malformed: "the ciphertext is shorter than a nonce and an authentication tag",
	envelope_malformed: "the envelope is too short to carry a header",
	envelope_algorithm_unsupported: "the envelope names an unsupported algorithm",
};

export class KeyError extends Error {
	readonly code: KeyErrorCode;

	// The message is fixed per code so that no key material can reach an error string.
	constructor(code: KeyErrorCode) {
		super(KEY_ERROR_MESSAGES[code]);
		this.name = "KeyError";
		this.code = code;
	}
}
