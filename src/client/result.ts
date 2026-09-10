import { VelveError, type VelveErrorCode } from "../core/http/error-map.js";

export interface VelveFailure<Code extends VelveErrorCode> {
	readonly code: Code;
	readonly message: string;
	/** 3.15 F: only `rate_limited` carries one, so every other code leaves the key absent. */
	readonly retryAfterSeconds?: number;
}

/**
 * 3.15 E's draft B: the compiler makes `ok` checkable before `value` is readable, and `code` is
 * narrowed to the codes of that one route so a `switch` over it is checked exhaustively.
 */
export type VelveResult<Value, Code extends VelveErrorCode> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: VelveFailure<Code> };

/** 3.15 E: the two failures that can carry no code — the server did not answer, or answered with something that is not a Velve response. */
export class VelveTransportError extends Error {
	override readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "VelveTransportError";
		this.cause = cause;
	}
}

/** 3.15 E: the way back to the server's symmetry, for a caller that would rather catch than check. */
export function unwrap<Value, Code extends VelveErrorCode>(
	result: VelveResult<Value, Code>,
): Value {
	if (result.ok) {
		return result.value;
	}
	const { code, retryAfterSeconds } = result.error;
	throw retryAfterSeconds === undefined
		? new VelveError(code)
		: new VelveError(code, { retryAfterSeconds });
}
