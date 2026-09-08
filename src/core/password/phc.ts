import { decodeStandardBase64, encodeStandardBase64 } from "./base64.js";

export interface PhcString {
	readonly id: string;
	readonly version?: number;
	readonly parameters: ReadonlyMap<string, string>;
	readonly salt?: Uint8Array<ArrayBuffer>;
	readonly hash?: Uint8Array<ArrayBuffer>;
}

const FUNCTION_ID = /^[a-z0-9-]{1,32}$/;
const VERSION_FIELD = /^v=(0|[1-9][0-9]{0,9})$/;
const PARAMETER_NAME = /^[a-z0-9-]{1,32}$/;
/** A value may end in base64 padding but may not begin with it, which is what keeps a padded salt
 * from reading as a parameter list (E-160). */
const PARAMETER_VALUE = /^(|[A-Za-z0-9+/._-][A-Za-z0-9+/=._-]*)$/;
const DECIMAL = /^(0|[1-9][0-9]{0,9})$/;
const MAXIMUM_FIELDS = 5;

export function parsePhc(text: string): PhcString | null {
	if (!text.startsWith("$")) {
		return null;
	}

	const fields = text.slice(1).split("$");
	const id = fields[0];
	if (fields.length > MAXIMUM_FIELDS || id === undefined || !FUNCTION_ID.test(id)) {
		return null;
	}

	const rest = fields.slice(1);
	if (rest.includes("")) {
		return null;
	}

	const version = takeVersion(rest);
	const parameters = takeParameters(rest);
	if (parameters === null || rest.length > 2) {
		return null;
	}

	const salt = takeBytes(rest);
	const hash = takeBytes(rest);
	if (salt === null || hash === null || (salt === undefined && hash !== undefined)) {
		return null;
	}

	return {
		id,
		...(version === undefined ? {} : { version }),
		parameters,
		...(salt === undefined ? {} : { salt }),
		...(hash === undefined ? {} : { hash }),
	};
}

export function formatPhc(value: PhcString): string {
	const fields = [value.id];

	if (value.version !== undefined) {
		fields.push(`v=${value.version}`);
	}

	if (value.parameters.size > 0) {
		fields.push([...value.parameters].map(([name, text]) => `${name}=${text}`).join(","));
	}

	if (value.salt !== undefined) {
		fields.push(encodeStandardBase64(value.salt));
	}

	if (value.hash !== undefined) {
		fields.push(encodeStandardBase64(value.hash));
	}

	return `$${fields.join("$")}`;
}

export function integerParameter(value: PhcString, name: string): number | null {
	const parameter = value.parameters.get(name);
	if (parameter === undefined || !DECIMAL.test(parameter)) {
		return null;
	}
	return Number(parameter);
}

export function bytesParameter(value: PhcString, name: string): Uint8Array<ArrayBuffer> | null {
	const parameter = value.parameters.get(name);
	return parameter === undefined ? null : decodeStandardBase64(parameter);
}

function takeVersion(fields: string[]): number | undefined {
	const field = fields[0];
	if (field === undefined || !VERSION_FIELD.test(field)) {
		return undefined;
	}
	fields.shift();
	return Number(field.slice(2));
}

function takeParameters(fields: string[]): ReadonlyMap<string, string> | null {
	const field = fields[0];
	if (field === undefined || !isParameterList(field)) {
		return new Map();
	}
	fields.shift();

	const parameters = new Map<string, string>();
	for (const pair of field.split(",")) {
		const separator = pair.indexOf("=");
		const name = pair.slice(0, separator);
		if (parameters.has(name)) {
			return null;
		}
		parameters.set(name, pair.slice(separator + 1));
	}

	return parameters;
}

/** `undefined` when the field is absent, `null` when it is present but not base64. */
function takeBytes(fields: string[]): Uint8Array<ArrayBuffer> | null | undefined {
	const field = fields.shift();
	return field === undefined ? undefined : decodeStandardBase64(field);
}

// A salt field may carry base64 padding, so `aac=` reads as well as a parameter with an empty
// value and as a salt; requiring one non-empty value settles it for every scheme in 3.3 (E-160).
function isParameterList(field: string): boolean {
	const pairs = field.split(",").map((pair) => {
		const separator = pair.indexOf("=");
		return { name: pair.slice(0, separator), value: pair.slice(separator + 1), separator };
	});

	return (
		pairs.every(
			(pair) =>
				pair.separator > 0 && PARAMETER_NAME.test(pair.name) && PARAMETER_VALUE.test(pair.value),
		) && pairs.some((pair) => pair.value !== "")
	);
}
