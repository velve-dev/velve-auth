import { encodeBase64Url } from "../keys/base64url.js";
import type { KeyProvider } from "../keys/provider.js";
import { type IpAddressPrefixLengths, ipAddressNetwork } from "../net/ip-address.js";

/** 3.9: IPv6 counts on its `/64` prefix and IPv4 on the whole address, so rotating inside a
 * prefix does not buy an attacker a second bucket (CVE-2026-45364). */
const RATE_LIMIT_PREFIX_LENGTHS: IpAddressPrefixLengths = { ipv4: 32, ipv6: 64 };

/** S-RATE-4: a request whose address cannot be resolved counts on one shared bucket per route
 * instead of escaping the count. */
const ADDRESS_UNRESOLVED = "unresolved";

/** Neither an address network nor a base64url digest contains it, so the last field of a key is
 * unambiguous however a route is named. */
const FIELD_SEPARATOR = "|";

const utf8 = new TextEncoder();

export function addressBucketKey(routeName: string, ipAddress: string | null): string {
	const network =
		ipAddress === null ? null : ipAddressNetwork(ipAddress, RATE_LIMIT_PREFIX_LENGTHS);
	return ["ip", routeName, network ?? ADDRESS_UNRESOLVED].join(FIELD_SEPARATOR);
}

/** S-RATE-7: the account counter is keyed by `HMAC(token-pepper, normalised identifier)`, so an
 * identifier never reaches `velve.rate_bucket` in the clear (L-5). */
export async function accountBucketKey(
	keys: KeyProvider,
	routeName: string,
	normalisedIdentifier: string,
): Promise<string> {
	const pepper = await keys.current("token-pepper");
	const digest = await crypto.subtle.sign("HMAC", pepper.key, utf8.encode(normalisedIdentifier));
	return ["account", routeName, encodeBase64Url(new Uint8Array(digest))].join(FIELD_SEPARATOR);
}
