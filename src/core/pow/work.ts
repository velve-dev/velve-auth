const NONCE_BYTES = 8;
const LOW_WORD = 0x1_0000_0000;
const utf8 = new TextEncoder();

/** the largest nonce a solution may carry, which is the largest integer JavaScript counts exactly */
export const LARGEST_PROOF_OF_WORK_NONCE = Number.MAX_SAFE_INTEGER;

//the server and the client hash the same bytes only while both build them here (E-3663)
export function proofOfWorkInput(challenge: string, nonce: number): Uint8Array<ArrayBuffer> {
	const challengeBytes = utf8.encode(challenge);
	const input = new Uint8Array(challengeBytes.length + NONCE_BYTES);
	input.set(challengeBytes, 0);
	const nonceView = new DataView(input.buffer, challengeBytes.length, NONCE_BYTES);
	nonceView.setUint32(0, Math.floor(nonce / LOW_WORD));
	nonceView.setUint32(4, nonce % LOW_WORD);
	return input;
}

export function leadingZeroBits(digest: Uint8Array): number {
	let zeroBits = 0;
	for (const byte of digest) {
		if (byte === 0) {
			zeroBits += 8;
			continue;
		}
		return zeroBits + Math.clz32(byte) - 24;
	}
	return zeroBits;
}

export function isSolvedAt(digest: Uint8Array, difficulty: number): boolean {
	return leadingZeroBits(digest) >= difficulty;
}

/** the request header a solution travels in, which the client sets and the handler reads */
export const PROOF_OF_WORK_HEADER = "Velve-Proof-Of-Work";

/** the one written form of a solution, the challenge as handed out followed by its nonce */
export function writtenSolution(challenge: string, nonce: number): string {
	return `${challenge}.${nonce}`;
}
