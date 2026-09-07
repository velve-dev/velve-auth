import { describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { object, optional, string } from "../src/core/http/validators.js";

const credentials = object({ identifier: string(), redirectPath: optional(string()) });

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
