export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

const MILLISECONDS_PER_UNIT: Readonly<Record<string, number>> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

const WHOLE_UNITS = /^(\d+)([smhd])$/;

/** Null for anything the template literal type admits but a deadline cannot use: "1.5h", "-7d", "7". */
export function durationInMilliseconds(duration: string): number | null {
	const parsed = WHOLE_UNITS.exec(duration);
	if (parsed === null) {
		return null;
	}
	const milliseconds = MILLISECONDS_PER_UNIT[parsed[2] ?? ""];
	return milliseconds === undefined ? null : Number(parsed[1]) * milliseconds;
}
