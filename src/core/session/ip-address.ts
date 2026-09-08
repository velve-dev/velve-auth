import { type IpAddressPrefixLengths, ipAddressNetwork } from "../net/ip-address.js";

export { canonicalIpAddress } from "../net/ip-address.js";

/** L-10: IPv4 to /24 and IPv6 to /64 — the rate limiter forms its own key on its own prefix lengths (3.9). */
const SESSION_METADATA_PREFIX_LENGTHS: IpAddressPrefixLengths = { ipv4: 24, ipv6: 64 };

/** L-10: written as the network so the truncation is visible in the stored value. */
export function truncatedIpAddress(text: string): string | null {
	return ipAddressNetwork(text, SESSION_METADATA_PREFIX_LENGTHS);
}
