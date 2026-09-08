const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const VALUE_OF = new Map<string, number>(
	[...STANDARD_ALPHABET].map((character, value) => [character, value]),
);

// The PHC specification writes salt and hash in the standard alphabet without padding, while an
// imported Firebase parameter arrives padded; decoding accepts both spellings and encoding emits
// only the unpadded one (E-161).
export function decodeStandardBase64(text: string): Uint8Array<ArrayBuffer> | null {
	const unpadded = withoutPadding(text);
	if (unpadded === null || unpadded.length % 4 === 1) {
		return null;
	}

	const bytes = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
	let bitBuffer = 0;
	let bufferedBits = 0;
	let written = 0;

	for (const character of unpadded) {
		const value = VALUE_OF.get(character);
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

export function encodeStandardBase64(bytes: Uint8Array<ArrayBuffer>): string {
	let text = "";
	let bitBuffer = 0;
	let bufferedBits = 0;

	for (const byte of bytes) {
		bitBuffer = (bitBuffer << 8) | byte;
		bufferedBits += 8;
		while (bufferedBits >= 6) {
			bufferedBits -= 6;
			text += STANDARD_ALPHABET[(bitBuffer >> bufferedBits) & 0b11_1111];
		}
	}

	if (bufferedBits > 0) {
		text += STANDARD_ALPHABET[(bitBuffer << (6 - bufferedBits)) & 0b11_1111];
	}

	return text;
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
