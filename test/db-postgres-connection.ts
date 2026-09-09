import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as connectSocket, type Socket } from "node:net";
import type { Driver } from "../src/core/db/driver.js";

const PROTOCOL_VERSION_3 = 196608;
const SCRAM_SHA_256 = "SCRAM-SHA-256";

const TYPE_BOOLEAN = 16;
const TYPE_BYTEA = 17;
const TYPE_SMALLINT = 21;
const TYPE_INTEGER = 23;
const TYPE_OID = 26;
const TYPE_TIMESTAMP = 1114;
const TYPE_TIMESTAMPTZ = 1184;

const POSTGRES_TIMESTAMP =
	/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

/** node-postgres, postgres.js and the neon driver all hand a timestamptz back as a Date; this one stands in for them. */
function decodeTimestamp(text: string): Date {
	const parts = POSTGRES_TIMESTAMP.exec(text);
	return new Date(parts === null ? text : `${parts[1]}T${parts[2]}${parts[3]}:${parts[4] ?? "00"}`);
}

export class PostgresServerError extends Error {
	readonly sqlState: string;

	constructor(fields: Map<string, string>) {
		super(fields.get("M") ?? "the server reported an error without a message");
		this.name = "PostgresServerError";
		this.sqlState = fields.get("C") ?? "";
	}
}

interface Field {
	readonly name: string;
	readonly typeOid: number;
}

interface Message {
	readonly type: string;
	readonly body: Buffer;
}

class MessageReader {
	private offset = 0;
	private readonly body: Buffer;

	constructor(body: Buffer) {
		this.body = body;
	}

	int16(): number {
		const value = this.body.readInt16BE(this.offset);
		this.offset += 2;
		return value;
	}

	int32(): number {
		const value = this.body.readInt32BE(this.offset);
		this.offset += 4;
		return value;
	}

	cstring(): string {
		const end = this.body.indexOf(0, this.offset);
		const value = this.body.toString("utf8", this.offset, end);
		this.offset = end + 1;
		return value;
	}

	bytes(length: number): Buffer {
		const value = this.body.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	rest(): Buffer {
		return this.body.subarray(this.offset);
	}

	get exhausted(): boolean {
		return this.offset >= this.body.length;
	}
}

function frame(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.write(type, 0, "latin1");
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
}

function cstring(value: string): Buffer {
	return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function decodeValue(raw: Buffer | null, typeOid: number): unknown {
	if (raw === null) {
		return null;
	}
	const text = raw.toString("utf8");
	switch (typeOid) {
		case TYPE_BOOLEAN:
			return text === "t";
		case TYPE_BYTEA:
			return Buffer.from(text.slice(2), "hex");
		case TYPE_SMALLINT:
		case TYPE_INTEGER:
		case TYPE_OID:
			return Number(text);
		case TYPE_TIMESTAMP:
		case TYPE_TIMESTAMPTZ:
			return decodeTimestamp(text);
		default:
			return text;
	}
}

function encodeParameter(value: unknown): Buffer | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(`\\x${Buffer.from(value).toString("hex")}`, "utf8");
	}
	if (typeof value === "string") {
		return Buffer.from(value, "utf8");
	}
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return Buffer.from(String(value), "utf8");
	}
	throw new TypeError(`the test connection cannot encode a parameter of type ${typeof value}`);
}

export function scramClientFinal(
	password: string,
	clientFirstBare: string,
	serverFirst: string,
): { message: string; expectedServerSignature: Buffer } {
	const attributes = new Map(
		serverFirst.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const),
	);
	const serverNonce = attributes.get("r") ?? "";
	const salt = Buffer.from(attributes.get("s") ?? "", "base64");
	const iterations = Number(attributes.get("i") ?? "0");
	const clientNonce = clientFirstBare.slice(clientFirstBare.indexOf(",r=") + 3);
	if (!serverNonce.startsWith(clientNonce)) {
		throw new Error("the server nonce does not extend the client nonce");
	}

	const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
	const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
	const storedKey = createHash("sha256").update(clientKey).digest();
	const withoutProof = `c=biws,r=${serverNonce}`;
	const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
	const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
	const proof = Buffer.from(clientKey.map((byte, index) => byte ^ (clientSignature[index] ?? 0)));
	const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();

	return {
		message: `${withoutProof},p=${proof.toString("base64")}`,
		expectedServerSignature: createHmac("sha256", serverKey).update(authMessage).digest(),
	};
}

class MessageStream {
	private buffered = Buffer.alloc(0);
	private readonly pending: Message[] = [];
	private waiting: ((message: Message) => void) | undefined;
	private failure: Error | undefined;
	private failureWaiter: ((error: Error) => void) | undefined;

	constructor(socket: Socket) {
		socket.on("data", (chunk: Buffer) => {
			this.buffered = Buffer.concat([this.buffered, chunk]);
			this.drain();
		});
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.fail(new Error("the connection closed unexpectedly")));
	}

	next(): Promise<Message> {
		const ready = this.pending.shift();
		if (ready !== undefined) {
			return Promise.resolve(ready);
		}
		if (this.failure !== undefined) {
			return Promise.reject(this.failure);
		}
		return new Promise<Message>((resolve, reject) => {
			this.waiting = resolve;
			this.failureWaiter = reject;
		});
	}

	private drain(): void {
		while (this.buffered.length >= 5) {
			const length = this.buffered.readInt32BE(1);
			if (this.buffered.length < length + 1) {
				return;
			}
			const message: Message = {
				type: this.buffered.toString("latin1", 0, 1),
				body: this.buffered.subarray(5, length + 1),
			};
			this.buffered = this.buffered.subarray(length + 1);
			const waiting = this.waiting;
			if (waiting === undefined) {
				this.pending.push(message);
			} else {
				this.waiting = undefined;
				this.failureWaiter = undefined;
				waiting(message);
			}
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		const waiter = this.failureWaiter;
		if (waiter !== undefined) {
			this.waiting = undefined;
			this.failureWaiter = undefined;
			waiter(error);
		}
	}
}

class PostgresConnection implements Driver {
	private queue: Promise<unknown> = Promise.resolve();
	private transactionDepth = 0;

	private readonly socket: Socket;
	private readonly stream: MessageStream;

	constructor(socket: Socket, stream: MessageStream) {
		this.socket = socket;
		this.stream = stream;
	}

	query<T>(sql: string, params: unknown[]): Promise<T[]> {
		return this.serialize(() =>
			params.length === 0 ? this.simpleQuery<T>(sql) : this.extendedQuery<T>(sql, params),
		);
	}

	async transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
		if (this.transactionDepth > 0) {
			return fn(this);
		}
		await this.query("BEGIN", []);
		this.transactionDepth += 1;
		try {
			const result = await fn(this);
			this.transactionDepth -= 1;
			await this.query("COMMIT", []);
			return result;
		} catch (error) {
			this.transactionDepth = 0;
			await this.query("ROLLBACK", []).catch(() => undefined);
			throw error;
		}
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this.socket.end(frame("X", Buffer.alloc(0)), () => resolve());
		});
	}

	private serialize<T>(run: () => Promise<T[]>): Promise<T[]> {
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private send(message: Buffer): void {
		this.socket.write(message);
	}

	private simpleQuery<T>(sql: string): Promise<T[]> {
		this.send(frame("Q", cstring(sql)));
		return this.collectRows<T>();
	}

	private extendedQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
		const encoded = params.map(encodeParameter);
		const parameterBlock = Buffer.concat(
			encoded.map((value) => {
				if (value === null) {
					const nullLength = Buffer.alloc(4);
					nullLength.writeInt32BE(-1);
					return nullLength;
				}
				const length = Buffer.alloc(4);
				length.writeInt32BE(value.length);
				return Buffer.concat([length, value]);
			}),
		);
		const counts = Buffer.alloc(4);
		counts.writeInt16BE(0, 0);
		counts.writeInt16BE(encoded.length, 2);
		const resultFormats = Buffer.alloc(2);
		resultFormats.writeInt16BE(0);

		this.send(
			Buffer.concat([
				frame("P", Buffer.concat([cstring(""), cstring(sql), Buffer.from([0, 0])])),
				frame(
					"B",
					Buffer.concat([cstring(""), cstring(""), counts, parameterBlock, resultFormats]),
				),
				frame("D", Buffer.concat([Buffer.from("P", "latin1"), cstring("")])),
				frame("E", Buffer.concat([cstring(""), Buffer.from([0, 0, 0, 0])])),
				frame("S", Buffer.alloc(0)),
			]),
		);
		return this.collectRows<T>();
	}

	private async collectRows<T>(): Promise<T[]> {
		let fields: Field[] = [];
		let rows: T[] = [];
		let failure: Error | undefined;

		for (;;) {
			const message = await this.stream.next();
			switch (message.type) {
				case "T": {
					fields = readRowDescription(message.body);
					rows = [];
					break;
				}
				case "D": {
					rows.push(readDataRow<T>(message.body, fields));
					break;
				}
				case "E": {
					failure ??= new PostgresServerError(readErrorFields(message.body));
					break;
				}
				case "Z": {
					if (failure !== undefined) {
						throw failure;
					}
					return rows;
				}
				default:
					break;
			}
		}
	}

	async authenticate(user: string, password: string, database: string): Promise<void> {
		this.send(startupMessage(user, database));
		const authentication = new AuthenticationExchange(password);

		for (;;) {
			const message = await this.stream.next();
			if (message.type === "E") {
				throw new PostgresServerError(readErrorFields(message.body));
			}
			if (message.type === "Z") {
				return;
			}
			if (message.type === "R") {
				const answer = authentication.answer(new MessageReader(message.body));
				if (answer !== undefined) {
					this.send(answer);
				}
			}
		}
	}
}

const AUTHENTICATION_OK = 0;
const AUTHENTICATION_CLEARTEXT_PASSWORD = 3;
const AUTHENTICATION_SASL = 10;
const AUTHENTICATION_SASL_CONTINUE = 11;
const AUTHENTICATION_SASL_FINAL = 12;

function startupMessage(user: string, database: string): Buffer {
	const startup = Buffer.concat([
		Buffer.alloc(8),
		cstring("user"),
		cstring(user),
		cstring("database"),
		cstring(database),
		Buffer.from([0]),
	]);
	startup.writeInt32BE(startup.length, 0);
	startup.writeInt32BE(PROTOCOL_VERSION_3, 4);
	return startup;
}

function readSaslMechanisms(reader: MessageReader): string[] {
	const mechanisms: string[] = [];
	while (!reader.exhausted) {
		const mechanism = reader.cstring();
		if (mechanism !== "") {
			mechanisms.push(mechanism);
		}
	}
	return mechanisms;
}

class AuthenticationExchange {
	private readonly password: string;
	private clientFirstBare = "";
	private expectedServerSignature: Buffer | undefined;

	constructor(password: string) {
		this.password = password;
	}

	answer(reader: MessageReader): Buffer | undefined {
		const kind = reader.int32();
		switch (kind) {
			case AUTHENTICATION_OK:
				return undefined;
			case AUTHENTICATION_CLEARTEXT_PASSWORD:
				return frame("p", cstring(this.password));
			case AUTHENTICATION_SASL:
				return this.startScram(readSaslMechanisms(reader));
			case AUTHENTICATION_SASL_CONTINUE:
				return this.finishScram(reader.rest().toString("utf8"));
			case AUTHENTICATION_SASL_FINAL:
				this.verifyServerSignature(reader.rest().toString("utf8"));
				return undefined;
			default:
				throw new Error(
					`the server requested an authentication method this client does not implement: ${kind}`,
				);
		}
	}

	private startScram(mechanisms: readonly string[]): Buffer {
		if (!mechanisms.includes(SCRAM_SHA_256)) {
			throw new Error(`the server offers only ${mechanisms.join(", ")}`);
		}
		this.clientFirstBare = `n=,r=${randomBytes(18).toString("base64")}`;
		const clientFirst = Buffer.from(`n,,${this.clientFirstBare}`, "utf8");
		const length = Buffer.alloc(4);
		length.writeInt32BE(clientFirst.length);
		return frame("p", Buffer.concat([cstring(SCRAM_SHA_256), length, clientFirst]));
	}

	private finishScram(serverFirst: string): Buffer {
		const final = scramClientFinal(this.password, this.clientFirstBare, serverFirst);
		this.expectedServerSignature = final.expectedServerSignature;
		return frame("p", Buffer.from(final.message, "utf8"));
	}

	private verifyServerSignature(serverFinal: string): void {
		const expected = this.expectedServerSignature;
		if (expected === undefined) {
			return;
		}
		const signature = Buffer.from(serverFinal.slice(2), "base64");
		if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
			throw new Error("the server signature did not verify");
		}
	}
}

function readRowDescription(body: Buffer): Field[] {
	const reader = new MessageReader(body);
	const count = reader.int16();
	const fields: Field[] = [];
	for (let index = 0; index < count; index += 1) {
		const name = reader.cstring();
		reader.int32();
		reader.int16();
		fields.push({ name, typeOid: reader.int32() });
		reader.int16();
		reader.int32();
		reader.int16();
	}
	return fields;
}

function readDataRow<T>(body: Buffer, fields: readonly Field[]): T {
	const reader = new MessageReader(body);
	const count = reader.int16();
	const row: Record<string, unknown> = {};
	for (let index = 0; index < count; index += 1) {
		const length = reader.int32();
		const raw = length === -1 ? null : reader.bytes(length);
		const field = fields[index];
		if (field !== undefined) {
			row[field.name] = decodeValue(raw, field.typeOid);
		}
	}
	return row as T;
}

function readErrorFields(body: Buffer): Map<string, string> {
	const reader = new MessageReader(body);
	const fields = new Map<string, string>();
	while (!reader.exhausted) {
		const key = reader.bytes(1).toString("latin1");
		if (key.charCodeAt(0) === 0) {
			break;
		}
		fields.set(key, reader.cstring());
	}
	return fields;
}

export interface TestConnection extends Driver {
	close(): Promise<void>;
}

export const FALLBACK_DATABASE_URL = "postgres://velve:velve@localhost:5432/velve_test";

export async function openTestConnection(
	url = process.env.VELVE_TEST_DATABASE_URL ?? FALLBACK_DATABASE_URL,
): Promise<TestConnection> {
	const parsed = new URL(url);
	const socket = connectSocket({
		host: parsed.hostname,
		port: Number(parsed.port === "" ? "5432" : parsed.port),
	});
	socket.setNoDelay(true);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});

	const connection = new PostgresConnection(socket, new MessageStream(socket));
	await connection.authenticate(
		decodeURIComponent(parsed.username),
		decodeURIComponent(parsed.password),
		parsed.pathname.slice(1),
	);
	return connection;
}
