import { defineConfig } from "vitest/config";

/** A concurrency test needs its threshold in real connections, and PostgreSQL has a fixed
 * budget. What bounds the peak is the total held at once, not the order of these files among
 * themselves: ordering them against each other while the unit project ran alongside them left
 * a measured peak anywhere from 76 to 99 of 100 connections. They run in a group of their own now, after
 * every other file has finished and one file at a time, so nothing else holds a connection
 * while they hold theirs (E-156). */
const CONCURRENCY_FILES = ["test/**/*-race.test.ts", "test/**/*-concurrency.test.ts"];
const RUNS_ALONE_AFTERWARDS = { groupOrder: 1 };

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
					sequence: RUNS_ALONE_AFTERWARDS,
				},
			},
		],
	},
});
