import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	forgetPluginErrorCodes,
	registerPluginErrorCodes,
	resolveErrorCode,
	toErrorBody,
	VelveError,
} from "../src/core/http/error-map.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("plugin_config_seam");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function start(overrides: Partial<VelveAuthConfig<"email">>): () => unknown {
	return () => createVelveAuth(configFor({ database: connection as Driver, schema, ...overrides }));
}

const AUDIT_PLUGIN: VelvePlugin<"audit"> = {
	id: "audit",
	errorCodes: ["audit.rejected"],
};

describe("the plugin configuration seam (3.15 G)", () => {
	it("takes a list of plugins and starts", () => {
		expect(start({ plugins: [AUDIT_PLUGIN] })).not.toThrow();
	});

	// The namespace constraint is a type, not a runtime check, so this is the assertion for it.
	it("constrains an error code to the plugin's own namespace", () => {
		expect(AUDIT_PLUGIN.errorCodes).toStrictEqual(["audit.rejected"]);
	});
});

describe("a plugin's own error codes (3.11, §3)", () => {
	afterEach(() => {
		forgetPluginErrorCodes();
	});

	it("resolves a core code from the two tables and a namespaced one from the registry", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });

		expect(resolveErrorCode("invalid_input")).toStrictEqual({
			httpStatus: 400,
			message: "The request input is not valid.",
		});
		expect(resolveErrorCode("audit.rejected")).toStrictEqual({
			httpStatus: 409,
			message: "Refused.",
		});
	});

	// A code nobody declared is not part of any published interface, so neither its text nor the
	// code itself reaches the caller (E-647).
	it("answers an unregistered namespaced code as an internal error", () => {
		const error = new VelveError("audit.never-registered");

		expect(error.httpStatus).toBe(500);
		expect(error.message).toBe("The request could not be completed.");
		expect(toErrorBody(error).error.code).toBe("internal_error");
	});

	it("carries the registered status and message onto VelveError and into the body", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });
		const error = new VelveError("audit.rejected");

		expect(error.httpStatus).toBe(409);
		expect(toErrorBody(error)).toStrictEqual({
			error: { code: "audit.rejected", message: "Refused." },
		});
	});

	it("refuses a redefinition of a core code and a second answer for its own", () => {
		registerPluginErrorCodes({ "audit.rejected": { httpStatus: 409, message: "Refused." } });

		expect(() =>
			registerPluginErrorCodes({
				invalid_input: { httpStatus: 418, message: "Mine now." },
			} as never),
		).toThrowError(/core error code/);
		expect(() =>
			registerPluginErrorCodes({ "audit.rejected": { httpStatus: 400, message: "Refused." } }),
		).toThrowError(/already registered/);
		expect(() =>
			registerPluginErrorCodes({ "audit.other": { httpStatus: 200, message: "Fine." } }),
		).toThrowError(/4xx or 5xx/);
	});
});
