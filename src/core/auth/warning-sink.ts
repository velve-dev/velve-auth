import type { HttpEnvironment } from "../http/environment.js";

type LogSink = HttpEnvironment["log"];

const CONSOLE_PREFIX = "[@velve/auth]";

//the console is written only here and only when the application configured no log sink (E-2671)
function warnOnTheConsole(...[, message, fields]: Parameters<LogSink>): void {
	//biome-ignore lint/suspicious/noConsole: the fallback sink for weakenings and route alarms
	console.warn(`${CONSOLE_PREFIX} ${message}`, fields ?? {});
}

export function operatorWarningSinkOf(log: LogSink | undefined): LogSink {
	return log ?? warnOnTheConsole;
}
