import { VelveError } from "./error-map.js";

interface Validator<T> {
	parse(raw: unknown): T;
}

export interface ObjectValidator<T> extends Validator<T> {
	readonly fields: readonly string[];
}

type Parsed<V> = V extends Validator<infer T> ? T : never;

type OptionalKeys<Shape> = {
	[Key in keyof Shape]: undefined extends Parsed<Shape[Key]> ? Key : never;
}[keyof Shape];

/** `exactOptionalPropertyTypes` is on, so an absent field has to be an absent key rather than a key holding undefined. */
type ParsedObject<Shape> = {
	[Key in Exclude<keyof Shape, OptionalKeys<Shape>>]: Parsed<Shape[Key]>;
} & {
	[Key in OptionalKeys<Shape>]?: Exclude<Parsed<Shape[Key]>, undefined>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An inherited property and an array hole are both absent, and a direct server call can pass either. */
function ownValue(source: object, key: string | number): unknown {
	return Object.hasOwn(source, key) ? (source as Record<string | number, unknown>)[key] : undefined;
}

export function string(): Validator<string> {
	return {
		parse: (raw) => {
			if (typeof raw !== "string") {
				throw new VelveError("invalid_input");
			}
			return raw;
		},
	};
}

/** A caller reaching a server method directly passes JavaScript values, so NaN and Infinity arrive where JSON could not carry them. */
export function number(): Validator<number> {
	return {
		parse: (raw) => {
			if (typeof raw !== "number" || !Number.isFinite(raw)) {
				throw new VelveError("invalid_input");
			}
			return raw;
		},
	};
}

export function oneOf<const Values extends readonly [string, ...string[]]>(
	...values: Values
): Validator<Values[number]> {
	return {
		parse: (raw) => {
			const matched = typeof raw === "string" ? values.find((value) => value === raw) : undefined;
			if (matched === undefined) {
				throw new VelveError("invalid_input");
			}
			return matched;
		},
	};
}

export function arrayOf<T>(inner: Validator<T>): Validator<T[]> {
	return {
		parse: (raw) => {
			if (!Array.isArray(raw)) {
				throw new VelveError("invalid_input");
			}
			return Array.from({ length: raw.length }, (_unused, index) =>
				inner.parse(ownValue(raw, index)),
			);
		},
	};
}

/** The WebAuthn extension outputs are open-ended and the library reads none of them (1 D36), so the shape is checked and the contents are not. */
export function unknownRecord(): Validator<Record<string, unknown>> {
	return {
		parse: (raw) => {
			if (!isRecord(raw)) {
				throw new VelveError("invalid_input");
			}
			return raw;
		},
	};
}

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
	return {
		parse: (raw) => (raw === undefined ? undefined : inner.parse(raw)),
	};
}

export function object<Shape extends Record<string, Validator<unknown>>>(
	shape: Shape,
): ObjectValidator<ParsedObject<Shape>> {
	return {
		fields: Object.keys(shape),
		parse: (raw) => {
			if (!isRecord(raw)) {
				throw new VelveError("invalid_input");
			}
			for (const key of Object.keys(raw)) {
				if (!Object.hasOwn(shape, key)) {
					throw new VelveError("invalid_input");
				}
			}
			const parsed: Record<string, unknown> = {};
			for (const [key, validator] of Object.entries(shape)) {
				const value = validator.parse(ownValue(raw, key));
				if (value !== undefined) {
					parsed[key] = value;
				}
			}
			return parsed as ParsedObject<Shape>;
		},
	};
}
