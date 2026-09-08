import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import {
	arrayOf,
	number,
	object,
	oneOf,
	optional,
	string,
	unknownRecord,
} from "../src/core/http/validators.js";

const credentials = object({ identifier: string(), redirectPath: optional(string()) });

const transport = oneOf("ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb");
const attachment = oneOf("cross-platform", "platform");

const registrationResponse = object({
	id: string(),
	rawId: string(),
	response: object({
		clientDataJSON: string(),
		attestationObject: string(),
		authenticatorData: optional(string()),
		transports: optional(arrayOf(transport)),
		publicKeyAlgorithm: optional(number()),
		publicKey: optional(string()),
	}),
	authenticatorAttachment: optional(attachment),
	clientExtensionResults: unknownRecord(),
	type: oneOf("public-key"),
});

const authenticationResponse = object({
	id: string(),
	rawId: string(),
	response: object({
		clientDataJSON: string(),
		authenticatorData: string(),
		signature: string(),
		userHandle: optional(string()),
	}),
	authenticatorAttachment: optional(attachment),
	clientExtensionResults: unknownRecord(),
	type: oneOf("public-key"),
});

const REGISTRATION_PAYLOAD = {
	id: "Q1FaWDRB",
	rawId: "Q1FaWDRB",
	response: {
		clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
		attestationObject: "o2NmbXRkbm9uZQ",
		transports: ["internal", "hybrid"],
		publicKeyAlgorithm: -7,
	},
	authenticatorAttachment: "platform",
	clientExtensionResults: { credProps: { rk: true } },
	type: "public-key",
};

const AUTHENTICATION_PAYLOAD = {
	id: "Q1FaWDRB",
	rawId: "Q1FaWDRB",
	response: {
		clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
		authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4",
		signature: "MEUCIQD1",
	},
	clientExtensionResults: {},
	type: "public-key",
};

describe("input validators", () => {
	it("returns the declared fields", () => {
		expect(credentials.parse({ identifier: "someone", redirectPath: "/app" })).toEqual({
			identifier: "someone",
			redirectPath: "/app",
		});
	});

	it("leaves an optional field undefined instead of failing", () => {
		expect(credentials.parse({ identifier: "someone" })).toEqual({
			identifier: "someone",
			redirectPath: undefined,
		});
	});

	it("omits the key of an absent optional field rather than setting it to undefined", () => {
		expect(Object.hasOwn(credentials.parse({ identifier: "someone" }), "redirectPath")).toBe(false);
	});

	it("rejects a missing field, a wrong type and an unknown field alike", () => {
		for (const raw of [{}, { identifier: 7 }, { identifier: "someone", role: "admin" }, [], null]) {
			expect(() => credentials.parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});

	it("says nothing about which field was wrong", () => {
		try {
			credentials.parse({ identifier: 7 });
			expect.unreachable();
		} catch (cause) {
			expect((cause as VelveError).message).toBe("The request input is not valid.");
		}
	});
});

describe("number", () => {
	it("accepts a finite number", () => {
		expect(number().parse(-7)).toBe(-7);
		expect(number().parse(0)).toBe(0);
	});

	it("rejects what a direct server call can pass where JSON could not", () => {
		for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, "-7", null, undefined, [7], {}]) {
			expect(() => number().parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});
});

describe("oneOf", () => {
	it("accepts a declared value and narrows it to that literal", () => {
		expect(oneOf("public-key").parse("public-key")).toBe("public-key");
		expect(attachment.parse("cross-platform")).toBe("cross-platform");
	});

	it("rejects an undeclared value, a near miss and a non-string", () => {
		for (const raw of ["publickey", "PUBLIC-KEY", "", 0, null, ["public-key"]]) {
			expect(() => oneOf("public-key").parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});

	it("does not accept a property inherited from Object.prototype", () => {
		expect(() => attachment.parse("toString")).toThrow(new VelveError("invalid_input"));
	});
});

describe("arrayOf", () => {
	it("accepts an array whose every entry passes the inner validator", () => {
		expect(arrayOf(transport).parse(["usb", "nfc"])).toEqual(["usb", "nfc"]);
		expect(arrayOf(string()).parse([])).toEqual([]);
	});

	it("rejects a non-array and an array with one bad entry", () => {
		for (const raw of ["usb", { 0: "usb", length: 1 }, null, ["usb", "bluetooth"], ["usb", 7]]) {
			expect(() => arrayOf(transport).parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});
});

describe("unknownRecord", () => {
	it("accepts any object without reading it", () => {
		expect(unknownRecord().parse({})).toEqual({});
		expect(unknownRecord().parse({ credProps: { rk: true } })).toEqual({ credProps: { rk: true } });
	});

	it("rejects an array, null and a primitive", () => {
		for (const raw of [[], null, "", 7, true, undefined]) {
			expect(() => unknownRecord().parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});
});

describe("the nested WebAuthn payloads (3.15 D.3)", () => {
	it("parses a registration response into the shape the ceremony verifier expects", () => {
		const parsed: RegistrationResponseJSON = registrationResponse.parse(REGISTRATION_PAYLOAD);

		expect(parsed.response.transports).toEqual(["internal", "hybrid"]);
		expect(parsed.response.publicKeyAlgorithm).toBe(-7);
		expect(Object.hasOwn(parsed.response, "publicKey")).toBe(false);
	});

	it("parses an authentication response into the shape the ceremony verifier expects", () => {
		const parsed: AuthenticationResponseJSON = authenticationResponse.parse(AUTHENTICATION_PAYLOAD);

		expect(parsed.response.signature).toBe("MEUCIQD1");
		expect(Object.hasOwn(parsed, "authenticatorAttachment")).toBe(false);
	});

	it("rejects a malformed payload at every depth with one code", () => {
		const malformed: readonly unknown[] = [
			{ ...REGISTRATION_PAYLOAD, type: "publickey" },
			{ ...REGISTRATION_PAYLOAD, clientExtensionResults: [] },
			{ ...REGISTRATION_PAYLOAD, authenticatorAttachment: "internal" },
			{ ...REGISTRATION_PAYLOAD, response: "o2NmbXRkbm9uZQ" },
			{
				...REGISTRATION_PAYLOAD,
				response: { ...REGISTRATION_PAYLOAD.response, transports: ["bluetooth"] },
			},
			{
				...REGISTRATION_PAYLOAD,
				response: { ...REGISTRATION_PAYLOAD.response, transports: "internal" },
			},
			{
				...REGISTRATION_PAYLOAD,
				response: { ...REGISTRATION_PAYLOAD.response, publicKeyAlgorithm: "-7" },
			},
			{
				...REGISTRATION_PAYLOAD,
				response: { ...REGISTRATION_PAYLOAD.response, attestationObject: undefined },
			},
			{ ...REGISTRATION_PAYLOAD, response: { ...REGISTRATION_PAYLOAD.response, extra: 1 } },
		];

		for (const raw of malformed) {
			expect(() => registrationResponse.parse(raw)).toThrow(new VelveError("invalid_input"));
		}
	});

	it("gives every rejection the status and body the error map decides", () => {
		try {
			registrationResponse.parse({ ...REGISTRATION_PAYLOAD, type: "publickey" });
			expect.unreachable();
		} catch (cause) {
			expect(cause).toBeInstanceOf(VelveError);
			expect((cause as VelveError).code).toBe("invalid_input");
			expect((cause as VelveError).httpStatus).toBe(400);
			expect((cause as VelveError).message).toBe("The request input is not valid.");
		}
	});
});
