import { describe, expect, it } from "vitest";
import { deriveAnalysisFindings, type EvidenceBundle, type EvidenceItem } from "../src/index.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";

function item(
	sourceType: EvidenceItem["sourceType"],
	label: string,
	content: string,
	metadata: Record<string, string | number | boolean | null> = {},
): EvidenceItem {
	return {
		ref: `${sourceType}:${label}`,
		sourceType,
		label,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata,
	};
}

describe("deriveAnalysisFindings", () => {
	it("preserves producer metadata and derives severity", () => {
		const bundle: EvidenceBundle = {
			applicationId: APP_ID,
			asOf: "2026-06-30T00:00:00.000Z",
			assembledAt: "2026-06-30T01:00:00.000Z",
			items: [
				item("context_signal", "Negative balance", "observed=2 status=review confidence=high", {
					status: "review",
					confidence: "high",
					metric: "negative_balance",
				}),
				item("document", "Bank statement", "closing balance 1200", {
					status: "mismatch",
				}),
				item("policy_section", "Credit policy", "DSCR must exceed 1.25x.", {}),
				item("score_reason", "Debt burden", "DEBT_BURDEN -40", {
					impact: "negative",
				}),
				item("case_fact", "Policy outcome", "refer", { field: "policy.outcome" }),
			],
			unavailable: [],
		};

		const findings = deriveAnalysisFindings(bundle);
		expect(findings.map((finding) => finding.kind)).toEqual([
			"context_signal",
			"document_finding",
			"policy_section",
			"score_factor",
			"policy_fact",
		]);
		expect(findings[0]).toMatchObject({
			severity: "medium",
			status: "review",
			confidence: "high",
			evidenceRefs: ["context_signal:Negative balance"],
		});
		expect(findings[1]?.severity).toBe("high");
		expect(findings[3]?.severity).toBe("medium");
	});
});
