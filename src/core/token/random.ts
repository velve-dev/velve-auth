//every secret of the library must be drawn here and nowhere else (S-RAND-5)
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}

/** a version 4 uuid drawn from the same generator, for an identifier no row may carry */
export function randomUuid(): string {
	return crypto.randomUUID();
}
