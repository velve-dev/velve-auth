import type { IdentityMode } from "../db/migrations/identity-mode.js";
import { KEY_PURPOSES, type KeyProvider } from "../keys/index.js";
import type { BaseConfig } from "./config.js";

type StartupErrorCode =
	| "keys_missing"
	| "keys_unusable"
	| "origins_empty"
	| "email_callback_missing"
	| "recovery_codes_required";

const MESSAGE_BY_STARTUP_ERROR_CODE: Readonly<Record<StartupErrorCode, string>> = {
	keys_missing: "keys is required: the six purpose keys are derived from a root key of 32 bytes",
	keys_unusable: "keys did not answer for every purpose, so no protected value could be written",
	origins_empty:
		"origins must name at least one allowed origin; an empty list is not a blanket permission",
	email_callback_missing:
		'email.send is required in the identity modes "email" and "username_email"',
	recovery_codes_required:
		'identity.mode "username" requires recoveryCodes: without an address there is no other way back into an account',
};

export class VelveStartupError extends Error {
	readonly code: StartupErrorCode;

	constructor(code: StartupErrorCode) {
		super(MESSAGE_BY_STARTUP_ERROR_CODE[code]);
		this.name = "VelveStartupError";
		this.code = code;
	}
}

function looksLikeKeyProvider(keys: unknown): keys is KeyProvider {
	return (
		typeof keys === "object" &&
		keys !== null &&
		typeof (keys as KeyProvider).current === "function" &&
		typeof (keys as KeyProvider).byVersion === "function"
	);
}

/** S-KEY-6: a missing `keys` field refuses the start, exactly as a root key below 32 bytes does. */
function assertKeysArePresent(keys: unknown): asserts keys is KeyProvider {
	if (!looksLikeKeyProvider(keys)) {
		throw new VelveStartupError("keys_missing");
	}
}

function assertOriginsAreNamed(origins: readonly string[] | undefined): void {
	if (origins === undefined || origins.length === 0) {
		throw new VelveStartupError("origins_empty");
	}
}

/** S-DEFAULT-4, E-207: the runtime half of `RecoveryCodesRequirement`, for callers from JavaScript. */
function assertRecoveryCodesWhereTheyAreTheOnlyWayBack(
	mode: IdentityMode,
	recoveryCodes: unknown,
): void {
	if (mode === "username" && recoveryCodes === undefined) {
		throw new VelveStartupError("recovery_codes_required");
	}
}

function assertEmailCallbackWhereAddressesExist(mode: IdentityMode, email: unknown): void {
	if (mode !== "username" && email === undefined) {
		throw new VelveStartupError("email_callback_missing");
	}
}

/**
 * The synchronous half of the start, run while `createVelveAuth` builds the instance. What needs
 * the database — the stored key versions of E-179 — cannot run here, because the interface of 3.15
 * B is synchronous; `migrate` carries it.
 */
export function assertConfigurationIsStartable<M extends IdentityMode>(
	config: BaseConfig<M> & { readonly recoveryCodes?: unknown },
): void {
	assertKeysArePresent(config.keys);
	assertOriginsAreNamed(config.origins);
	assertRecoveryCodesWhereTheyAreTheOnlyWayBack(config.identity.mode, config.recoveryCodes);
	assertEmailCallbackWhereAddressesExist(config.identity.mode, config.email);
}

/** S-KEY-6, second half: a provider that answers for no purpose protects nothing. */
export async function assertKeysAnswerForEveryPurpose(keys: KeyProvider): Promise<void> {
	for (const purpose of KEY_PURPOSES) {
		const current = await keys.current(purpose).catch(() => null);
		if (current === null || !Number.isInteger(current.version) || current.version < 1) {
			throw new VelveStartupError("keys_unusable");
		}
	}
}
