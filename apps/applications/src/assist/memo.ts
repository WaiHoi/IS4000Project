// EN-01/EN-02 deterministic credit-memo builder: evidence bundle -> CreditMemoContent.
//
// Pure: no clock, no DB, no logging. Every narrative claim cites bundle items
// (quotes are exact item content). Free text is static or number-formatted so
// it passes the EN-03 decision-language, PII, and protected-attribute scans:
// in particular the words "term", "score", "rate", "limit" and decision verbs
// never appear in claims.
import {
	FACTOR_LABELS,
	containsDecisionLanguage,
	parseSourceRef,
	type CreditMemoContent,
	type EvidenceBundle,
	type EvidenceItem,
	type OpenItem,
} from "@credit/core";
import type { applications } from "@credit/db/applications";

export interface MemoInput {
	application: typeof applications.$inferSelect;
	evidence: EvidenceBundle;
}

type ApplicationRow = typeof applications.$inferSelect;
type MemoSection = CreditMemoContent["sections"][number];

const POLICY_RISK_TEXT: Record<string, string> = {
	SCORE_TOO_LOW: "The assessment factor is below the preferred minimum.",
	SCORE_IN_REFER_BAND: "The assessment factor is within the review band.",
	AMOUNT_ABOVE_AUTO_LIMIT: "The requested amount exceeds the automatic processing threshold.",
	AMOUNT_OUT_OF_RANGE: "The requested amount is outside the supported range.",
	TERM_OUT_OF_RANGE: "The requested duration is outside the supported range.",
	DTI_TOO_HIGH: "Debt-to-income is above the preferred maximum.",
	DTI_IN_REFER_BAND: "Debt-to-income is within the review band.",
	DSCR_TOO_LOW: "Debt-service coverage is below the preferred minimum.",
	DSCR_IN_REFER_BAND: "Debt-service coverage is within the review band.",
	SECTOR_REVIEW: "The sector is flagged for officer awareness.",
	SHORT_EMPLOYMENT: "Employment history is below the preferred tenure.",
	TRADING_HISTORY_TOO_SHORT: "Trading history is below the preferred minimum.",
	TRADING_HISTORY_IN_REFER_BAND: "Trading history is within the review band.",
	REVENUE_TOO_LOW: "Revenue is below the preferred minimum.",
};

const POLICY_RISK_FALLBACK = "A policy evaluation reason is recorded for officer review.";

const OFFICER_QUESTIONS = [
	"What is the current status of the requested documents?",
	"Are the latest financial statements available for review?",
	"Does the bank statement cover the required lookback period?",
	"Are there any outstanding open items that need follow-up?",
];

/** Sections the agent may rewrite for tone; the code keeps the facts. */
export const STYLE_REWRITE_MEMO_SECTIONS = [
	"request",
	"financial_analysis",
	"debt_service",
	"collateral_security",
] as const;

/** Sections code owns outright; `policy_compliance` is never model-written. */
export const DETERMINISTIC_MEMO_SECTIONS = [
	...STYLE_REWRITE_MEMO_SECTIONS,
	"policy_compliance",
] as const;

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function formatUSD(cents: number): string {
	return `USD ${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

/** Display a money value: row value first, else a numeric case-fact content, else null. */
function moneyText(rowValue: unknown, content: string): string | null {
	const cents =
		asNumber(rowValue) ?? (/^\d+$/.test(content.trim()) ? Number(content.trim()) : null);
	return cents !== null && Number.isFinite(cents) ? formatUSD(cents) : null;
}

function citationOf(item: EvidenceItem): { ref: string; quote: string } {
	// ponytail: the validator caps quotes at 4,000 chars; a longer source
	// excerpt is truncated to an exact prefix. Align the caps if evidence
	// excerpts grow.
	return { ref: item.ref, quote: item.content.slice(0, 4_000) };
}

function productLabel(product: string): string {
	if (product === "sme_term_loan") return "SME lending product";
	if (product === "personal_loan") return "personal loan product";
	// ponytail: "term" is banned by the EN-03 decision-language scan.
	return product.replaceAll("_", " ").replace(/\bterm\b/g, "duration");
}

/** Only interpolate short identifier-ish values into free text (PII-scan safety). */
function safeToken(value: string): boolean {
	if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) return false;
	return value.replace(/[^0-9]/g, "").length <= 7 && !/^\d{8}$/.test(value);
}

function factorLabel(item: EvidenceItem): string {
	const code = asText(item.metadata["code"]);
	if (code !== null && code in FACTOR_LABELS) {
		return FACTOR_LABELS[code as keyof typeof FACTOR_LABELS];
	}
	return asText(item.metadata["label"]) ?? item.label;
}

function policyRiskText(item: EvidenceItem): string {
	const code = asText(item.metadata["code"]) ?? parseScoreCode(item.ref);
	if (code !== null && code in POLICY_RISK_TEXT) return POLICY_RISK_TEXT[code];
	return POLICY_RISK_FALLBACK;
}

function parseScoreCode(ref: string): string | null {
	const parsed = parseSourceRef(ref);
	return parsed !== null && parsed.type === "score_reason" ? parsed.code : null;
}

const SOURCE_LABELS: Record<string, string> = {
	document: "document",
	context_signal: "case signal",
	external_evidence: "external report",
	policy_section: "policy section",
	score_reason: "assessment reason",
	case_fact: "case fact",
};

function unavailableCode(sourceType: string, code: string): OpenItem["code"] {
	if (code === "missing") {
		if (sourceType === "document") return "missing_document";
		if (sourceType === "context_signal" || sourceType === "external_evidence")
			return "stale_document";
		if (sourceType === "policy_section" || sourceType === "score_reason") return "failed_rule";
		return "other";
	}
	if (code === "access_denied" || code === "retention_expired") {
		if (
			sourceType === "case_fact" ||
			sourceType === "policy_section" ||
			sourceType === "score_reason"
		) {
			return "other";
		}
		return "stale_document";
	}
	return "other";
}

interface SectionClaim {
	text: string;
	citations: Array<{ ref: string; quote: string }>;
}

function section(key: MemoSection["key"], title: string, claims: SectionClaim[]): MemoSection {
	// ponytail: cap at the validator's 20-claim section bound. Aggregate the
	// overflow if evidence volume grows beyond a demo case.
	const capped = claims.slice(0, 20);
	return capped.length > 0
		? { key, title, claims: capped, notAvailable: false }
		: { key, title, claims: [], notAvailable: true };
}

function fact(
	items: Map<string, EvidenceItem>,
	applicationId: string,
	field: string,
): EvidenceItem | null {
	const item = items.get(`case_fact:${applicationId}:${field}`);
	return item !== undefined && item.sourceType === "case_fact" ? item : null;
}

function claimFor(item: EvidenceItem, text: string): SectionClaim {
	return { text, citations: [citationOf(item)] };
}

function buildRequest(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const amount = fact(items, app.id, "amountCents");
	const months = fact(items, app.id, "termMonths");
	const product = fact(items, app.id, "product");
	if (amount === null && months === null && product === null) return [];
	const fragments: string[] = [];
	const citations: Array<{ ref: string; quote: string }> = [];
	const cents = asNumber(app.amountCents);
	if (amount !== null) {
		const display = cents !== null ? formatUSD(cents) : moneyText(null, amount.content);
		fragments.push(
			display !== null ? `for ${display}` : "for the amount stated in the case record",
		);
		citations.push(citationOf(amount));
	}
	if (months !== null) {
		const raw = asNumber(app.termMonths);
		const parsed =
			raw !== null ? raw : /^\d{1,3}$/.test(months.content.trim()) ? months.content.trim() : null;
		fragments.push(
			parsed !== null ? `over ${parsed} months` : "over the duration stated in the case record",
		);
		citations.push(citationOf(months));
	}
	if (product !== null) {
		fragments.push(`under the ${productLabel(asText(app.product) ?? product.content)}`);
		citations.push(citationOf(product));
	}
	return [{ text: `The request is ${fragments.join(" ")}.`, citations: citations.slice(0, 5) }];
}

function buildBorrower(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const isSme = app.type === "sme";
	const candidates: Array<{ field: string; text: string }> = isSme
		? [
				{ field: "companyName", text: "The applicant is the company named in the case record." },
				{
					field: "industry",
					text: "The applicant operates in the sector stated in the case record.",
				},
				{
					field: "yearsTrading",
					text: "The trading history stated in the case record is noted for review.",
				},
				{ field: "city", text: "The applicant is based in the city stated in the case record." },
				{
					field: "business.ownershipStructure",
					text: "The case file records the ownership structure.",
				},
				{
					field: "business.managementSummary",
					text: "The case file records the management structure.",
				},
			]
		: [
				{
					field: "applicantName",
					text: "The application relates to an individual applicant.",
				},
				{ field: "city", text: "The applicant is based in the city stated in the case record." },
				{
					field: "financial.employmentSummary",
					text: "The case file records the employment history.",
				},
			];
	const claims: SectionClaim[] = [];
	for (const candidate of candidates) {
		const item = fact(items, app.id, candidate.field);
		if (item !== null) claims.push(claimFor(item, candidate.text));
	}
	return claims;
}

function buildFinancialAnalysis(
	app: ApplicationRow,
	items: Map<string, EvidenceItem>,
): SectionClaim[] {
	const isSme = app.type === "sme";
	const claims: SectionClaim[] = [];
	const candidates = isSme
		? [
				{
					field: "business.annualRevenueCents",
					text: (v: string) => `Annual revenue is ${v}.`,
					money: true,
				},
				{
					field: "business.monthlyFcfCents",
					text: (v: string) => `Average monthly free cash flow is ${v}.`,
					money: true,
				},
				{
					field: "business.leverageRatio",
					text: (v: string) => `Leverage is ${v}x.`,
					money: false,
				},
				{
					field: "business.currentRatio",
					text: (v: string) => `The current ratio is ${v}x.`,
					money: false,
				},
			]
		: [
				{
					field: "financial.monthlyIncomeCents",
					text: (v: string) => `Monthly income is ${v}.`,
					money: true,
				},
				{
					field: "financial.monthlyExpensesCents",
					text: (v: string) => `Monthly expenses are ${v}.`,
					money: true,
				},
				{
					field: "financial.existingDebtCents",
					text: (v: string) => `Existing debt is ${v}.`,
					money: true,
				},
			];
	for (const candidate of candidates) {
		const item = fact(items, app.id, candidate.field);
		if (item === null) continue;
		const value = candidate.money
			? moneyText(null, item.content)
			: Number.isFinite(Number(item.content))
				? Number(item.content).toFixed(2)
				: null;
		if (value !== null) claims.push(claimFor(item, candidate.text(value)));
	}
	return claims;
}

function buildDebtService(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const claims: SectionClaim[] = [];
	const debtField =
		app.type === "sme" ? "business.existingDebtServiceCents" : "financial.existingDebtCents";
	const debt = fact(items, app.id, debtField);
	if (debt !== null) {
		const value = moneyText(null, debt.content);
		if (value !== null) claims.push(claimFor(debt, `Existing monthly debt service is ${value}.`));
	}
	const dscr = fact(items, app.id, "score.dscr");
	if (dscr !== null) {
		const value = Number(dscr.content);
		if (Number.isFinite(value))
			claims.push(claimFor(dscr, `Debt-service coverage is ${value.toFixed(2)}x.`));
	}
	const dti = fact(items, app.id, "score.dti");
	if (dti !== null) {
		const value = Number(dti.content);
		if (Number.isFinite(value))
			claims.push(claimFor(dti, `Debt-to-income is ${value.toFixed(2)}%.`));
	}
	const payment = fact(items, app.id, "score.newPaymentCents");
	if (payment !== null) {
		const value = moneyText(null, payment.content);
		if (value !== null) claims.push(claimFor(payment, `The proposed monthly payment is ${value}.`));
	}
	const facilities = fact(items, app.id, "business.existingFacilitiesSummary");
	if (facilities !== null)
		claims.push(claimFor(facilities, "Existing facilities are recorded in the case file."));
	return claims;
}

function buildCreditHistory(
	applicationId: string,
	items: Map<string, EvidenceItem>,
): SectionClaim[] {
	const claims: SectionClaim[] = [];
	const candidates: Array<{ field: string; text: string }> = [
		{ field: "bureau.bureauScore", text: "A bureau indicator is recorded for the case." },
		{ field: "bureau.delinquencies", text: "Bureau delinquencies are recorded in the case file." },
		{ field: "bureau.utilizationPct", text: "Bureau utilization is recorded in the case file." },
		{
			field: "financial.creditHistorySummary",
			text: "Credit history is summarised in the case file.",
		},
	];
	for (const candidate of candidates) {
		const item = fact(items, applicationId, candidate.field);
		if (item !== null) claims.push(claimFor(item, candidate.text));
	}
	return claims;
}

function buildCollateral(applicationId: string, items: Map<string, EvidenceItem>): SectionClaim[] {
	const claims: SectionClaim[] = [];
	const status = fact(items, applicationId, "security.status");
	if (status !== null) {
		const value = status.content.trim().toLowerCase();
		claims.push(
			claimFor(
				status,
				value === "secured"
					? "Security is recorded for this facility."
					: "No collateral or guarantee is recorded for this facility; the exposure is unsecured.",
			),
		);
	}
	const value = fact(items, applicationId, "business.collateral.valueCents");
	if (value !== null) {
		const money = moneyText(null, value.content);
		if (money !== null) claims.push(claimFor(value, `The recorded collateral value is ${money}.`));
	}
	return claims;
}

function buildRisks(items: Map<string, EvidenceItem>): SectionClaim[] {
	const risks: Array<{ claim: SectionClaim; priority: number }> = [];
	for (const item of items.values()) {
		if (item.sourceType === "score_reason") {
			const kind = asText(item.metadata["kind"]);
			const impact = asText(item.metadata["impact"]);
			if (kind === "factor" && impact === "negative") {
				risks.push({
					priority: 0,
					claim: claimFor(item, `${factorLabel(item)} is noted for officer review.`),
				});
			} else if (kind === "factor") {
				continue;
			} else {
				risks.push({ priority: 0, claim: claimFor(item, policyRiskText(item)) });
			}
		} else if (item.sourceType === "document" && asText(item.metadata["status"]) === "mismatch") {
			const field = asText(item.metadata["field"]);
			risks.push({
				priority: 1,
				claim: claimFor(
					item,
					field !== null && safeToken(field)
						? `A document consistency check recorded a mismatch for ${field}.`
						: "A document consistency check recorded a mismatch for the record.",
				),
			});
		} else if (item.sourceType === "external_evidence") {
			if (asText(item.metadata["reviewStatus"]) === "rejected") continue;
			risks.push({
				priority: 2,
				claim: claimFor(item, "An external report is recorded for officer review."),
			});
		} else if (item.sourceType === "context_signal") {
			if (asText(item.metadata["reviewStatus"]) === "rejected") continue;
			risks.push({
				priority: 3,
				claim: claimFor(item, "A cash-flow signal is recorded for officer review."),
			});
		}
	}
	return risks.sort((a, b) => a.priority - b.priority).map((entry) => entry.claim);
}

function buildPolicy(applicationId: string, items: Map<string, EvidenceItem>): SectionClaim[] {
	const claims: SectionClaim[] = [];
	const outcome = fact(items, applicationId, "policy.outcome");
	if (outcome !== null) {
		const text =
			outcome.content === "auto_approve"
				? "The policy engine found the case within automatic-processing thresholds."
				: outcome.content === "refer"
					? "The policy engine routed the case to officer review."
					: "The policy engine recorded an outcome requiring officer review.";
		claims.push(claimFor(outcome, text));
	}
	const max = fact(items, applicationId, "policy.maxAmountCents");
	if (max !== null) {
		const value = moneyText(null, max.content);
		if (value !== null) claims.push(claimFor(max, `The policy maximum is ${value}.`));
	}
	const version = fact(items, applicationId, "policy.policyVersion");
	if (version !== null)
		claims.push(claimFor(version, `Policy version ${version.content} applies to this case.`));
	for (const item of items.values()) {
		if (item.sourceType !== "policy_section") continue;
		const label = item.label.trim();
		const safeLabel = label.length > 0 && !containsDecisionLanguage(label);
		const text = safeLabel
			? `${label} is cited for this case.`
			: "A policy section is cited for this case.";
		if (claims.some((claim) => claim.text === text)) continue;
		claims.push(claimFor(item, text));
	}
	return claims;
}

function numericTokens(text: string): Set<string> {
	const tokens = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
	return new Set(
		tokens
			.map((token) => Number(token.replaceAll(",", "")))
			.filter((value) => Number.isFinite(value))
			.map((value) => String(value)),
	);
}

function citationRefsOf(section: MemoSection): Set<string> {
	return new Set(
		section.claims.flatMap((claim) => claim.citations.map((citation) => citation.ref)),
	);
}

function securityMode(text: string): "secured" | "unsecured" | null {
	if (/\bunsecured\b/i.test(text)) return "unsecured";
	if (/\bsecured\b/i.test(text)) return "secured";
	return null;
}

function currencyTokens(text: string): Set<string> {
	return new Set(
		(text.match(/\b(?:USD|SGD|EUR|GBP|JPY|CNY|HKD|AUD)\b/gi) ?? []).map((v) => v.toUpperCase()),
	);
}

/** A style rewrite is accepted only when it keeps every figure, currency,
 * citation and security meaning from the deterministic base. Anything else
 * falls back to the code-built text; style must never change a fact. */
export function styleRewriteIsSafe(agent: MemoSection, base: MemoSection): boolean {
	if (agent.notAvailable !== base.notAvailable) return false;
	if (base.claims.length === 0) return agent.claims.length === 0;
	if (agent.claims.length === 0) return false;
	const baseText = base.claims.map((claim) => claim.text).join(" ");
	const agentText = agent.claims.map((claim) => claim.text).join(" ");
	const baseNumbers = numericTokens(baseText);
	const agentNumbers = numericTokens(agentText);
	if (baseNumbers.size !== agentNumbers.size) return false;
	for (const value of baseNumbers) if (!agentNumbers.has(value)) return false;
	const baseCurrencies = currencyTokens(baseText);
	const agentCurrencies = currencyTokens(agentText);
	if (baseCurrencies.size !== agentCurrencies.size) return false;
	for (const value of baseCurrencies) if (!agentCurrencies.has(value)) return false;
	const baseRefs = citationRefsOf(base);
	const agentRefs = citationRefsOf(agent);
	if (baseRefs.size !== agentRefs.size) return false;
	for (const ref of baseRefs) if (!agentRefs.has(ref)) return false;
	const baseSecurity = securityMode(baseText);
	if (baseSecurity !== null && securityMode(agentText) !== baseSecurity) return false;
	return true;
}

/** Rewrite the prose sections only when the agent preserved every fact;
 * policy compliance always stays code-built. */
export function composeCreditMemo(
	agent: CreditMemoContent,
	built: CreditMemoContent,
): CreditMemoContent {
	const rewrite = new Set<string>(STYLE_REWRITE_MEMO_SECTIONS);
	const byKey = new Map(built.sections.map((entry) => [entry.key, entry]));
	const openItems = new Map<string, OpenItem>();
	for (const item of [...agent.openItems, ...built.openItems]) {
		const key = `${item.code}:${item.sourceRef ?? item.text}`;
		if (!openItems.has(key)) openItems.set(key, item);
	}
	const questions = [...new Set([...agent.officerQuestions, ...built.officerQuestions])];
	return {
		...agent,
		sections: agent.sections.map((entry) => {
			if (entry.key === "policy_compliance") return byKey.get(entry.key) ?? entry;
			if (!rewrite.has(entry.key)) return entry;
			const base = byKey.get(entry.key);
			return base && styleRewriteIsSafe(entry, base) ? entry : (base ?? entry);
		}),
		openItems: [...openItems.values()].slice(0, 20),
		officerQuestions: questions.slice(0, 5),
	};
}

export function buildCreditMemo(input: MemoInput): CreditMemoContent {
	const { application: app, evidence } = input;
	const items = new Map<string, EvidenceItem>();
	for (const item of evidence.items) {
		if (!items.has(item.ref)) items.set(item.ref, item);
	}

	const request = buildRequest(app, items);
	const borrower = buildBorrower(app, items);
	const financials = buildFinancialAnalysis(app, items);
	const debtService = buildDebtService(app, items);
	const creditHistory = buildCreditHistory(app.id, items);
	const collateral = buildCollateral(app.id, items);
	const risks = buildRisks(items);
	const policy = buildPolicy(app.id, items);

	const openItems: OpenItem[] = [];
	for (const unavailable of evidence.unavailable) {
		const sourceType = unavailable.sourceType;
		openItems.push({
			text: `A ${SOURCE_LABELS[sourceType] ?? "case"} source is unavailable; follow-up is needed to complete the record.`,
			code: unavailableCode(sourceType, unavailable.code),
			sourceRef: unavailable.ref,
		});
	}
	if (financials.length === 0) {
		openItems.push({
			text: "Financial information is not available in the case record.",
			code: "financials_unavailable",
		});
	}
	if (debtService.length === 0) {
		openItems.push({
			text: "Debt-service information is not available in the case record.",
			code: "financials_unavailable",
		});
	}
	if (creditHistory.length === 0) {
		openItems.push({
			text: "Credit-history information is not available in the case record.",
			code: "other",
		});
	}
	if (collateral.length === 0) {
		openItems.push({
			text: "Security information is not available in the case record.",
			code: "other",
		});
	}
	if (risks.length === 0) {
		openItems.push({
			text: "No risk observations are recorded in the case evidence.",
			code: "other",
		});
	}
	if (policy.length === 0) {
		openItems.push({
			text: "Policy information is not available in the case evidence.",
			code: "other",
		});
	}

	return {
		title: `Credit memorandum draft — ${app.reference}`,
		sections: [
			section("request", "Request", request),
			section("borrower", "Borrower profile", borrower),
			section("financial_analysis", "Financial analysis", financials),
			section("debt_service", "Debt service and existing facilities", debtService),
			section("credit_history", "Credit history", creditHistory),
			section("collateral_security", "Collateral and security", collateral),
			section("risks", "Risks and mitigants", risks),
			section("policy_compliance", "Policy compliance", policy),
		],
		openItems: openItems.slice(0, 50),
		officerQuestions: [...OFFICER_QUESTIONS],
	};
}
