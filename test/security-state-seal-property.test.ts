import { describe, expect, it } from "vitest";
import { encodeSecurityState, type SecurityState } from "../src/core/security-state/encoding.js";

//the property part of T-INTEG-2 uses generators a naive encoder fails (E-3152)

const PAIRS_PER_GENERATOR = 1500;

type Random = () => number;

function seeded(seed: number): Random {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function integerBelow(random: Random, bound: number): number {
	return Math.floor(random() * bound);
}

function asciiText(random: Random, minimum: number, maximum: number): string {
	const length = minimum + integerBelow(random, maximum - minimum + 1);
	return Array.from({ length }, () => String.fromCharCode(97 + integerBelow(random, 26))).join("");
}

function asciiBytes(random: Random, minimum: number, maximum: number): Uint8Array {
	return new TextEncoder().encode(asciiText(random, minimum, maximum));
}

function digestBytes(random: Random): Uint8Array {
	return Uint8Array.from({ length: 32 }, () => integerBelow(random, 256));
}

function uuid(random: Random): string {
	const digits = Array.from({ length: 32 }, () => integerBelow(random, 16).toString(16)).join("");
	return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${digits.slice(20)}`;
}

function randomState(random: Random): SecurityState {
	return {
		userId: uuid(random),
		version: 1 + integerBelow(random, 1000),
		sessionEpoch: 1 + integerBelow(random, 1000),
		componentsVersion: 1 + integerBelow(random, 1000),
		sessionGeneration: 1 + integerBelow(random, 1000),
		attemptGeneration: 1 + integerBelow(random, 1000),
		attemptLast: random() < 0.5 ? null : digestBytes(random),
		tokenGenerations: {
			email_verify: 1 + integerBelow(random, 1000),
			password_reset: 1 + integerBelow(random, 1000),
			email_change: 1 + integerBelow(random, 1000),
			magic_link: 1 + integerBelow(random, 1000),
		},
		tokenLast: random() < 0.5 ? null : digestBytes(random),
		email: random() < 0.2 ? null : `${asciiText(random, 1, 6)}@example`,
		emailVerified: random() < 0.5,
		disabled: random() < 0.5,
		password:
			random() < 0.3
				? null
				: {
						phcSha256: digestBytes(random),
						keyVersion: 1 + integerBelow(random, 3),
						setBySessionId: random() < 0.5 ? null : uuid(random),
					},
		passwordResetRequired: random() < 0.5,
		totp:
			random() < 0.4
				? null
				: {
						confirmed: random() < 0.5,
						secretSha256: digestBytes(random),
						keyVersion: 1 + integerBelow(random, 3),
					},
		passkeys: Array.from({ length: 1 + integerBelow(random, 3) }, () => ({
			credentialId: asciiBytes(random, 2, 6),
			publicKey: asciiBytes(random, 2, 6),
		})),
		identities: Array.from({ length: 1 + integerBelow(random, 3) }, () => ({
			provider: asciiText(random, 2, 6),
			subject: asciiText(random, 2, 6),
		})),
		recoveryCodes: Array.from({ length: integerBelow(random, 4) }, () => ({
			keyVersion: 1 + integerBelow(random, 3),
			codeHmac: digestBytes(random),
		})),
	};
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) {
		throw new RangeError("the generator asked for an element the state does not have");
	}
	return item;
}

function replaced<T>(items: readonly T[], index: number, item: T): T[] {
	return items.map((existing, position) => (position === index ? item : existing));
}

function shiftedAcross(left: string, right: string, random: Random): [string, string] {
	if (left.length > 1 && random() < 0.5) {
		const cut = 1 + integerBelow(random, left.length - 1);
		return [left.slice(0, cut), left.slice(cut) + right];
	}
	const cut = 1 + integerBelow(random, Math.max(1, right.length - 1));
	return [left + right.slice(0, cut), right.slice(cut)];
}

function bytesShiftedAcross(
	left: Uint8Array,
	right: Uint8Array,
	random: Random,
): [Uint8Array, Uint8Array] {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const [shiftedLeft, shiftedRight] = shiftedAcross(
		decoder.decode(left),
		decoder.decode(right),
		random,
	);
	return [encoder.encode(shiftedLeft), encoder.encode(shiftedRight)];
}

//a naive encoder must see the same bytes on both sides of every move
function boundaryShifted(base: SecurityState, random: Random): SecurityState {
	switch (integerBelow(random, 5)) {
		case 0: {
			const index = integerBelow(random, base.identities.length);
			const identity = at(base.identities, index);
			const [provider, subject] = shiftedAcross(identity.provider, identity.subject, random);
			return { ...base, identities: replaced(base.identities, index, { provider, subject }) };
		}
		case 1: {
			const index = integerBelow(random, base.passkeys.length);
			const passkey = at(base.passkeys, index);
			const [credentialId, publicKey] = bytesShiftedAcross(
				passkey.credentialId,
				passkey.publicKey,
				random,
			);
			return { ...base, passkeys: replaced(base.passkeys, index, { credentialId, publicKey }) };
		}
		case 2: {
			const moved = at(base.passkeys, base.passkeys.length - 1);
			const decoder = new TextDecoder();
			return {
				...base,
				passkeys: base.passkeys.slice(0, -1),
				identities: [
					{
						provider: decoder.decode(moved.credentialId),
						subject: decoder.decode(moved.publicKey),
					},
					...base.identities,
				],
			};
		}
		case 3: {
			const [first, second, ...rest] = base.identities;
			if (first === undefined || second === undefined) {
				return { ...base, email: base.email === null ? "" : null };
			}
			const merged = {
				provider: first.provider,
				subject: first.subject + second.provider + second.subject,
			};
			return { ...base, identities: [merged, ...rest] };
		}
		default:
			return base.email === null
				? { ...base, email: "" }
				: { ...base, email: base.email === "" ? null : "" };
	}
}

//the generations a booking, a revocation and a redemption move are fields like any other (E-3519)
function generationMutated(base: SecurityState, random: Random, field: number): SecurityState {
	switch (field) {
		case 14:
			return { ...base, sessionGeneration: base.sessionGeneration + 1 };
		case 15:
			return { ...base, attemptGeneration: base.attemptGeneration + 1 };
		case 16:
			return { ...base, attemptLast: base.attemptLast === null ? digestBytes(random) : null };
		case 17:
			return {
				...base,
				tokenGenerations: {
					...base.tokenGenerations,
					email_change: base.tokenGenerations.email_change + 1,
				},
			};
		case 18:
			return { ...base, tokenLast: base.tokenLast === null ? digestBytes(random) : null };
		default:
			return { ...base, componentsVersion: base.componentsVersion + 1 };
	}
}

//a mutated state must differ from its base in exactly one field
function singleFieldMutated(base: SecurityState, random: Random): SecurityState {
	const field = integerBelow(random, 20);
	if (field >= 14) {
		return generationMutated(base, random, field);
	}
	switch (field) {
		case 0:
			return { ...base, userId: uuid(random) };
		case 1:
			return { ...base, version: base.version + 1 };
		case 2:
			return { ...base, sessionEpoch: base.sessionEpoch + 1 };
		case 3:
			return { ...base, email: base.email === null ? "x@example" : null };
		case 4:
			return { ...base, emailVerified: !base.emailVerified };
		case 5:
			return { ...base, disabled: !base.disabled };
		case 6:
			return {
				...base,
				password:
					base.password === null
						? { phcSha256: digestBytes(random), keyVersion: 1, setBySessionId: null }
						: { ...base.password, keyVersion: base.password.keyVersion + 1 },
			};
		case 7:
			return { ...base, passwordResetRequired: !base.passwordResetRequired };
		case 8:
			return {
				...base,
				totp:
					base.totp === null
						? { confirmed: false, secretSha256: digestBytes(random), keyVersion: 1 }
						: { ...base.totp, confirmed: !base.totp.confirmed },
			};
		case 9:
			return { ...base, passkeys: base.passkeys.slice(1) };
		case 10:
			return {
				...base,
				identities: replaced(base.identities, 0, {
					...at(base.identities, 0),
					subject: `${at(base.identities, 0).subject}z`,
				}),
			};
		case 11:
			return {
				...base,
				recoveryCodes: [...base.recoveryCodes, { keyVersion: 1, codeHmac: digestBytes(random) }],
			};
		case 12:
			return {
				...base,
				password:
					base.password === null
						? null
						: {
								...base.password,
								setBySessionId: base.password.setBySessionId === null ? uuid(random) : null,
							},
				...(base.password === null ? { disabled: !base.disabled } : {}),
			};
		default:
			return {
				...base,
				passkeys: replaced(base.passkeys, 0, {
					...at(base.passkeys, 0),
					publicKey: new Uint8Array([...at(base.passkeys, 0).publicKey, 0x7a]),
				}),
			};
	}
}

const utf8 = new TextEncoder();

//the reference encoder must be ambiguous for the property to prove anything (E-3322)
function naivelyEncoded(state: SecurityState): string {
	const parts: Uint8Array[] = [
		utf8.encode(state.userId),
		utf8.encode(String(state.version)),
		utf8.encode(String(state.sessionEpoch)),
		utf8.encode(state.email ?? ""),
		utf8.encode(state.emailVerified ? "1" : "0"),
		utf8.encode(state.disabled ? "1" : "0"),
	];
	if (state.password !== null) {
		parts.push(
			state.password.phcSha256,
			utf8.encode(String(state.password.keyVersion)),
			utf8.encode(state.password.setBySessionId ?? ""),
		);
	}
	parts.push(utf8.encode(state.passwordResetRequired ? "1" : "0"));
	if (state.totp !== null) {
		parts.push(
			utf8.encode(state.totp.confirmed ? "1" : "0"),
			state.totp.secretSha256,
			utf8.encode(String(state.totp.keyVersion)),
		);
	}
	for (const passkey of state.passkeys) {
		parts.push(passkey.credentialId, passkey.publicKey);
	}
	for (const identity of state.identities) {
		parts.push(utf8.encode(identity.provider), utf8.encode(identity.subject));
	}
	for (const code of state.recoveryCodes) {
		parts.push(utf8.encode(String(code.keyVersion)), code.codeHmac);
	}
	return parts.map((part) => Buffer.from(part).toString("hex")).join("");
}

function canonicallyEncoded(state: SecurityState): string {
	return Buffer.from(encodeSecurityState(state)).toString("hex");
}

function semanticallyEqual(left: SecurityState, right: SecurityState): boolean {
	const normalised = (state: SecurityState) =>
		JSON.stringify({
			...state,
			password:
				state.password === null
					? null
					: { ...state.password, phcSha256: [...state.password.phcSha256] },
			totp:
				state.totp === null ? null : { ...state.totp, secretSha256: [...state.totp.secretSha256] },
			passkeys: state.passkeys
				.map((passkey) => `${[...passkey.credentialId]}|${[...passkey.publicKey]}`)
				.sort(),
			identities: state.identities
				.map((identity) => `${identity.provider}|${identity.subject}`)
				.sort(),
			recoveryCodes: state.recoveryCodes
				.map((code) => `${code.keyVersion}|${[...code.codeHmac]}`)
				.sort(),
		});
	return normalised(left) === normalised(right);
}

function pairsFrom(
	generator: (base: SecurityState, random: Random) => SecurityState,
	seed: number,
): [SecurityState, SecurityState][] {
	const random = seeded(seed);
	const pairs: [SecurityState, SecurityState][] = [];
	while (pairs.length < PAIRS_PER_GENERATOR) {
		const base = randomState(random);
		const other = generator(base, random);
		if (!semanticallyEqual(base, other)) {
			pairs.push([base, other]);
		}
	}
	return pairs;
}

function collisions(
	pairs: readonly [SecurityState, SecurityState][],
	encode: (state: SecurityState) => string,
): number {
	return pairs.filter(([left, right]) => encode(left) === encode(right)).length;
}

describe("two different states never share an encoding (T-INTEG-2, property)", () => {
	const shifted = pairsFrom(boundaryShifted, 0x5eed_0001);
	const mutated = pairsFrom(singleFieldMutated, 0x5eed_0002);

	it(`holds over ${PAIRS_PER_GENERATOR} pairs that shift bytes across a field or list boundary`, () => {
		expect(shifted).toHaveLength(PAIRS_PER_GENERATOR);
		expect(collisions(shifted, canonicallyEncoded)).toBe(0);
	});

	it(`holds over ${PAIRS_PER_GENERATOR} pairs that differ in exactly one field`, () => {
		expect(mutated).toHaveLength(PAIRS_PER_GENERATOR);
		expect(collisions(mutated, canonicallyEncoded)).toBe(0);
	});

	it("fails for an encoder without lengths and counts, so the generators can find what they look for", () => {
		const naiveCollisions = collisions(shifted, naivelyEncoded);

		expect(naiveCollisions).toBeGreaterThanOrEqual(1);
	});
});
