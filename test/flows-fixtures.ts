import { TEST_ORIGIN } from "./auth-fixtures.js";

/**
 * T-ENUM-1's method, extended by what a sign-up answer carries that a sign-in answer does not: an
 * identifier, three instants, a token — all random on every path — and the address, which 3.15 C
 * puts in `User` and which the caller sent. Everything else must survive the normalisation.
 */
function normalisedBody(text: string): Buffer {
	return Buffer.from(
		text
			.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
			.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<instant>")
			.replaceAll(/[A-Za-z0-9_-]{43}/g, "<secret>")
			.replaceAll(/[a-z.]+@example\.com/g, "<address>"),
		"utf8",
	);
}

function normalisedHeaders(answer: Response): string {
	return [...answer.headers]
		.filter(([name]) => name !== "date")
		.map(([name, value]) => `${name}: ${value.replaceAll(/[A-Za-z0-9_-]{43}/g, "<secret>")}`)
		.sort()
		.join("\n");
}

export function postTo(path: string, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request(`https://api.example.com${path}`, {
		method: "POST",
		headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

export async function difference(a: Response, b: Response): Promise<string[]> {
	const found: string[] = [];
	if (a.status !== b.status) {
		found.push(`status ${a.status} against ${b.status}`);
	}
	if (normalisedHeaders(a) !== normalisedHeaders(b)) {
		found.push(`headers\n${normalisedHeaders(a)}\nagainst\n${normalisedHeaders(b)}`);
	}
	const first = normalisedBody(await a.text());
	const second = normalisedBody(await b.text());
	if (Buffer.compare(first, second) !== 0) {
		found.push(`body ${first.toString()} against ${second.toString()}`);
	}
	return found;
}

/** Status, header set and body of one answer as a single comparable value, so a set of answers can
 * be compared without any of them being read twice. */
export async function normalisedAnswer(answer: Response): Promise<string> {
	return [
		`status ${answer.status}`,
		normalisedHeaders(answer),
		normalisedBody(await answer.text()).toString(),
	].join("\n");
}
