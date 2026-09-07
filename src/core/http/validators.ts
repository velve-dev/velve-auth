import { VelveError } from "./error-map.js";

export interface Validator<T> {
	parse(raw: unknown): T;
}

export interface ObjectValidator<T> extends Validator<T> {
	readonly fields: readonly string[];
}

type Parsed<V> = V extends Validator<infer T> ? T : never;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
	return {
		parse: (raw) => (raw === undefined ? undefined : inner.parse(raw)),
	};
}

export function object<Shape extends Record<string, Validator<unknown>>>(
	shape: Shape,
): ObjectValidator<{ [Key in keyof Shape]: Parsed<Shape[Key]> }> {
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
				parsed[key] = validator.parse(raw[key]);
			}
			return parsed as { [Key in keyof Shape]: Parsed<Shape[Key]> };
		},
	};
}
