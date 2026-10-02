//every secret of the library must be drawn here and nowhere else (S-RAND-5)
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}
