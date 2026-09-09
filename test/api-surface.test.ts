import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

const EXPORT_LIST = /^(export \{)([^}]*)(\};)$/gm;

/**
 * The whole export list arrives on one physical line, so three features each adding a name meet in
 * one three-way conflict resolvable only by regenerating. One name per line makes their additions
 * disjoint hunks (E-776).
 */
function oneExportPerLine(body: string): string {
	return body.replace(EXPORT_LIST, (_whole, open: string, names: string, close: string) => {
		const listed = names
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "");
		return `${open}\n${listed.map((name) => `\t${name},`).join("\n")}\n${close}`;
	});
}

function readPublicSurface(): string {
	const declarations = readdirSync(distDirectory)
		.filter((file) => file.endsWith(".d.mts"))
		.sort();

	return declarations
		.map((file) => {
			const body = oneExportPerLine(readFileSync(`${distDirectory}/${file}`, "utf8").trimEnd());
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
