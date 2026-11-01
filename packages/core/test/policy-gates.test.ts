import { describe, expect, it } from "vitest";
import { directIdentifierKind, hasDirectIdentifier } from "../src/policy-gates.js";

describe("directIdentifierKind and UUIDs", () => {
	it("does not read system UUIDs as phones or long ids", () => {
		// Real ids from a demo case: a phone-shaped tail and a long digit group.
		expect(directIdentifierKind("See document b4a60707-fb79-48af-9466-564d99063211.")).toBeNull();
		expect(hasDirectIdentifier("Account aaaaaaaa-aaaa-4aaa-8aaa-000000000001 is overdrawn.")).toBe(
			false,
		);
	});

	it("still catches identifiers next to a UUID", () => {
		expect(directIdentifierKind("b4a60707-fb79-48af-9466-564d99063211 call 9123 4567")).toBe(
			"phone",
		);
		expect(directIdentifierKind("+65-6100-8818")).toBe("phone");
		expect(directIdentifierKind("NRIC S1234567A")).toBe("nric");
		expect(directIdentifierKind("jane@example.com")).toBe("email");
		expect(directIdentifierKind("card 4111 1111 1111 1111")).toBe("long_id");
	});
});
