import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		http: "src/http/index.ts",
		client: "src/client/index.ts",
		"client/proof-of-work-worker": "src/client/proof-of-work-worker.ts",
		pg: "src/pg/index.ts",
		schema: "src/schema/index.ts",
		testing: "src/testing/index.ts",
	},
	format: "esm",
	outExtensions: () => ({ js: ".mjs" }),
	dts: true,
	clean: true,
	treeshake: true,
	platform: "neutral",
	unbundle: true,
});
