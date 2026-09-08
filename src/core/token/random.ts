// S-RAND-1 and S-RAND-5: every secret of the library is drawn here and nowhere else.
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}
