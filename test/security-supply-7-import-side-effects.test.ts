import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const documentation = readFileSync(`${repositoryRoot}DOCUMENTATION.md`, "utf8");

interface GlobalChanges {
	reflect: string[];
	globals: string[];
}

/** What importing one built entry point adds to `Reflect` and to `globalThis`, read in a process
 * of its own so that nothing this suite loaded first is counted. */
async function changesFromImporting(entry: string): Promise<GlobalChanges> {
	const path = fileURLToPath(new URL(`../dist/${entry}.mjs`, import.meta.url));
	const probe = `
		const reflect = Object.getOwnPropertyNames(Reflect);
		const globals = Object.getOwnPropertyNames(globalThis);
		await import(${JSON.stringify(path)});
		process.stdout.write(JSON.stringify({
			reflect: Object.getOwnPropertyNames(Reflect).filter((name) => !reflect.includes(name)).sort(),
			globals: Object.getOwnPropertyNames(globalThis).filter((name) => !globals.includes(name)).sort(),
		}));
	`;
	const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe]);
	return JSON.parse(stdout) as GlobalChanges;
}

function sectionOf(heading: string): string {
	const start = documentation.indexOf(`\n${heading}\n`);
	expect(start, `DOCUMENTATION.md has no ${heading}`).toBeGreaterThan(-1);
	const end = documentation.indexOf("\n### ", start + heading.length + 2);
	return documentation.slice(start, end === -1 ? undefined : end);
}

/**
 * SUPPLY-7. @simplewebauthn/server pulls in @peculiar/x509, which loads reflect-metadata and
 * tsyringe when the main entry is imported, so importing the library adds members to the
 * process-wide `Reflect` before any application code runs. The dependency is one of the six core
 * dependencies and stays, so what it changes is stated where a reader looks for it, and this case
 * holds that statement to what an import actually does (E-3891).
 */
describe("the documentation states what importing the package changes in the process", () => {
	const HEADING = "### What importing the package changes in the process";

	it("names every member importing the main entry adds to Reflect", async () => {
		const { reflect } = await changesFromImporting("index");
		const section = sectionOf(HEADING);

		expect(reflect.length).toBeGreaterThan(0);
		expect(reflect.filter((name) => !section.includes(`\`Reflect.${name}\``))).toStrictEqual([]);
	});

	it("states how many helpers importing the main entry adds to globalThis, and their shape", async () => {
		const { globals } = await changesFromImporting("index");
		const section = sectionOf(HEADING);

		expect(globals.filter((name) => !name.startsWith("__"))).toStrictEqual([]);
		expect(section).toContain(`${globals.length} helper functions`);
	});

	it.each(["http", "client", "pg", "schema", "testing"])(
		"changes nothing global when %s is imported, as the section says",
		async (entry) => {
			expect(await changesFromImporting(entry)).toStrictEqual({ reflect: [], globals: [] });
			expect(sectionOf(HEADING)).toContain(`\`@velve/auth/${entry}\``);
		},
	);
});
