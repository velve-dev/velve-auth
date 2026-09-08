import { describe, expect, it } from "vitest";
import { scramClientFinal } from "./db-postgres-connection.js";

const CLIENT_FIRST_BARE = "n=user,r=rOprNGfwEbeRWgbNEkqO";
const SERVER_FIRST =
	"r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

describe("SCRAM-SHA-256 client", () => {
	it("reproduces the RFC 7677 exchange", () => {
		const final = scramClientFinal("pencil", CLIENT_FIRST_BARE, SERVER_FIRST);

		expect(final.message).toBe(
			"c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
		);
		expect(final.expectedServerSignature.toString("base64")).toBe(
			"6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
		);
	});

	it("rejects a server nonce that does not extend the client nonce", () => {
		expect(() => scramClientFinal("pencil", CLIENT_FIRST_BARE, "r=other,s=AAAA,i=4096")).toThrow(
			"does not extend",
		);
	});
});
