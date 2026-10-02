import { type IpAddressPrefixLengths, ipAddressNetwork } from "../net/ip-address.js";

export { canonicalIpAddress } from "../net/ip-address.js";

//sessions keep an ipv4 /24 and an ipv6 /64 while the rate limiter keys on its own prefix
const SESSION_METADATA_PREFIX_LENGTHS: IpAddressPrefixLengths = { ipv4: 24, ipv6: 64 };

//the stored value is written as a network to keep the truncation visible
export function truncatedIpAddress(text: string): string | null {
	return ipAddressNetwork(text, SESSION_METADATA_PREFIX_LENGTHS);
}
