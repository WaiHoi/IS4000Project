// T17 customer evidence crypto (SPEC-t17-t18 §2.2): AES-256-GCM with a
// fresh 12-byte nonce per file and customer AAD
// `customerDocumentId|customerId|cryptoVersion` — deliberately distinct from
// the T01 application AAD, so a blob from one root never decrypts in the
// other. Cipher primitives (key parsing, sha256) are reused from T01; blob
// IO reuses the T01 storage helpers parameterized by root, so the T01 app
// orphan sweep (scoped to DOCUMENT_STORAGE_DIR) can never touch
// CUSTOMER_STORAGE_DIR.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
	CRYPTO_VERSION,
	parseEncryptionKey,
	parsePreviousKeys,
	sha256Hex,
} from "../documents/crypto.js";

export { CRYPTO_VERSION, parseEncryptionKey, parsePreviousKeys, sha256Hex };

const NONCE_BYTES = 12;

export function customerAadFor(
	customerDocumentId: string,
	customerId: string,
	cryptoVersion: string,
): Buffer {
	return Buffer.from(`${customerDocumentId}|${customerId}|${cryptoVersion}`, "utf8");
}

/** Server-generated key `<customerId>/<customerDocumentId>.enc` under the
 * customer root — same sharding shape as T01, a disjoint root. */
export function customerStorageKeyFor(customerId: string, customerDocumentId: string): string {
	return `${customerId}/${customerDocumentId}.enc`;
}

export interface CustomerEncryptInput {
	plaintext: Buffer;
	customerDocumentId: string;
	customerId: string;
	key: Buffer;
	keyId: string;
}

export interface CustomerEncryptedBlob {
	ciphertext: Buffer;
	nonceB64: string;
	tagB64: string;
	keyId: string;
	cryptoVersion: string;
}

export function encryptCustomerDocument(input: CustomerEncryptInput): CustomerEncryptedBlob {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
	cipher.setAAD(customerAadFor(input.customerDocumentId, input.customerId, CRYPTO_VERSION));
	const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
	return {
		ciphertext,
		nonceB64: nonce.toString("base64"),
		tagB64: cipher.getAuthTag().toString("base64"),
		keyId: input.keyId,
		cryptoVersion: CRYPTO_VERSION,
	};
}

export interface CustomerDecryptInput {
	ciphertext: Buffer;
	nonceB64: string;
	tagB64: string;
	customerDocumentId: string;
	customerId: string;
	cryptoVersion: string;
	keyId: string;
	keys: Map<string, Buffer>;
}

/** Wrong key/nonce/tag/AAD all fail closed with one error (no oracle). */
export function decryptCustomerDocument(input: CustomerDecryptInput): Buffer {
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
		decipher.setAAD(
			customerAadFor(input.customerDocumentId, input.customerId, input.cryptoVersion),
		);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
	} catch {
		throw new Error("decrypt failed");
	}
}
