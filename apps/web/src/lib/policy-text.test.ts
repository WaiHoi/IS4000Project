import { describe, expect, it } from "vitest";
import { policyParagraphs, policyQuote } from "./policy-text";

describe("policy-text", () => {
	it("collapses hard-wrapped source lines", () => {
		expect(
			policyParagraphs(
				"SME borrowers are graded quarterly on account conduct, cheque returns, and\nutilisation patterns. Two cheque returns in 90 days trigger review.",
			),
		).toEqual([
			"SME borrowers are graded quarterly on account conduct, cheque returns, and utilisation patterns. Two cheque returns in 90 days trigger review.",
		]);
	});

	it("keeps blank-line paragraph breaks", () => {
		expect(policyParagraphs("First paragraph\nwraps here.\n\nSecond paragraph.")).toEqual([
			"First paragraph wraps here.",
			"Second paragraph.",
		]);
	});

	it("handles CRLF and empty input", () => {
		expect(policyParagraphs("line one\r\nline two\r\n\r\nlast")).toEqual([
			"line one line two",
			"last",
		]);
		expect(policyParagraphs("")).toEqual([]);
	});

	it("collapses a quoted snippet to one flow", () => {
		expect(policyQuote("SME term applications are processed between S$5,000 and\nS$100,000.")).toBe(
			"SME term applications are processed between S$5,000 and S$100,000.",
		);
	});
});
