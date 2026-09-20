/**
 * The acceptance case the report asks for runs against a real provider rather than a stub: Dex,
 * in a container, signing its own id tokens and serving its own JWKS. What a stub cannot show is
 * that the code exchange, the PKCE verifier and the signature verification all hold against an
 * implementation this repository did not write (E-1903).
 */
/**
 * Dex claims an `https` issuer and serves plain HTTP on loopback. `S-REDIR-6` requires every
 * endpoint the server calls itself to be `https`, and that requirement is not weakened for a test:
 * the configuration this case hands the library is `https` throughout and the check passes for the
 * reason it exists. What the harness does instead is route that one origin to the container
 * through `config.fetch` — the documented seam an operator uses to see or refuse every outbound
 * request. **The provider is real; the transport to loopback is not**, and TLS to a container on
 * 127.0.0.1 would prove nothing about this library either way (E-1904).
 */
export const DEX_ISSUER = "https://127.0.0.1:5556/dex";
const DEX_ON_THE_WIRE = "http://127.0.0.1:5556";
export const DEX_CALLBACK_BASE = "https://127.0.0.1:9099/sign-in/oauth/callback";
export const DEX_CLIENT_ID = "velve-test-client";
export const DEX_CLIENT_SECRET = "velve-test-secret";
const DEX_LOGIN = "newcomer@example.com";
const DEX_PASSWORD = "password";

class DexUnreachableError extends Error {
	constructor(cause: string) {
		super(
			`Dex is not answering at ${DEX_ISSUER}. The acceptance case needs a real provider and refuses to pass without one — start it with\n  docker run -d --name velve-dex -p 5556:5556 -v "$PWD/test/dex/config.yaml:/etc/dex/config.yaml" dexidp/dex:v2.44.0 dex serve /etc/dex/config.yaml\n${cause}`,
		);
		this.name = "DexUnreachableError";
	}
}

export async function assertDexIsUp(): Promise<void> {
	const answer = await fetch(`${DEX_ON_THE_WIRE}/dex/.well-known/openid-configuration`).catch(
		(cause: unknown) => new DexUnreachableError(String(cause)),
	);
	if (answer instanceof Error) {
		throw answer;
	}
	if (!answer.ok) {
		throw new DexUnreachableError(`it answered ${answer.status}`);
	}
}

/** The one origin the harness rewrites, and nothing else. */
function onTheWire(url: string): string {
	return url.startsWith(DEX_ISSUER.slice(0, -4))
		? url.replace("https://127.0.0.1:5556", DEX_ON_THE_WIRE)
		: url;
}

/** What the library is given as its `fetch`: every request except Dex's own origin is untouched. */
export const fetchReachingDex: typeof globalThis.fetch = (input, init) =>
	globalThis.fetch(
		typeof input === "string"
			? onTheWire(input)
			: input instanceof URL
				? onTheWire(input.href)
				: input,
		init,
	);

const FORM_ACTION = /action="(\/dex\/auth\/local\/login\?back=&amp;state=[^"]*)"/;

/**
 * Signs the fixture person in at Dex and returns the callback URL Dex redirects to, carrying a
 * real authorization code. Two requests: the login form, then the credentials.
 */
export async function authorizeAtDex(authorizationUrl: string): Promise<URL> {
	const form = await fetch(onTheWire(authorizationUrl), { redirect: "follow" });
	const action = FORM_ACTION.exec(await form.text())?.[1];
	if (action === undefined) {
		throw new Error("Dex served no login form; its login page has changed shape");
	}
	const submitted = await fetch(`${DEX_ON_THE_WIRE}${action.replaceAll("&amp;", "&")}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ login: DEX_LOGIN, password: DEX_PASSWORD }),
		redirect: "manual",
	});
	const location = submitted.headers.get("location");
	if (location === null) {
		throw new Error(`Dex refused the fixture credentials: ${submitted.status}`);
	}
	return new URL(location);
}
