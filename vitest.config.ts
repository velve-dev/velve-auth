import { defineConfig } from "vitest/config";

/** A concurrency test needs its threshold in real connections, and PostgreSQL has a
 * fixed budget. Running those files one at a time bounds the peak by construction,
 * rather than each file quietly shrinking below the threshold it is meant to prove. */
const CONCURRENCY_FILES = ["test/**/*-race.test.ts", "test/**/*-concurrency.test.ts"];

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		coverage: { provider: "v8", include: ["src/**"] },
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: CONCURRENCY_FILES,
					environment: "node",
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "concurrency",
					include: CONCURRENCY_FILES,
					environment: "node",
					testTimeout: 60_000,
					fileParallelism: false,
				},
			},
		],
	},
});
