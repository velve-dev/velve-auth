import { VelveError, type VelveErrorCode } from "../core/http/error-map.js";

export interface VelveFailure<Code extends VelveErrorCode> {
	readonly code: Code;
	readonly message: string;
	/** present only on `rate_limited` and absent for every other code */
	readonly retryAfterSeconds?: number;
}

/** a result whose `ok` is checked before `value` is readable, with `code` narrowed to the route */
export type VelveResult<Value, Code extends VelveErrorCode> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: VelveFailure<Code> };

/** a failure with no code, where the server did not answer or gave no Velve response */
export class VelveTransportError extends Error {
	override readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "VelveTransportError";
		this.cause = cause;
	}
}

/** returns the value or throws, for a caller that would rather catch than check */
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
