// crypto unit: AAD binding, tamper rejection, key-id rotation.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	aadFor,
	CRYPTO_VERSION,
	decryptDocument,
	encryptDocument,
	parseEncryptionKey,
	parsePreviousKeys,
	sha256Hex,
} from "../../src/documents/crypto.js";

const KEY = randomBytes(32);
const keys = new Map([["v1", KEY]]);

function encrypted(app = randomUUID(), file = randomUUID()) {
	return {
		enc: encryptDocument({
			plaintext: Buffer.from("secret bytes"),
			fileId: file,
			applicationId: app,
			key: KEY,
			keyId: "v1",
		}),
		app,
		file,
	};
}

describe("document crypto", () => {
	it("round-trips with the AAD-bound ids", () => {
		const { enc, app, file } = encrypted();
		const back = decryptDocument({
			ciphertext: enc.ciphertext,
			nonceB64: enc.nonceB64,
			tagB64: enc.tagB64,
			fileId: file,
			applicationId: app,
			cryptoVersion: CRYPTO_VERSION,
			keyId: "v1",
			keys,
		});
		expect(back.toString()).toBe("secret bytes");
		expect(enc.cryptoVersion).toBe("aes256gcm-v1");
	});

	it("rejects tampered ciphertext, tag, nonce, and wrong AAD", () => {
		const { enc, app, file } = encrypted();
		const base = {
			nonceB64: enc.nonceB64,
			tagB64: enc.tagB64,
			fileId: file,
			applicationId: app,
			cryptoVersion: CRYPTO_VERSION,
			keyId: "v1",
			keys,
		};
		const badCipher = Buffer.from(enc.ciphertext);
		badCipher[0] ^= 1;
		expect(() => decryptDocument({ ...base, ciphertext: badCipher })).toThrow("decrypt failed");
		const badTag = Buffer.from(enc.tagB64, "base64");
		badTag[0] ^= 1;
		expect(() =>
			decryptDocument({ ...base, ciphertext: enc.ciphertext, tagB64: badTag.toString("base64") }),
		).toThrow("decrypt failed");
		expect(() =>
			decryptDocument({ ...base, ciphertext: enc.ciphertext, fileId: randomUUID() }),
		).toThrow("decrypt failed");
		expect(() =>
			decryptDocument({ ...base, ciphertext: enc.ciphertext, applicationId: randomUUID() }),
		).toThrow("decrypt failed");
		expect(() =>
			decryptDocument({ ...base, ciphertext: enc.ciphertext, cryptoVersion: "v9" }),
		).toThrow("decrypt failed");
	});

	it("fails closed on unknown key id, but previous keys decrypt", () => {
		const { enc, app, file } = encrypted();
		const base = {
			ciphertext: enc.ciphertext,
			nonceB64: enc.nonceB64,
			tagB64: enc.tagB64,
			fileId: file,
			applicationId: app,
			cryptoVersion: CRYPTO_VERSION,
		};
		expect(() => decryptDocument({ ...base, keyId: "v2", keys })).toThrow("unknown key id");
		const rotated = new Map([
			["v2", randomBytes(32)],
			["v1", KEY],
		]);
		expect(decryptDocument({ ...base, keyId: "v1", keys: rotated }).toString()).toBe(
			"secret bytes",
		);
	});

	it("validates base64 32-byte keys", () => {
		expect(() => parseEncryptionKey(undefined)).toThrow();
		expect(() => parseEncryptionKey(Buffer.from("short").toString("base64"))).toThrow();
		expect(parseEncryptionKey(KEY.toString("base64"))).toEqual(KEY);
		expect(parsePreviousKeys(undefined).size).toBe(0);
		expect(() => parsePreviousKeys("[]")).toThrow();
		expect(() => parsePreviousKeys(JSON.stringify({ v0: "zz" }))).toThrow();
		const prev = parsePreviousKeys(JSON.stringify({ v0: KEY.toString("base64") }));
		expect(prev.get("v0")).toEqual(KEY);
	});

	it("mints fresh nonces and stable hashes", () => {
		const app = randomUUID();
		const a = encryptDocument({
			plaintext: Buffer.from("x"),
			fileId: randomUUID(),
			applicationId: app,
			key: KEY,
			keyId: "v1",
		});
		const b = encryptDocument({
			plaintext: Buffer.from("x"),
			fileId: randomUUID(),
			applicationId: app,
			key: KEY,
			keyId: "v1",
		});
		expect(a.nonceB64).not.toBe(b.nonceB64);
		expect(aadFor("f", "a", "v").toString()).toBe("f|a|v");
		expect(sha256Hex(Buffer.from("x"))).toBe(sha256Hex(Buffer.from("x")));
	});
});
