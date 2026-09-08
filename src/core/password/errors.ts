export type PasswordConfigurationErrorCode =
	| "argon2id_memory_below_floor"
	| "argon2id_iterations_below_floor"
	| "argon2id_parallelism_below_floor"
	| "minimum_length_below_floor"
	| "maximum_length_above_ceiling"
	| "maximum_length_below_minimum_length"
	| "maximum_length_not_an_integer"
	| "concurrent_hash_limit_out_of_range"
	| "legacy_scheme_unknown";

const MESSAGES: Record<PasswordConfigurationErrorCode, string> = {
	argon2id_memory_below_floor: "password.argon2id.memoryKiB is below the floor of 19456",
	argon2id_iterations_below_floor: "password.argon2id.iterations is below the floor of 2",
	argon2id_parallelism_below_floor: "password.argon2id.parallelism is below the floor of 1",
	minimum_length_below_floor: "password.minimumLength is below the floor of 8",
	maximum_length_above_ceiling: "password.maximumLengthInBytes is above the ceiling of 4096",
	maximum_length_below_minimum_length:
		"password.maximumLengthInBytes is below password.minimumLength",
	maximum_length_not_an_integer: "password.maximumLengthInBytes is not a whole number of bytes",
	concurrent_hash_limit_out_of_range: "password.concurrentHashLimit is not a positive integer",
	legacy_scheme_unknown: "password.acceptLegacy names a scheme the switch does not know",
};

// S-DEFAULT-6: a weaker parameter is a start error, so this is thrown while the instance is being
// built and never while a request is being answered.
export class PasswordConfigurationError extends Error {
	readonly code: PasswordConfigurationErrorCode;

	constructor(code: PasswordConfigurationErrorCode) {
		super(MESSAGES[code]);
		this.name = "PasswordConfigurationError";
		this.code = code;
	}
}

export type CredentialWriteErrorCode =
	| "scheme_does_not_match_credential"
	| "credential_not_written";

const CREDENTIAL_WRITE_MESSAGES: Record<CredentialWriteErrorCode, string> = {
	scheme_does_not_match_credential:
		"the scheme column and the identifier of the credential name different functions",
	credential_not_written: "the credential write changed no row",
};

// E-177 holds the column and the credential to the same function at verification time; this is the
// same agreement as a precondition for writing, so a row that could never verify is never stored.
// `credential_not_written` is the other half: a conflict predicate that is false does not raise,
// it silently changes nothing (E-187).
export class CredentialWriteError extends Error {
	readonly code: CredentialWriteErrorCode;

	constructor(code: CredentialWriteErrorCode) {
		super(CREDENTIAL_WRITE_MESSAGES[code]);
		this.name = "CredentialWriteError";
		this.code = code;
	}
}
