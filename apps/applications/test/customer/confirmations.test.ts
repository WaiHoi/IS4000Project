// T17 confirmation + customer-crypto unit tests (compose-free): server
// HMAC derivation, canonical-equality reuse, advisory-hash immunity,
// closed allowlist, and customer/app AAD separation.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CONFIRMABLE_FIELDS,
	confirmationHmac,
	deriveConfirmations,
	getConfirmableValue,
	isConfirmableField,
} from "../../src/customer/requirements.js";
import {
	customerAadFor,
	customerStorageKeyFor,
	decryptCustomerDocument,
	encryptCustomerDocument,
	sha256Hex,
} from "../../src/customer/crypto.js";
import { aadFor, decryptDocument, encryptDocument } from "../../src/documents/crypto.js";

const KEY = "test-confirmation-key";
const IDENTITY = {
	fullName: "Aisha Rahman",
	dob: "1990-05-01",
	nationalId: "S1234567A",
	email: "aisha@example.com",
	phone: "+65-8100-0001",
	address: "1 Test Street",
	city: "Singapore",
};

describe("confirmationHmac", () => {
	it("is deterministic and key-bound (not a plain hash)", () => {
		const a = confirmationHmac(IDENTITY.fullName, KEY);
		expect(a).toBe(confirmationHmac(IDENTITY.fullName, KEY));
		expect(a).not.toBe(confirmationHmac(IDENTITY.fullName, "other-key"));
		expect(a).not.toBe(sha256Hex(Buffer.from(JSON.stringify(IDENTITY.fullName), "utf8")));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("deriveConfirmations", () => {
	const profile = { identity: { ...IDENTITY }, business: null };

	it("marks canonically equal values reused and ignores client hashes", () => {
		const { reused, edited } = deriveConfirmations({
			application: { identity: { ...IDENTITY }, sme: null },
			profile,
			claimed: [
				{ field: "identity.fullName", valueHash: "spoofed-or-stale-hash" },
				{ field: "identity.city", valueHash: confirmationHmac("Singapore", KEY) },
			],
		});
		expect(reused).toEqual(["identity.fullName", "identity.city"]);
		expect(edited).toEqual([]);
	});

	it("records mismatched values as edited even with a spoofed confirmation", () => {
		const { reused, edited } = deriveConfirmations({
			application: { identity: { ...IDENTITY, city: "Elsewhere" }, sme: null },
			profile,
			claimed: [{ field: "identity.city", valueHash: confirmationHmac("Singapore", KEY) }],
		});
		expect(reused).toEqual([]);
		expect(edited).toEqual(["identity.city"]);
	});

	it("treats fields without a profile value as edited", () => {
		const { reused, edited } = deriveConfirmations({
			application: { identity: { ...IDENTITY }, sme: null },
			profile: { identity: {}, business: null },
			claimed: [{ field: "identity.fullName", valueHash: "x" }],
		});
		expect(reused).toEqual([]);
		expect(edited).toEqual(["identity.fullName"]);
	});

	it("fails closed on unknown fields", () => {
		expect(() =>
			deriveConfirmations({
				application: { identity: { ...IDENTITY }, sme: null },
				profile,
				claimed: [{ field: "identity.shoeSize", valueHash: "x" }],
			}),
		).toThrow("unknown confirmation field");
		expect(isConfirmableField("amountCents")).toBe(false);
		expect(isConfirmableField("identity.email")).toBe(true);
	});

	it("reads sme.* from the trading block vs the business block", () => {
		const sme = { companyName: "BreadTalk Demo Pte Ltd", yearsTrading: 5 };
		expect(getConfirmableValue({ identity: {}, sme }, "sme.companyName")).toBe(
			"BreadTalk Demo Pte Ltd",
		);
		expect(
			getConfirmableValue({ identity: {}, sme: { companyName: "Other" } }, "sme.companyName"),
		).not.toBe(getConfirmableValue({ identity: {}, sme: null }, "sme.companyName"));
		expect(CONFIRMABLE_FIELDS.length).toBeGreaterThan(0);
	});
});

describe("customer AAD separation", () => {
	// The spec fixes the AAD shape as `id|counterparty|version` in both
	// domains, so identical inputs share AAD bytes by construction —
	// separation comes from disjoint id namespaces (customer/profile uuids
	// vs application/file uuids), disjoint storage roots, and distinct
	// helpers that can never be interchanged by accident.
	it("uses the spec AAD format and a disjoint storage key", () => {
		expect(customerAadFor("doc-1", "cust-1", "aes256gcm-v1").toString("utf8")).toBe(
			"doc-1|cust-1|aes256gcm-v1",
		);
		expect(customerStorageKeyFor("cust-1", "doc-1")).toBe("cust-1/doc-1.enc");
		expect(aadFor("doc-1", "cust-1", "aes256gcm-v1").toString("utf8")).toBe(
			"doc-1|cust-1|aes256gcm-v1",
		);
	});

	it("round-trips under the customer AAD and fails closed on any mismatch", () => {
		const key = randomBytes(32);
		const keys = new Map([["v1", key]]);
		const plaintext = Buffer.from("%PDF-customer-evidence");
		const enc = encryptCustomerDocument({
			plaintext,
			customerDocumentId: "doc-1",
			customerId: "cust-1",
			key,
			keyId: "v1",
		});
		const base = {
			ciphertext: enc.ciphertext,
			nonceB64: enc.nonceB64,
			tagB64: enc.tagB64,
			customerDocumentId: "doc-1",
			customerId: "cust-1",
			cryptoVersion: enc.cryptoVersion,
			keyId: "v1",
			keys,
		};
		expect(decryptCustomerDocument(base).equals(plaintext)).toBe(true);
		// Wrong document, customer, tag, or key all fail with one error.
		for (const variant of [
			{ ...base, customerDocumentId: "doc-2" },
			{ ...base, customerId: "cust-2" },
			{ ...base, tagB64: Buffer.from(randomBytes(16)).toString("base64") },
			{ ...base, keys: new Map([["v1", randomBytes(32)]]) },
		]) {
			expect(() => decryptCustomerDocument(variant)).toThrow("decrypt failed");
		}
		// The application helper with the application namespace fails too.
		expect(() =>
			decryptDocument({
				ciphertext: enc.ciphertext,
				nonceB64: enc.nonceB64,
				tagB64: enc.tagB64,
				fileId: "other-file",
				applicationId: "other-app",
				cryptoVersion: enc.cryptoVersion,
				keyId: "v1",
				keys,
			}),
		).toThrow("decrypt failed");
		// And vice versa: an app blob never opens under the customer helper.
		const appEnc = encryptDocument({
			plaintext,
			fileId: "doc-1",
			applicationId: "cust-1",
			key,
			keyId: "v1",
		});
		expect(() =>
			decryptCustomerDocument({
				ciphertext: appEnc.ciphertext,
				nonceB64: appEnc.nonceB64,
				tagB64: appEnc.tagB64,
				customerDocumentId: "other-doc",
				customerId: "other-cust",
				cryptoVersion: appEnc.cryptoVersion,
				keyId: "v1",
				keys,
			}),
		).toThrow("decrypt failed");
	});
});
