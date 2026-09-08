const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV4_PREFIX_LENGTH = 24;
/** L-10: the same prefix length the rate limiter forms its IPv6 key on (3.9). */
const IPV6_PREFIX_LENGTH = 64;
const IPV6_PREFIX_BYTES = IPV6_PREFIX_LENGTH / 8;

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function ipv4Bytes(text: string): number[] | null {
	const parts = text.split(".");
	if (parts.length !== IPV4_BYTES) {
		return null;
	}
	const bytes: number[] = [];
	for (const part of parts) {
		if (!IPV4_OCTET.test(part)) {
			return null;
		}
		const value = Number(part);
		if (value > 255) {
			return null;
		}
		bytes.push(value);
	}
	return bytes;
}

function ipv6GroupBytes(text: string): number[] | null {
	if (text === "") {
		return [];
	}
	const parts = text.split(":");
	const bytes: number[] = [];
	for (const [index, part] of parts.entries()) {
		if (index === parts.length - 1 && part.includes(".")) {
			const embedded = ipv4Bytes(part);
			if (embedded === null) {
				return null;
			}
			bytes.push(...embedded);
			continue;
		}
		if (!IPV6_GROUP.test(part)) {
			return null;
		}
		const value = Number.parseInt(part, 16);
		bytes.push(value >> 8, value & 0xff);
	}
	return bytes.length > IPV6_BYTES ? null : bytes;
}

function ipv6Bytes(text: string): number[] | null {
	const [head, tail, surplus] = text.split("::");
	if (surplus !== undefined) {
		return null;
	}
	const leading = ipv6GroupBytes(head ?? "");
	const trailing = tail === undefined ? [] : ipv6GroupBytes(tail);
	if (leading === null || trailing === null) {
		return null;
	}
	if (tail === undefined) {
		return leading.length === IPV6_BYTES ? leading : null;
	}
	const elided = IPV6_BYTES - leading.length - trailing.length;
	return elided < 2 ? null : [...leading, ...Array.from({ length: elided }, () => 0), ...trailing];
}

/** An address a proxy wrote as ::ffff:a.b.c.d is an IPv4 address, and truncating it to /64 would put every IPv4 client in one prefix. */
function unmappedIpv4Bytes(bytes: readonly number[]): number[] | null {
	const prefix = bytes.slice(0, 12);
	const mapped =
		prefix.slice(0, 10).every((byte) => byte === 0) &&
		prefix.slice(10).every((byte) => byte === 255);
	return mapped ? [...bytes.slice(12)] : null;
}

interface IpAddress {
	readonly bytes: readonly number[];
	readonly isIpv4: boolean;
}

function parseIpAddress(text: string): IpAddress | null {
	const trimmed = text.trim();
	const asIpv4 = ipv4Bytes(trimmed);
	if (asIpv4 !== null) {
		return { bytes: asIpv4, isIpv4: true };
	}
	const asIpv6 = ipv6Bytes(trimmed);
	if (asIpv6 === null) {
		return null;
	}
	const unmapped = unmappedIpv4Bytes(asIpv6);
	return unmapped === null ? { bytes: asIpv6, isIpv4: false } : { bytes: unmapped, isIpv4: true };
}

function ipv4Text(bytes: readonly number[]): string {
	return bytes.join(".");
}

interface ZeroRun {
	readonly start: number;
	readonly length: number;
}

function longestZeroRun(groups: readonly number[]): ZeroRun {
	let longest: ZeroRun = { start: -1, length: 0 };
	let start = -1;
	for (const [index, group] of groups.entries()) {
		start = group === 0 && start === -1 ? index : start;
		if (group !== 0) {
			start = -1;
			continue;
		}
		const length = index - start + 1;
		longest = length > longest.length ? { start, length } : longest;
	}
	return longest.length > 1 ? longest : { start: -1, length: 0 };
}

/** RFC 5952, so the text the library computes is the text `inet` gives back. */
function ipv6Text(bytes: readonly number[]): string {
	const groups: number[] = [];
	for (let index = 0; index < bytes.length; index += 2) {
		groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
	}
	const run = longestZeroRun(groups);
	if (run.start === -1) {
		return groups.map((group) => group.toString(16)).join(":");
	}
	const head = groups.slice(0, run.start).map((group) => group.toString(16));
	const tail = groups.slice(run.start + run.length).map((group) => group.toString(16));
	return `${head.join(":")}::${tail.join(":")}`;
}

/** The address as `inet` will hold it, or null if it is not an address at all. */
export function canonicalIpAddress(text: string): string | null {
	const address = parseIpAddress(text);
	if (address === null) {
		return null;
	}
	return address.isIpv4 ? ipv4Text(address.bytes) : ipv6Text(address.bytes);
}

/** L-10: IPv4 to /24 and IPv6 to /64, written as the network so the truncation is visible in the stored value. */
export function truncatedIpAddress(text: string): string | null {
	const address = parseIpAddress(text);
	if (address === null) {
		return null;
	}
	if (address.isIpv4) {
		return `${ipv4Text([...address.bytes.slice(0, 3), 0])}/${IPV4_PREFIX_LENGTH}`;
	}
	const network = [
		...address.bytes.slice(0, IPV6_PREFIX_BYTES),
		...Array.from({ length: IPV6_BYTES - IPV6_PREFIX_BYTES }, () => 0),
	];
	return `${ipv6Text(network)}/${IPV6_PREFIX_LENGTH}`;
}
