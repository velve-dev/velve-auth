const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_VALUE_OF = new Map<string, number>(
	[...BASE64URL_ALPHABET].map((character, value) => [character, value]),
);

// Decoded here rather than through `atob`, which section 2.6 does not list among the runtime assumptions.
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	const unpadded = text.replace(/={1,2}$/, "");
	if (unpadded.length % 4 === 1) {
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

	return bytes;
}
