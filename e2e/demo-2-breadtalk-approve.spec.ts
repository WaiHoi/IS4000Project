// Demo 2 — referred, researched, officer APPROVES. BreadTalk Group Pte. Ltd.
// (UEN 200302045G, a real Singapore bakery group) applies for $60,000 / 36m
// through the prefilled draft flow; the amount is above the SME auto limit,
// so the pipeline refers it. The officer runs the live research agent, which
// searches public sources for the real company, reads the brief, and
// approves: an established, registry-verifiable business with no adverse
// media. Before deciding the officer also uses the policy navigator (what is
// the approval path and exception terms for this case?), the case assistant
// (strengths/weaknesses), the policy-exception drafter (explain the failed
// rules and draft an exception memo), and the credit memo writer (agent
// memo, approved). Every AI output is advisory; the officer decides.
// Live: needs OPENROUTER_API_KEY + TAVILY_API_KEY (see demo-flow.ts).
import { expect, test } from "@playwright/test";
import { Api, waitTerminal } from "./helpers.js";
import {
	applyAsProfiledSme,
	asOfficer,
	declineIfPending,
	officerAsksCaseAssistant,
	officerAsksPolicyNavigator,
	officerDecides,
	officerDraftsCreditMemo,
	officerDraftsPolicyException,
	runResearch,
} from "./demo-flow.js";

const EMAIL = "breadtalk@example.com";
let tracked: string | null = null;

test.afterEach(async () => {
	await declineIfPending(EMAIL, tracked);
	tracked = null;
});

test("BreadTalk: referred → live research brief → officer approves", async ({ page }) => {
	test.setTimeout(15 * 60_000);
	const { caseId } = await applyAsProfiledSme(page, EMAIL, {
		amountUsd: 60_000,
		termMonths: 36,
		purpose: "Working capital for new outlet",
		companyName: "BreadTalk Group Pte. Ltd.",
	});
	tracked = caseId;

	const officer = new Api();
	await officer.login("officer@example.com");
	const research = await runResearch(officer, caseId);
	// The brief found the real company in public sources, and nothing in it
	// is validated adverse media.
	// A clean company can legitimately yield zero validated findings; what
	// must hold is that nothing adverse survived the validator.
	expect(research.findings.filter((f) => f.category === "adverse_media")).toEqual([]);

	await asOfficer(page);
	// Policy navigator, multi-hop: approval authority (9.3) + exception
	// eligibility (5.1) + mitigants (5.3) for this exact case shape.
	const policy = await officerAsksPolicyNavigator(
		page,
		officer,
		"For an SME term loan of S$60,000, which approval authority applies, how many policy rules may an exception breach before it must go to credit committee, and what pricing and limit mitigants must an approved exception carry?",
		"sme_term_loan",
	);
	expect(policy.status).toBe("succeeded");
	expect(policy.citations.length).toBeGreaterThanOrEqual(2);

	// Policy-exception drafter: explain the failed rules and draft the memo.
	const exception = await officerDraftsPolicyException(page, officer, caseId);
	expect(exception.failedRuleIds).toContain("SME-AMOUNT-AUTO");
	expect(exception.explainedRules).toBeGreaterThan(0);
	expect(exception.memoStatus).toBe("draft");

	// Case assistant: strengths and weaknesses from the case file.
	const assistant = await officerAsksCaseAssistant(
		page,
		officer,
		caseId,
		"Summarise this application's strengths and weaknesses using the case evidence. Describe facts only and do not quote registration, account, or ID numbers.",
	);
	expect(assistant.answer.length).toBeGreaterThan(0);
	expect(assistant.toolCalls).toBeGreaterThan(0);

	// Credit memo writer: the agent drafts a cited memo; the officer approves it.
	const memo = await officerDraftsCreditMemo(page, officer, caseId);
	expect(memo.writer).toBe("agent");
	expect(memo.citations).toBeGreaterThan(0);

	await officerDecides(page, caseId, {
		outcome: "approve",
		note: "Research brief: established, registered company with no adverse media. Approved as requested.",
	});
	const done = await waitTerminal(officer, caseId);
	expect(done.application.status).toBe("booked");
	expect(done.decision?.outcome).toBe("approved");
	expect(done.loan?.principalCents).toBe(6_000_000);
	tracked = null;
});
