import { afterEach, describe, expect, it } from "vitest";
import { forgetPluginErrorCodes, toErrorBody, VelveError } from "../src/core/http/error-map.js";
import { object } from "../src/core/http/validators.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

afterEach(() => {
	forgetPluginErrorCodes();
});

function answerFor(code: string): string {
	const error = new VelveError(code as "internal_error");
	const body = toErrorBody(error);
	return `${error.httpStatus} ${body.error.code}`;
}

/**
 * The registry `errorCodes` writes into is process-wide. A start that refuses has contributed
 * nothing to the instance it refused, so it must have contributed nothing to the process either.
 */
describe("what a refused start leaves in the process-wide error registry", () => {
	it("registers no declared code when the start refuses the plugin's route", () => {
		expect(() =>
			createVelveAuth(
				configFor({
					database: unreachableDriver(),
					plugins: [
						asJavaScriptPlugin({
							id: "quota",
							errorCodes: ["quota.exceeded"],
							routes: [
								{
									name: "quota.spend",
									method: "POST",
									path: "/x/quota/spend",
									input: object({}),
									errors: [],
									caller: "anonymous",
									freshness: "not_required",
									originCheck: "exempt",
									rateLimit: { perIpAddress: "none", perAccount: "none" },
									handler: () => Promise.resolve({}),
								},
							],
						}),
					],
				}),
			),
		).toThrowError();

		expect(answerFor("quota.exceeded")).toBe("500 internal_error");
	});
});
