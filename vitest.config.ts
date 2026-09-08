import { defineConfig } from "vitest/config";

/** A concurrency test needs its threshold in real connections, and PostgreSQL has a fixed
 * budget. What bounds the peak is the total held at once, not the order of these files among
 * themselves: ordering them against each other while the unit project ran alongside them left
 * a measured peak anywhere from 76 to 99 of 100 connections. They run in a group of their own now, after
 * every other file has finished and one file at a time, so nothing else holds a connection
 * while they hold theirs (E-156). */
const CONCURRENCY_FILES = ["test/**/*-race.test.ts", "test/**/*-concurrency.test.ts"];

/** Section 6 puts three cases before every release rather than on every commit: they restart a
 * process, remove an optional dependency, or read the packed artefact. The tier is a project of its
 * own so that `pnpm test` cannot pick them up and `pnpm test:release` cannot miss them (E-344). */
const RELEASE_FILES = ["test/**/*.release.test.ts"];
const RUNS_ALONE_AFTERWARDS = { groupOrder: 1 };

/** Vitest reads this only at the root; inside a project it is accepted and has no effect, so the
 * one file per turn E-156 asks for never happened. It held while one file wanted fifty connections
 * and broke the moment a second one did (E-411). */
const ONE_FILE_AT_A_TIME = false;

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		fileParallelism: ONE_FILE_AT_A_TIME,
		coverage: { provider: "v8", include: ["src/**"] },
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: [...CONCURRENCY_FILES, ...RELEASE_FILES],
					environment: "node",
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "release",
					include: RELEASE_FILES,
					environment: "node",
					testTimeout: 120_000,
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
