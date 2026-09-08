import { afterEach, describe, expect, it } from "vitest";
import {
	authenticationResponse,
	isKnownTransport,
	registrationResponse,
} from "../src/core/factor/webauthn/payload.js";
import { clientDataOrigin, userWasVerified } from "../src/core/factor/webauthn/verification.js";
import { VelveError } from "../src/core/http/error-map.js";

const A_REGISTRATION = {
	id: "Y3JlZC1pZA",
	rawId: "Y3JlZC1pZA",
	type: "public-key",
	authenticatorAttachment: "platform",
	clientExtensionResults: { credProps: { rk: true } },
	response: {
		clientDataJSON: "e30",
		attestationObject: "o2NmbXQ",
		transports: ["internal", "hybrid"],
		publicKeyAlgorithm: -7,
		publicKey: "cHVi",
	},
};

const AN_ASSERTION = {
	id: "Y3JlZC1pZA",
	rawId: "Y3JlZC1pZA",
	type: "public-key",
	clientExtensionResults: {},
	response: {
		clientDataJSON: "e30",
		authenticatorData: "YXV0aA",
		signature: "c2ln",
	},
};

function clientDataFor(fields: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

/** The flag byte is authenticator data's fifth: bit 0 user presence, bit 2 user verification,
 * bit 3 backup eligibility, bit 4 backup state. */
function authenticatorDataWithFlags(flags: number): string {
	const data = new Uint8Array(37);
	data[32] = flags;
	return Buffer.from(data).toString("base64url");
}

describe("the user-verification flag", () => {
	it("reads the bit the specification puts it in and no neighbour of it", () => {
		expect(userWasVerified(authenticatorDataWithFlags(0b0000_0100))).toBe(true);
		expect(userWasVerified(authenticatorDataWithFlags(0b0001_1111 & ~0b0000_0100))).toBe(false);
		expect(userWasVerified(authenticatorDataWithFlags(0b0000_0001))).toBe(false);
	});

	it("answers no for authenticator data too short to hold a flag byte", () => {
		expect(userWasVerified(Buffer.alloc(20).toString("base64url"))).toBe(false);
		expect(userWasVerified("not base64url!!")).toBe(false);
	});
});

describe("the credential payload", () => {
	it("accepts what a browser sends for a registration", () => {
		const parsed = registrationResponse().parse(structuredClone(A_REGISTRATION));

		expect(parsed.id).toBe("Y3JlZC1pZA");
		expect(parsed.response.transports).toEqual(["internal", "hybrid"]);
		expect(parsed.clientExtensionResults).toEqual({ credProps: { rk: true } });
	});

	it("accepts what a browser sends for an assertion", () => {
		const parsed = authenticationResponse().parse(structuredClone(AN_ASSERTION));

		expect(parsed.response.signature).toBe("c2ln");
		expect(parsed.response.userHandle).toBeUndefined();
	});

	/**
	 * E-453. `transports` is a hint neither verifier reads for acceptance, so a value shipping in
	 * a browser before `@simplewebauthn/server` types it must not cost the user a registration.
	 */
	it("keeps a transport it has never heard of out of the verifier instead of refusing", () => {
		const parsed = registrationResponse().parse({
			...structuredClone(A_REGISTRATION),
			response: { ...A_REGISTRATION.response, transports: ["quantum-link", "usb"] },
		});

		expect(parsed.response.transports).toEqual(["usb"]);
	});

	it("refuses a credential type it does not know, because that one decides something", () => {
		const wrongType = { ...structuredClone(A_REGISTRATION), type: "public-key-v2" };

		expect(() => registrationResponse().parse(wrongType)).toThrow(VelveError);
	});

	/** E-455: the credential JSON is written by the browser against a living specification. */
	it("ignores a field the browser grew and this library does not read", () => {
		const parsed = registrationResponse().parse({
			...structuredClone(A_REGISTRATION),
			somethingNewInChrome: true,
			response: { ...A_REGISTRATION.response, alsoNew: "yes" },
		});

		expect(parsed.id).toBe("Y3JlZC1pZA");
		expect(Object.hasOwn(parsed, "somethingNewInChrome")).toBe(false);
		expect(Object.hasOwn(parsed.response, "alsoNew")).toBe(false);
	});

	it("refuses a payload that is not a record at all", () => {
		expect(() => registrationResponse().parse("a string")).toThrow(VelveError);
		expect(() => authenticationResponse().parse(null)).toThrow(VelveError);
	});

	it("refuses a payload whose required field holds the wrong type", () => {
		const numericId = { ...structuredClone(A_REGISTRATION), id: 7 };

		expect(() => registrationResponse().parse(numericId)).toThrow(VelveError);
	});
});

/**
 * The prototype chain is a live class here: `object()` and `arrayOf` were both reading inherited
 * properties as if the caller had sent them, and this feature indexes caller-supplied data in
 * three more places — the open object, the transport table and the parsed client data.
 */
describe("reading only what the caller sent", () => {
	afterEach(() => {
		Reflect.deleteProperty(Object.prototype, "origin");
		Reflect.deleteProperty(Object.prototype, "transports");
		Reflect.deleteProperty(Object.prototype, "signature");
	});

	it("does not accept a field that lives only on the prototype", () => {
		const inherited = Object.create({ signature: "c2ln" }) as Record<string, unknown>;
		Object.assign(inherited, {
			clientDataJSON: "e30",
			authenticatorData: "YXV0aA",
		});

		expect(() =>
			authenticationResponse().parse({ ...structuredClone(AN_ASSERTION), response: inherited }),
		).toThrow(VelveError);
	});

	it("does not read a polluted prototype as a transport list the browser sent", () => {
		Object.defineProperty(Object.prototype, "transports", {
			value: ["usb"],
			configurable: true,
			enumerable: false,
		});
		const withoutTransports: Record<string, unknown> = {
			clientDataJSON: "e30",
			attestationObject: "o2NmbXQ",
		};

		const parsed = registrationResponse().parse({
			...structuredClone(A_REGISTRATION),
			response: withoutTransports,
		});

		/* What the parser produced, not what the prototype would answer for it: the returned
		   object is an ordinary literal, so reading the field would find the pollution however
		   well the parser behaved. */
		expect(Object.hasOwn(parsed.response, "transports")).toBe(false);
	});

	it("does not read a polluted prototype as the origin the authenticator signed", () => {
		Object.defineProperty(Object.prototype, "origin", {
			value: "https://example.com",
			configurable: true,
			enumerable: false,
		});

		expect(clientDataOrigin(clientDataFor({ type: "webauthn.get" }))).toBeNull();
	});

	it("reads the origin the client data does carry", () => {
		expect(clientDataOrigin(clientDataFor({ origin: "https://example.com" }))).toBe(
			"https://example.com",
		);
	});

	it("does not answer for an inherited property name when asked about a transport", () => {
		for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
			expect(isKnownTransport(inherited)).toBe(false);
		}
		expect(isKnownTransport("usb")).toBe(true);
	});
});
