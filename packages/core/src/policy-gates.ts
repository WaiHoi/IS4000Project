// Shared deterministic policy gates and sanitizers (core).
//
// The policy service uses these for officer questions; the applications
// case-policy navigator uses the same functions for follow-up questions and
// memo text. Keeping them in core prevents the two services from drifting.

import { createHmac } from "node:crypto";
import { escapeRegExp } from "./text.js";

const OUT_OF_SCOPE = [
	"aml",
	"anti-money",
	"money laundering",
	"sanction",
	"kyc",
	"know your customer",
	"identity verification",
	"privacy",
	"gdpr",
	"pdpa",
	"information security",
	"infosec",
	"cyber",
	"hr",
	"human resources",
	"employee",
	"conduct",
	"complaint",
	"procurement",
	"vendor",
	"esg",
	"sustainability",
	"tax",
	"accounting",
	"operational risk",
];

const CREDIT_TERMS = [
	"credit",
	"loan",
	"underwriting",
	"affordability",
	"dscr",
	"dti",
	"tdsr",
	"income",
	"debt",
	"obligation",
	"document",
	"exception",
	"pricing",
	"rate",
	"servicing",
	"repayment",
	"arrears",
	"collateral",
	"guarantee",
	"policy",
	"sme",
	"individual",
	"mitigant",
	"approver",
];

/** Deterministic scope gate. Ambiguous credit questions proceed to
 * retrieval; an explicit out-of-domain question with no credit term does not
 * call the embedder/answerer. */
export function classifyPolicyScope(question: string): "credit" | "out_of_scope" {
	const q = question.toLowerCase();
	const hasCredit = CREDIT_TERMS.some((term) => q.includes(term));
	const hasOut = OUT_OF_SCOPE.some((term) => q.includes(term));
	if (hasOut && !hasCredit) return "out_of_scope";
	return "credit";
}

export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/i;
export const PHONE_RE = /(?:\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}\b/;
const LONG_ID_RE = /\b(?:\d[ -]?){10,19}\b/;

/** Direct identifiers must never reach the embedding provider. */
export type DirectIdentifierKind = "email" | "nric" | "phone" | "long_id";

// System ids are not personal data, but their hex groups can contain digit
// runs that look like a phone (…564d99063211 → 99063211) or a long id
// (…-000000000001). Blank whole UUIDs out before scanning so a cited
// evidence id never reads as PII; text around them is still checked.
const UUID_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Which kind of direct identifier the text contains (never the value), or null. */
export function directIdentifierKind(input: string): DirectIdentifierKind | null {
	const text = input.replace(UUID_GLOBAL_RE, " ");
	if (EMAIL_RE.test(text)) return "email";
	if (NRIC_RE.test(text)) return "nric";
	if (PHONE_RE.test(text)) return "phone";
	if (LONG_ID_RE.test(text)) return "long_id";
	return null;
}

export function hasDirectIdentifier(question: string): boolean {
	return directIdentifierKind(question) !== null;
}

export function hmacQuestion(secret: string, question: string): string {
	return createHmac("sha256", secret).update(question.trim()).digest("hex");
}

/** Replace known case identity values with neutral placeholders before a
 * retrieval query leaves the case boundary. Long values are matched first. */
export function scrubKnownPii(text: string, values: readonly string[]): string {
	let out = text;
	const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
		.sort((a, b) => b.length - a.length)
		.slice(0, 100);
	for (const value of unique) {
		if (value.length < 3) continue;
		out = out.replaceAll(new RegExp(escapeRegExp(value), "gi"), "[case party]");
	}
	return out;
}

/** Action/decision language that must never appear in advisory navigator
 * output. Descriptors (score, limit, rate, terms) are allowed. */
const ADVISORY_ACTION_RE =
	/\b(?:approv(?:e|ed|es|al|ing)|declin(?:e|ed|es|ing)|reject(?:ed|ion|ing|s)?|recommend(?:ed|ation|ations|ing|s)?|decision(?:s)?)\b/i;

/** The matched advisory term (safe to log: one word, never the text). */
export function advisoryActionMatch(text: string): string | null {
	const match = ADVISORY_ACTION_RE.exec(
		text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]+/g, " "),
	);
	return match?.[0].toLowerCase() ?? null;
}

export function containsAdvisoryActionLanguage(text: string): boolean {
	return advisoryActionMatch(text) !== null;
}
