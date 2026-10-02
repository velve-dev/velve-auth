import { encodeBase64Url } from "../keys/base64url.js";
import type { KeyProvider } from "../keys/provider.js";
import { type IpAddressPrefixLengths, ipAddressNetwork } from "../net/ip-address.js";

//rotating addresses inside an ipv6 /64 prefix must not buy an attacker a second bucket
const RATE_LIMIT_PREFIX_LENGTHS: IpAddressPrefixLengths = { ipv4: 32, ipv6: 64 };

//an unresolved or rejected address must count on one shared bucket per route (E-384)
const ADDRESS_UNRESOLVED = "unresolved";

//the separator must not occur in an address network or a base64url digest
const FIELD_SEPARATOR = "|";

const utf8 = new TextEncoder();

export function addressBucketKey(routeName: string, ipAddress: string | null): string {
	const network =
		ipAddress === null ? null : ipAddressNetwork(ipAddress, RATE_LIMIT_PREFIX_LENGTHS);
	return ["ip", routeName, network ?? ADDRESS_UNRESOLVED].join(FIELD_SEPARATOR);
}

//an account identifier must never reach the rate bucket table in the clear (S-RATE-7)
export async function accountBucketKey(
	keys: KeyProvider,
	routeName: string,
	normalisedIdentifier: string,
): Promise<string> {
	const pepper = await keys.current("token-pepper");
	const digest = await crypto.subtle.sign("HMAC", pepper.key, utf8.encode(normalisedIdentifier));
	return ["account", routeName, encodeBase64Url(new Uint8Array(digest))].join(FIELD_SEPARATOR);
}
