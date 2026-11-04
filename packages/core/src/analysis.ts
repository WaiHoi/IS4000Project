// Typed findings derived from the EN-01 evidence bundle. Producers already
// attach the useful metadata (context signal status/confidence, document
// status, score impact); this module preserves it so the memo agent can
// reconcile findings instead of re-deriving them from flat prose.
import type { EvidenceBundle, EvidenceItem } from "./evidence.js";

export const ANALYSIS_FINDING_KINDS = [
	"context_signal",
	"policy_section",
	"document_finding",
	"external_report",
	"score_factor",
	"policy_fact",
	"case_fact",
	"security",
] as const;

export type AnalysisFindingKind = (typeof ANALYSIS_FINDING_KINDS)[number];

export const ANALYSIS_SEVERITIES = ["info", "low", "medium", "high"] as const;

export type AnalysisSeverity = (typeof ANALYSIS_SEVERITIES)[number];

export interface AnalysisFinding {
	/** Stable id: the underlying evidence ref. */
	id: string;
	kind: AnalysisFindingKind;
	title: string;
	detail: string;
	severity: AnalysisSeverity;
	status: string | null;
	confidence: string | null;
	evidenceRefs: string[];
	metadata: Record<string, string | number | boolean | null>;
}

const SEVERITY_BY_STATUS: Record<string, AnalysisSeverity> = {
	breach: "high",
	alert: "high",
	critical: "high",
	failed: "high",
	mismatch: "high",
	stale: "medium",
	warning: "medium",
	watch: "medium",
	review: "medium",
	pass: "info",
	match: "info",
	verified: "info",
};

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function scalar(value: unknown): string | number | boolean | null {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? value
		: null;
}

function kindOf(item: EvidenceItem): AnalysisFindingKind {
	if (item.sourceType === "document") return "document_finding";
	if (item.sourceType === "external_evidence") return "external_report";
	if (item.sourceType === "score_reason") return "score_factor";
	if (item.sourceType === "policy_section") return "policy_section";
	if (item.sourceType === "context_signal") return "context_signal";
	const field = text(item.metadata["field"]);
	if (field?.startsWith("policy.")) return "policy_fact";
	if (field === "security.status") return "security";
	return "case_fact";
}

function severityOf(item: EvidenceItem, kind: AnalysisFindingKind): AnalysisSeverity {
	const status = text(item.metadata["status"]);
	if (status !== null && SEVERITY_BY_STATUS[status] !== undefined) {
		return SEVERITY_BY_STATUS[status]!;
	}
	if (kind === "score_factor" && text(item.metadata["impact"]) === "negative") return "medium";
	if (kind === "external_report") return "medium";
	if (kind === "context_signal") return "medium";
	return "info";
}

/** One finding per evidence item. SourceRefs double as finding ids so the
 * agent's citation refs and finding refs stay the same stable key. */
export function deriveAnalysisFindings(bundle: EvidenceBundle): AnalysisFinding[] {
	return bundle.items.map((item) => {
		const kind = kindOf(item);
		return {
			id: item.ref,
			kind,
			title: item.label,
			detail: item.content.slice(0, 600),
			severity: severityOf(item, kind),
			status: text(item.metadata["status"]) ?? text(item.metadata["reviewStatus"]),
			confidence: text(item.metadata["confidence"]),
			evidenceRefs: [item.ref],
			metadata: Object.fromEntries(
				Object.entries(item.metadata)
					.map(([key, value]) => [key, scalar(value)] as const)
					.filter(([, value]) => value !== null),
			),
		};
	});
}
