import type { KeyPurpose } from "./purpose.js";

export interface KeyProvider {
	current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>;
	byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>;
}
