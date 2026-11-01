// Demo 3 — referred, flagged, researched, officer DECLINES. Envy Global Trading Pte.
// Ltd. (UEN 201941770R, a real Singapore company at the centre of the
// publicly reported S$1.46b nickel-trading fraud; the MAS said it was not
// licensed, and it is in compulsory liquidation) applies for $80,000 / 36m.
// The pipeline refers it on amount and score band. The officer first runs
// the document cross-check: the bank statement is held by a sister entity
// (Envy Asset Management), a high-confidence account-holder mismatch that
// opens a fraud review and runs the document-integrity agent's triage brief.
// The officer then runs the live research agent: the external brief should
// surface validated adverse media (official source or 2+ independent
// sources), and the internal-context stage sees the seeded related-party
// round trips, overdrafts, cash deposits and returned payments. The officer
// checks policy (can this ever be an exception?), asks the case assistant
// to summarise the red flags, then declines on
// judgement. The applicant person and all
// financials are fictional; only the company identity is real.
// Live: needs OPENROUTER_API_KEY + TAVILY_API_KEY (see demo-flow.ts).
import { expect, test } from "@playwright/test";
import { Api, waitTerminal } from "./helpers.js";
import {
	applyAsProfiledSme,
	declineIfPending,
	officerAsksCaseAssistant,
	officerAsksPolicyNavigator,
	officerDecides,
	officerRunsCrosscheck,
	runResearch,
} from "./demo-flow.js";

const EMAIL = "envy@example.com";
let tracked: string | null = null;

test.afterEach(async () => {
	await declineIfPending(EMAIL, tracked);
	tracked = null;
});

test("Envy Global Trading: referred → fraud flag + adverse media → officer declines", async ({
	page,
}) => {
	test.setTimeout(15 * 60_000);
	const { caseId } = await applyAsProfiledSme(page, EMAIL, {
		amountUsd: 80_000,
		termMonths: 36,
		purpose: "Trade finance for commodity inventory",
		companyName: "Envy Global Trading Pte. Ltd.",
	});
	tracked = caseId;

	const officer = new Api();
	await officer.login("officer@example.com");

	// Documents: deterministic mismatch → fraud review → integrity agent brief.
	const fraud = await officerRunsCrosscheck(page, officer, caseId);
	expect(fraud.signalCodes).toContain("crosscheck_mismatch");
	expect(fraud.item.severity).toBe("high");
	expect(
		fraud.item.briefState,
		"integrity triage brief did not complete — check OpenRouter key and network",
	).toBe("ready");

	const research = await runResearch(officer, caseId);
	// At least one validated negative finding. Live runs vary in what the
	// search surfaces: adverse media (the director's 2021 fraud charges)
	// shows up in some runs; the registry finding (compulsory liquidation)
	// in every run so far. Both survive the same validator.
	const negative = research.findings.filter(
		(f) =>
			f.category === "adverse_media" ||
			(f.category === "registry" && /liquidation|winding up|insolven/i.test(f.claim)),
	);
	expect(
		negative.length,
		`expected adverse media or an insolvency registry finding; got ${research.findings
			.map((f) => f.category)
			.join(", ")}`,
	).toBeGreaterThan(0);

	// Internal context: the seeded transactions trip all six deterministic
	// candidate signals; the analyst must surface (and cite) several of them.
	expect(research.context.status).toBe("succeeded");
	const contextTypes = new Set(research.context.signals.map((s) => s.type));
	expect(
		contextTypes.size,
		`context signals: ${[...contextTypes].join(", ")}`,
	).toBeGreaterThanOrEqual(3);

	// Policy navigator, multi-hop: prohibited exceptions (5.2: falsified
	// documents, misrepresentation) + SME statement evidence (4.2).
	const policy = await officerAsksPolicyNavigator(
		page,
		officer,
		"Which exceptions are prohibited outright, and what bank statement and financial evidence must an SME borrower below S$1,000,000 exposure provide?",
		"sme_term_loan",
	);
	expect(policy.status).toBe("succeeded");
	expect(policy.citations.length).toBeGreaterThanOrEqual(2);

	// Case assistant: the officer asks for the red flags in one place.
	const assistant = await officerAsksCaseAssistant(
		page,
		officer,
		caseId,
		"Summarise the red flags on this case from the case evidence. Describe facts only and do not quote registration, account, or ID numbers.",
	);
	expect(assistant.answer.length).toBeGreaterThan(0);
	expect(assistant.toolCalls).toBeGreaterThan(0);

	await officerDecides(page, caseId, {
		outcome: "decline",
		notes:
			"Fraud review: bank statement held by a sister entity. Research brief: validated adverse media (reported nickel-trading fraud, liquidation). Internal context: related-party round trips and overdrafts. Declined on officer judgement.",
	});
	const done = await waitTerminal(officer, caseId);
	expect(done.application.status).toBe("declined");
	expect(done.decision?.outcome).toBe("declined");
	expect(done.loan).toBeNull();
	tracked = null;
});
