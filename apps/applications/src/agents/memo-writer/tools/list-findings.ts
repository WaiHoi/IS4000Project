// Read-only findings view over the evidence bundle: producer metadata
// (signal status/confidence, document state, score impact) without a second
// analysis pass. Exact quotes still come from get_evidence.
import {
	ANALYSIS_FINDING_KINDS,
	ANALYSIS_SEVERITIES,
	deriveAnalysisFindings,
	type EvidenceBundle,
} from "@credit/core";
import { z } from "zod";
import {
	clampLimit,
	sourceTypeByRef,
	toolError,
	uniqueSourceTypes,
	type EvidenceJsonParams,
	type MemoToolOutcome,
} from "./shared.js";

export const name = "list_findings" as const;

export const description =
	"List typed findings (context signals, document findings, policy sections, research, score factors) with severity and evidence refs. Use this to reconcile sources; use get_evidence for exact quotes.";

const kindList: string[] = [...ANALYSIS_FINDING_KINDS];
const severityList: string[] = [...ANALYSIS_SEVERITIES];

export const listFindingsParams = z
	.object({
		kind: z.enum(ANALYSIS_FINDING_KINDS).optional(),
		severity: z.enum(ANALYSIS_SEVERITIES).optional(),
		limit: z.number().int().min(1).max(50).optional(),
	})
	.strict();

export const listFindingsJsonParams: EvidenceJsonParams = {
	type: "object",
	properties: {
		kind: { type: "string", enum: kindList },
		severity: { type: "string", enum: severityList },
		limit: { type: "integer", minimum: 1, maximum: 50 },
	},
	required: [],
	additionalProperties: true,
};

export function runListFindings(
	params: Record<string, unknown>,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	const kind = params["kind"];
	if (kind !== undefined && (typeof kind !== "string" || !kindList.includes(kind))) {
		return toolError("unknown finding kind");
	}
	const severity = params["severity"];
	if (
		severity !== undefined &&
		(typeof severity !== "string" || !severityList.includes(severity))
	) {
		return toolError("unknown finding severity");
	}
	const limit = clampLimit(params["limit"], 50, 50);
	const findings = deriveAnalysisFindings(evidence).filter(
		(finding) =>
			(kind === undefined || finding.kind === kind) &&
			(severity === undefined || finding.severity === severity),
	);
	const items = findings.slice(0, limit).map((finding) => ({
		id: finding.id,
		kind: finding.kind,
		title: finding.title,
		detail: finding.detail.slice(0, 300),
		severity: finding.severity,
		status: finding.status,
		confidence: finding.confidence,
		evidenceRefs: finding.evidenceRefs,
	}));
	const refs = [...new Set(items.flatMap((finding) => finding.evidenceRefs))];
	return {
		payload: { total: findings.length, items },
		resultCount: items.length,
		sourceTypes: uniqueSourceTypes(refs, sourceTypeByRef(evidence)),
		refs,
	};
}
