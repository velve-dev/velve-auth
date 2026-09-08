import {
	canonicalIpAddress,
	type IpAddressPrefixLengths,
	ipAddressNetwork,
} from "../net/ip-address.js";

const WHOLE_ADDRESS: IpAddressPrefixLengths = { ipv4: 32, ipv6: 128 };
const PREFIX_LENGTH = /^\d{1,3}$/;

interface TrustedRange {
	readonly prefixLengths: IpAddressPrefixLengths;
	readonly network: string;
}

function trustedRange(entry: string): TrustedRange | null {
	const separator = entry.lastIndexOf("/");
	if (separator === -1) {
		const network = ipAddressNetwork(entry, WHOLE_ADDRESS);
		return network === null ? null : { prefixLengths: WHOLE_ADDRESS, network };
	}

	const base = entry.slice(0, separator);
	const written = entry.slice(separator + 1);
	const canonical = canonicalIpAddress(base);
	if (canonical === null || !PREFIX_LENGTH.test(written)) {
		return null;
	}

	const prefixLength = Number(written);
	const widest = canonical.includes(":") ? WHOLE_ADDRESS.ipv6 : WHOLE_ADDRESS.ipv4;
	if (prefixLength > widest) {
		return null;
	}

	const prefixLengths: IpAddressPrefixLengths = { ipv4: prefixLength, ipv6: prefixLength };
	const network = ipAddressNetwork(base, prefixLengths);
	return network === null ? null : { prefixLengths, network };
}

/** An entry that does not parse matches nothing, so a mistyped proxy list falls back to the
 * connection address rather than trusting a header it cannot check (S-RATE-3). */
function isTrustedProxy(address: string, trustedProxies: readonly string[]): boolean {
	return trustedProxies.some((entry) => {
		const range = trustedRange(entry);
		return range !== null && ipAddressNetwork(address, range.prefixLengths) === range.network;
	});
}

function claimedAddresses(forwardedFor: string | null): readonly string[] {
	return (forwardedFor ?? "")
		.split(",")
		.map((claimed) => claimed.trim())
		.filter((claimed) => claimed !== "");
}

/**
 * S-RATE-3: `X-Forwarded-For` is read only where `trustedProxies` says who may write it. With an
 * empty list, or a connection from an address the list does not cover, the header cannot move the
 * bucket. Where the connection is from a trusted proxy, the answer is the rightmost claimed
 * address that is not itself a trusted proxy — the last hop no trusted party vouched for.
 */
export function resolveClientAddress(
	connectionAddress: string | null,
	forwardedFor: string | null,
	trustedProxies: readonly string[],
): string | null {
	if (connectionAddress === null || trustedProxies.length === 0) {
		return connectionAddress;
	}
	if (!isTrustedProxy(connectionAddress, trustedProxies)) {
		return connectionAddress;
	}

	const claimed = claimedAddresses(forwardedFor);
	for (let hop = claimed.length - 1; hop >= 0; hop -= 1) {
		const address = claimed[hop] ?? "";
		if (!isTrustedProxy(address, trustedProxies)) {
			return address;
		}
	}
	return connectionAddress;
}
