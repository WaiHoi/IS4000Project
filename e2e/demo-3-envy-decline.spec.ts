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
// declines on judgement. The applicant person and all
// financials are fictional; only the company identity is real.
// Live: needs OPENROUTER_API_KEY + TAVILY_API_KEY (see demo-flow.ts).
import { expect, test } from "@playwright/test";
import { Api, waitTerminal } from "./helpers.js";
import {
	applyAsProfiledSme,
	declineIfPending,
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
	const adverse = research.findings.filter((f) => f.category === "adverse_media");
	expect(
		adverse.length,
		"expected validated adverse media for Envy Global Trading",
	).toBeGreaterThan(0);

	// Internal context: the seeded transactions trip all six deterministic
	// candidate signals; the analyst must surface (and cite) several of them.
	expect(research.context.status).toBe("succeeded");
	const contextTypes = new Set(research.context.signals.map((s) => s.type));
	expect(
		contextTypes.size,
		`context signals: ${[...contextTypes].join(", ")}`,
	).toBeGreaterThanOrEqual(3);

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
