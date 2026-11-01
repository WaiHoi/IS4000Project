// Demo 3 — referred, researched, officer DECLINES. Envy Global Trading Pte.
// Ltd. (UEN 201941770R, a real Singapore company at the centre of the
// publicly reported S$1.46b nickel-trading fraud; the MAS said it was not
// licensed, and it is in compulsory liquidation) applies for $80,000 / 36m.
// The pipeline refers it on amount; the officer runs the live research
// agent, which surfaces validated adverse media (the brief validator only
// keeps adverse_media backed by an official source or 2+ independent
// sources), and declines on officer judgement. The applicant person and all
// financials are fictional; only the company identity is real.
// Live: needs OPENROUTER_API_KEY + TAVILY_API_KEY (see demo-flow.ts).
import { expect, test } from "@playwright/test";
import { Api, waitTerminal } from "./helpers.js";
import { applyAsProfiledSme, declineIfPending, officerDecides, runResearch } from "./demo-flow.js";

const EMAIL = "envy@example.com";
let tracked: string | null = null;

test.afterEach(async () => {
	await declineIfPending(EMAIL, tracked);
	tracked = null;
});

test("Envy Global Trading: referred → adverse media in live brief → officer declines", async ({
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
	const research = await runResearch(officer, caseId);
	const adverse = research.findings.filter((f) => f.category === "adverse_media");
	expect(
		adverse.length,
		"expected validated adverse media for Envy Global Trading",
	).toBeGreaterThan(0);

	await officerDecides(page, caseId, {
		outcome: "decline",
		notes:
			"Research brief: validated adverse media — company linked to the reported nickel-trading fraud and in liquidation. Declined on officer judgement.",
	});
	const done = await waitTerminal(officer, caseId);
	expect(done.application.status).toBe("declined");
	expect(done.decision?.outcome).toBe("declined");
	expect(done.loan).toBeNull();
	tracked = null;
});
