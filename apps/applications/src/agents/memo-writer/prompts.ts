import { loadInstructions } from "@credit/agent-kit";
import { deriveAnalysisFindings, type CreditMemoContent, type EvidenceBundle } from "@credit/core";
import type { applications } from "@credit/db/applications";
import { STYLE_REWRITE_MEMO_SECTIONS } from "../../assist/memo.js";
import { buildDraftRepairPrompt } from "../shared/repair.js";

type ApplicationRow = typeof applications.$inferSelect;

/** Static system prompt (instructions.md, byte-exact). */
export const SYSTEM_PROMPT = loadInstructions(import.meta.url);

export function buildInitialPrompt(
	application: ApplicationRow,
	evidence: EvidenceBundle,
	base?: CreditMemoContent,
): string {
	const findings = deriveAnalysisFindings(evidence);
	const rewrite = new Set<string>(STYLE_REWRITE_MEMO_SECTIONS);
	const baseSections = base?.sections
		.filter((section) => rewrite.has(section.key))
		.map((section) => ({ key: section.key, title: section.title, claims: section.claims }));
	return (
		`Draft the credit memorandum for application ${application.reference} ` +
		`(${application.type}, ${application.product}). The evidence bundle holds ` +
		`${evidence.items.length} items, ${findings.length} findings, and ` +
		`${evidence.unavailable.length} unavailable sources; it is visible only through ` +
		`the evidence tools. Start with list_findings and list_evidence.` +
		(baseSections && baseSections.length > 0
			? ` Rewrite these deterministic sections for tone only; keep every figure, ` +
				`citation ref and security meaning: ${JSON.stringify(baseSections)}. ` +
				`Return them with claims, not notAvailable. Leave policy_compliance empty.`
			: "")
	);
}

export function buildRepairPrompt(
	previousOutput: string,
	issues: Array<{ code: string; path: string }>,
	requireTools: boolean,
): string {
	const tooling = requireTools
		? "You must call the evidence tools before returning the corrected draft: cite only refs the tools returned and cover every evidence category."
		: "Use the evidence tools if you need exact quotes.";
	return buildDraftRepairPrompt({ previousOutput, issues, cited: "claim", tooling });
}
