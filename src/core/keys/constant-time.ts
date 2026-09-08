// `crypto.timingSafeEqual` is Node-specific and must not be used (section 2.7).
export function equalsInConstantTime(
	left: Uint8Array<ArrayBuffer>,
	right: Uint8Array<ArrayBuffer>,
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}

	return difference === 0;
}
