import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

function readPublicSurface(): string {
	const declarations = readdirSync(distDirectory)
		.filter((file) => file.endsWith(".d.mts"))
		.sort();

	return declarations
		.map((file) => {
			const body = readFileSync(`${distDirectory}/${file}`, "utf8").trimEnd();
			return `## ${file}\n\n${body === "" ? "(empty)" : body}`;
		})
		.join("\n\n");
}

describe("public API surface", () => {
	it("matches the committed snapshot", async () => {
		if (!existsSync(distDirectory)) {
			throw new Error("dist/ is missing — run `pnpm build` before comparing the API surface");
		}
		await expect(readPublicSurface()).toMatchFileSnapshot("./__snapshots__/api-surface.md");
	});
});
