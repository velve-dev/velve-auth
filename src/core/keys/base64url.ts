const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_VALUE_OF = new Map<string, number>(
	[...BASE64URL_ALPHABET].map((character, value) => [character, value]),
);

//base64url is encoded by hand as btoa is not a runtime assumption (E-62)
export function encodeBase64Url(bytes: Uint8Array): string {
	let text = "";
	let bitBuffer = 0;
	let bufferedBits = 0;

	for (const byte of bytes) {
		bitBuffer = (bitBuffer << 8) | byte;
		bufferedBits += 8;
		while (bufferedBits >= 6) {
			bufferedBits -= 6;
			text += BASE64URL_ALPHABET.charAt((bitBuffer >> bufferedBits) & 0b11_1111);
		}
	}

	if (bufferedBits > 0) {
		text += BASE64URL_ALPHABET.charAt((bitBuffer << (6 - bufferedBits)) & 0b11_1111);
	}

	return text;
}

//only the canonical spelling decodes so a mistyped root key is rejected (E-67)
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	const unpadded = withoutPadding(text);
	if (unpadded === null || unpadded.length % 4 === 1) {
		return null;
	}

	const bytes = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
	let bitBuffer = 0;
	let bufferedBits = 0;
	let written = 0;

	for (const character of unpadded) {
		const value = BASE64URL_VALUE_OF.get(character);
		if (value === undefined) {
			return null;
		}

		bitBuffer = (bitBuffer << 6) | value;
		bufferedBits += 6;
		if (bufferedBits >= 8) {
			bufferedBits -= 8;
			bytes[written] = (bitBuffer >> bufferedBits) & 0xff;
			written += 1;
		}
	}

	if (bufferedBits > 0 && (bitBuffer & ((1 << bufferedBits) - 1)) !== 0) {
		return null;
	}

	return bytes;
}

function withoutPadding(text: string): string | null {
	const paddingStart = text.indexOf("=");
	if (paddingStart === -1) {
		return text;
	}

	const padding = text.slice(paddingStart);
	if (text.length % 4 !== 0 || (padding !== "=" && padding !== "==")) {
		return null;
	}

	return text.slice(0, paddingStart);
}
