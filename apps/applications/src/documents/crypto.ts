// T01 document encryption at rest (SPEC-t01-t02 §6.5): AES-256-GCM with a
// fresh 12-byte nonce per file and AAD `documentFileId|applicationId|
// cryptoVersion`. Key rotation is decrypt-only: the active key encrypts,
// previous keys (DOCUMENT_PREVIOUS_KEYS JSON map) decrypt old blobs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CRYPTO_VERSION = "aes256gcm-v1";
const NONCE_BYTES = 12;

export interface EncryptInput {
	plaintext: Buffer;
	fileId: string;
	applicationId: string;
	key: Buffer;
	keyId: string;
}

export interface EncryptedBlob {
	ciphertext: Buffer;
	nonceB64: string;
	tagB64: string;
	keyId: string;
	cryptoVersion: string;
}

export function aadFor(fileId: string, applicationId: string, cryptoVersion: string): Buffer {
	return Buffer.from(`${fileId}|${applicationId}|${cryptoVersion}`, "utf8");
}

/** base64 32-byte key or throw (fail closed at upload time, never boot). */
export function parseEncryptionKey(raw: string | undefined): Buffer {
	if (!raw) throw new Error("DOCUMENT_ENCRYPTION_KEY is required");
	let key: Buffer;
	try {
		key = Buffer.from(raw.trim(), "base64");
	} catch {
		throw new Error("DOCUMENT_ENCRYPTION_KEY must be base64");
	}
	if (key.length !== 32) throw new Error("DOCUMENT_ENCRYPTION_KEY must decode to 32 bytes");
	return key;
}

/** Optional JSON map `{keyId: base64Key}` for decrypting rotated blobs. */
export function parsePreviousKeys(raw: string | undefined): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	if (!raw) return out;
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("DOCUMENT_PREVIOUS_KEYS must be a JSON object");
	}
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "string") throw new Error("DOCUMENT_PREVIOUS_KEYS values must be base64");
		const key = Buffer.from(value.trim(), "base64");
		if (key.length !== 32) throw new Error("DOCUMENT_PREVIOUS_KEYS values must decode to 32 bytes");
		out.set(id, key);
	}
	return out;
}

export function encryptDocument(input: EncryptInput): EncryptedBlob {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
	cipher.setAAD(aadFor(input.fileId, input.applicationId, CRYPTO_VERSION));
	const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
	return {
		ciphertext,
		nonceB64: nonce.toString("base64"),
		tagB64: cipher.getAuthTag().toString("base64"),
		keyId: input.keyId,
		cryptoVersion: CRYPTO_VERSION,
	};
}

export interface DecryptInput {
	ciphertext: Buffer;
	nonceB64: string;
	tagB64: string;
	fileId: string;
	applicationId: string;
	cryptoVersion: string;
	keyId: string;
	keys: Map<string, Buffer>;
}

/** Wrong key/nonce/tag/AAD all fail closed with one error (no oracle). */
export function decryptDocument(input: DecryptInput): Buffer {
	const key = input.keys.get(input.keyId);
	if (!key) throw new Error("unknown key id");
	let nonce: Buffer;
	let tag: Buffer;
	try {
		nonce = Buffer.from(input.nonceB64, "base64");
		tag = Buffer.from(input.tagB64, "base64");
	} catch {
		throw new Error("decrypt failed");
	}
	if (nonce.length !== NONCE_BYTES || tag.length !== 16) throw new Error("decrypt failed");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(aadFor(input.fileId, input.applicationId, input.cryptoVersion));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
	} catch {
		throw new Error("decrypt failed");
	}
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
