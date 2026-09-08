const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_VALUE_OF = new Map<string, number>(
	[...BASE64URL_ALPHABET].map((character, value) => [character, value]),
);

// Decoded here rather than through `atob`, which section 2.6 does not list among the runtime
// assumptions. Only the canonical spelling is accepted, so a mistyped root key is rejected instead
// of silently decoding to the same bytes as the correct one.
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
