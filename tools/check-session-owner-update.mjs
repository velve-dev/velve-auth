import { reportOn, scanBuiltPackage, scanTree } from "./session-owner-update.mjs";

const { refusals, findings, summary, exitCode } = reportOn(scanTree(), scanBuiltPackage());

for (const line of [...refusals, ...findings]) console.error(line);

if (exitCode !== 0) process.exit(exitCode);

console.log(summary);
