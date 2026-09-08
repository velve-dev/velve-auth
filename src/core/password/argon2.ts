import { argon2dAsync, argon2iAsync, argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "../keys/index.js";
import {
	ARGON2ID_HASH_BYTES,
	ARGON2ID_SALT_BYTES,
	ARGON2ID_VERSION,
	type Argon2idParameters,
} from "./config.js";
import { formatPhc } from "./phc.js";
import { asDerivedKey, type DerivedKey } from "./secret.js";

export type Argon2Variant = "argon2id" | "argon2i" | "argon2d";

export interface Argon2Request {
	readonly variant: Argon2Variant;
	readonly password: Uint8Array<ArrayBuffer>;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly memoryKiB: number;
	readonly iterations: number;
	readonly parallelism: number;
	readonly version: number;
	readonly hashBytes: number;
}

export interface Argon2Engine {
	readonly name: "noble" | "hash-wasm";
	derive(request: Argon2Request): Promise<DerivedKey>;
}

interface AcceleratorOptions {
	password: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
	parallelism: number;
	memorySize: number;
	iterations: number;
	hashLength: number;
	outputType: "binary";
}

type AcceleratorFunction = (options: AcceleratorOptions) => Promise<Uint8Array>;

interface Accelerator {
	argon2id: AcceleratorFunction;
	argon2i: AcceleratorFunction;
	argon2d: AcceleratorFunction;
}

// 2.7 fixes the tick for the pure path; it is what returns control to the host every 10 ms during
// a 90 ms derivation, so a timer that comes due meanwhile still fires.
const ASYNC_TICK_IN_MILLISECONDS = 10;

// A `Map` for the same reason the switch uses one: no lookup in this module reads a name off
// `Object.prototype` (E-178).
const NOBLE_BY_VARIANT = new Map<Argon2Variant, typeof argon2idAsync>([
	["argon2id", argon2idAsync],
	["argon2i", argon2iAsync],
	["argon2d", argon2dAsync],
]);

export const nobleArgon2: Argon2Engine = {
	name: "noble",

	async derive(request) {
		const derive = NOBLE_BY_VARIANT.get(request.variant) ?? argon2idAsync;

		return asDerivedKey(
			await derive(request.password, request.salt, {
				m: request.memoryKiB,
				t: request.iterations,
				p: request.parallelism,
				version: request.version,
				dkLen: request.hashBytes,
				asyncTick: ASYNC_TICK_IN_MILLISECONDS,
			}),
		);
	},
};

/**
 * The accelerator computes in one synchronous WebAssembly call and settles in a microtask, so a
 * chain of derivations never reaches the timer phase and S-DOS-4's wait limit never fires — the
 * flood is served in full and no timer in the process runs meanwhile. One `setTimeout` turn per
 * derivation restores the property the pure path gets from `asyncTick`. `scheduler.yield` would
 * not do: it returns to a continuation queue, and what has to run here is the timer phase (E-186).
 */
function yieldToTimerPhase(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function acceleratedArgon2(accelerator: Accelerator): Argon2Engine {
	return {
		name: "hash-wasm",

		async derive(request) {
			await yieldToTimerPhase();
			const derive = accelerator[request.variant];

			return asDerivedKey(
				new Uint8Array(
					await derive({
						password: request.password,
						salt: request.salt,
						parallelism: request.parallelism,
						memorySize: request.memoryKiB,
						iterations: request.iterations,
						hashLength: request.hashBytes,
						outputType: "binary",
					}),
				),
			);
		},
	};
}

let acceleratorLoad: Promise<Argon2Engine | null> | undefined;

/**
 * `hash-wasm` is an optional peer dependency and an accelerator only (repository rules §7). Its
 * output is byte-identical to `@noble/hashes` at version 0x13, so its presence or absence changes
 * nothing but the running time (S-DEFAULT-7) — except at version 0x10, which it silently computes
 * as 0x13; that version therefore stays on the pure path (E-168).
 */
export async function selectArgon2Engine(version: number): Promise<Argon2Engine> {
	if (version !== ARGON2ID_VERSION) {
		return nobleArgon2;
	}

	acceleratorLoad ??= loadAccelerator();
	return (await acceleratorLoad) ?? nobleArgon2;
}

export async function deriveArgon2(request: Argon2Request): Promise<DerivedKey> {
	const engine = await selectArgon2Engine(request.version);
	return engine.derive(request);
}

/** S-REST-7: what the library creates carries exactly the configured parameters. */
export async function createArgon2idHash(
	password: Uint8Array<ArrayBuffer>,
	parameters: Argon2idParameters,
): Promise<string> {
	const salt = randomBytes(ARGON2ID_SALT_BYTES);
	const hash = await deriveArgon2({
		variant: "argon2id",
		password,
		salt,
		memoryKiB: parameters.memoryKiB,
		iterations: parameters.iterations,
		parallelism: parameters.parallelism,
		version: ARGON2ID_VERSION,
		hashBytes: ARGON2ID_HASH_BYTES,
	});

	return formatPhc({
		id: "argon2id",
		version: ARGON2ID_VERSION,
		parameters: new Map([
			["m", String(parameters.memoryKiB)],
			["t", String(parameters.iterations)],
			["p", String(parameters.parallelism)],
		]),
		salt,
		hash,
	});
}

async function loadAccelerator(): Promise<Argon2Engine | null> {
	try {
		// A literal, so a dependency audit can see that an advisory against this package reaches
		// this line; the dead-code check exempts it by name instead (E-180).
		const loaded: unknown = await import("hash-wasm");
		return isAccelerator(loaded) ? acceleratedArgon2(loaded) : null;
	} catch {
		return null;
	}
}

function isAccelerator(loaded: unknown): loaded is Accelerator {
	if (typeof loaded !== "object" || loaded === null) {
		return false;
	}

	// `Object.hasOwn` before reading, so a name answered by the prototype never passes for one the
	// accelerator actually exports (E-178).
	const candidate = loaded as Record<string, unknown>;
	return (["argon2id", "argon2i", "argon2d"] as const).every(
		(name) => Object.hasOwn(candidate, name) && typeof candidate[name] === "function",
	);
}
