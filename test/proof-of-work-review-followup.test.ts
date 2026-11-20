import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { object, string } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";

/**
 * Review of the answers to the first review of change 2 (E-3677) and of the merge with change 8:
 * a plugin route that takes an input field named proofOfWork keeps it while the proof of work is
 * off and refuses the start while it is on, and every count of the reading GET routes names the
 * challenge route the proof of work adds (S-CSRF-1, S-CSRF-4, 3.9).
 */

const mounted: MountedAuth[] = [];

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

function quizPlugin(seen: unknown[]): VelvePlugin<"quiz"> {
	return {
		id: "quiz",
		routes: [
			{
				name: "quiz.answer",
				method: "POST",
				path: "/x/quiz/answer",
				input: object({ proofOfWork: string() }),
				errors: ["rate_limited"],
				caller: "anonymous",
				freshness: "not_required",
				originCheck: "checked",
				rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
				handler: async (input: { proofOfWork: string }) => {
					seen.push(input.proofOfWork);
					return { echoed: input.proofOfWork };
				},
			} as unknown as PluginRoute<"quiz">,
		],
	};
}

describe("a plugin route declaring an input field proofOfWork (E-3677)", () => {
	it("receives the field on a direct call while the proof of work is off", async () => {
		const seen: unknown[] = [];
		const instance = await mountAuth("powrev2_plugin_off", { plugins: [quizPlugin(seen)] });
		mounted.push(instance);
		const surface = instance.auth as unknown as {
			quiz: { answer(input: Record<string, unknown>): Promise<unknown> };
		};

		const answer = await surface.quiz.answer({ origin: TEST_ORIGIN, proofOfWork: "forty-two" });

		expect(answer).toStrictEqual({ echoed: "forty-two" });
		expect(seen).toStrictEqual(["forty-two"]);
	});

	it("refuses the start while the proof of work is on", async () => {
		const { connection, schema } = await openMigratedSchema("powrev2_plugin_on");
		try {
			const refusal = (() => {
				try {
					createVelveAuth(
						configFor({
							database: connection,
							schema,
							plugins: [quizPlugin([])],
							rateLimit: {
								proofOfWork: { difficulty: () => 0, signInFailuresBeforeProof: () => 3 },
							},
						}),
					);
					return null;
				} catch (error) {
					return (error as { code?: string }).code ?? "thrown";
				}
			})();

			expect(refusal).toBe("proof_of_work_unusable");
		} finally {
			await dropSchema(connection, schema);
			await connection.close();
		}
	});
});

describe("the number of reading GET routes the specification and the reference state (S-CSRF-1, S-CSRF-4)", () => {
	const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

	it("is nine wherever the English specification counts them", () => {
		expect(read("VELVE-AUTH-ARCHITECTURE.md").match(/\beight reading\b/g) ?? []).toStrictEqual([]);
	});

	it("is nine wherever the German specification counts them", () => {
		expect(read("VELVE-AUTH-ARCHITEKTUR.md").match(/\bacht lesenden\b/g) ?? []).toStrictEqual([]);
	});

	it("lists the challenge route where DOCUMENTATION.md lists the reading routes a same-origin GET may call", () => {
		const reference = read("DOCUMENTATION.md");
		const list = reference.slice(
			reference.indexOf("reading `GET` routes of S-CSRF-4: `/session`"),
			reference.indexOf("- the request came through the web handler;"),
		);

		expect(list).toContain("/proof-of-work/challenge");
		expect(list).not.toMatch(/\beight reading\b/);
	});
});
