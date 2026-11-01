// Shared steps for the SME demo flows (demo-2 BreadTalk, demo-3 Envy):
// a profiled applicant applies through the prefilled draft flow, the case
// is referred to an officer, the officer runs the live research agent, and
// then decides. The decision is always the officer's: the brief is
// advisory evidence only (AGENTS.md trust boundary).
//
// Live research needs OPENROUTER_API_KEY + TAVILY_API_KEY (pnpm start turns
// the research flags on when both are in .env). Without them the research
// reads return 404 RESEARCH_DISABLED and the spec skips with that reason.
import { expect, test, type Page } from "@playwright/test";
import {
	Api,
	ApiError,
	type CaseDetail,
	getCase,
	gotoHydrated,
	poll,
	uiLogin,
	uiLogout,
	waitStatus,
} from "./helpers.js";

export interface ResearchFinding {
	id: string;
	claim: string;
	category: "adverse_media" | "reputation" | "registry" | "market" | "other";
	allegationStatus: string | null;
	evidence: Array<{ url: string; sourceTier: string }>;
}

export interface ResearchAggregate {
	run: { id: string; status: string; errorCode?: string | null };
	findings: ResearchFinding[];
	context: { status: string; signals: Array<{ type: string }> };
}

const REUSE_KINDS = ["id", "business_registration", "bank_statement", "financial_statements"];

/** Applicant: prefilled /apply → draft → reuse evidence → submit → pending_review. */
export async function applyAsProfiledSme(
	page: Page,
	email: string,
	loan: { amountUsd: number; termMonths: number; purpose: string; companyName: string },
): Promise<{ applicant: Api; caseId: string; reference: string }> {
	const applicant = new Api();
	try {
		await applicant.login(email);
	} catch (err) {
		if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
			test.skip(true, `${email} not seeded — run \`pnpm start\` (it seeds the demo personas)`);
		}
		throw err;
	}

	await uiLogin(page, email);
	await gotoHydrated(page, "/apply");
	await expect(page.getByText("Prefilled from your customer profile")).toBeVisible();
	await page.locator("#field-amount-usd").fill(String(loan.amountUsd));
	await page.locator("#field-term-months").fill(String(loan.termMonths));
	await page.locator("#field-purpose").fill(loan.purpose);
	await page.getByRole("button", { name: "Continue" }).click();
	// The real registered company the research agent will look up.
	await expect(page.locator("#field-company-name")).toHaveValue(loan.companyName);
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByLabel("Credit check consent").check();
	await page.getByLabel("Data processing consent").check();
	await page.getByLabel("Terms consent").check();
	await page.getByLabel("Document processing consent", { exact: false }).check();
	await page.getByLabel("Context analysis consent", { exact: false }).check();
	await page.getByLabel("AI research consent", { exact: false }).check();
	await page.getByRole("button", { name: "Create draft" }).click();
	await page.waitForURL(/\/applications\/.+/);
	const caseId = page.url().split("/").pop() ?? "";
	expect(caseId).toMatch(/^[0-9a-f-]{36}$/);

	// Attach the applicant's on-file evidence explicitly, then submit.
	await expect(page.getByText("Not ready to submit.")).toBeVisible({ timeout: 30_000 });
	for (const kind of REUSE_KINDS) {
		await page.getByRole("button", { name: `Reuse ${kind} evidence` }).click();
	}
	await poll(
		"checklist ready after reuse",
		async () => {
			const req = await applicant.get<{ readyToSubmit: boolean }>(
				`/api/applications/${caseId}/requirements`,
			);
			return req.readyToSubmit ? true : null;
		},
		60_000,
		2000,
	);
	const submit = page.getByRole("button", { name: "Submit draft application" });
	await expect(submit).toBeEnabled({ timeout: 30_000 });
	await submit.click();

	// Above the $25,000 SME auto limit, so the pipeline refers it.
	const pending = await waitStatus(applicant, caseId, "pending_review");
	expect(pending.application.status).toBe("pending_review");
	return { applicant, caseId, reference: pending.application.reference };
}

/** Officer: start the live research run and wait for it to finish. */
export async function runResearch(officer: Api, caseId: string): Promise<ResearchAggregate> {
	try {
		await officer.post(`/api/review/${caseId}/research`);
	} catch (err) {
		if (err instanceof ApiError && err.status === 404 && err.code === "RESEARCH_DISABLED") {
			test.skip(
				true,
				"research disabled: put OPENROUTER_API_KEY and TAVILY_API_KEY in .env and restart `pnpm start`",
			);
		}
		throw err;
	}
	const done = await poll(
		"research run to finish",
		async () => {
			try {
				const cur = await officer.get<ResearchAggregate>(`/api/review/${caseId}/research`);
				return cur.run.status === "succeeded" || cur.run.status === "failed" ? cur : null;
			} catch (err) {
				if (err instanceof ApiError && err.status === 404) return null;
				throw err;
			}
		},
		10 * 60_000,
		5000,
	);
	expect(
		done.run.status,
		`research run failed (${done.run.errorCode ?? "unknown"}) — check OpenRouter/Tavily keys and network`,
	).toBe("succeeded");
	return done;
}

/** Officer UI: open the case, see the research brief, then decide. */
export async function officerDecides(
	page: Page,
	caseId: string,
	decision: { outcome: "approve"; note: string } | { outcome: "decline"; notes: string },
): Promise<void> {
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${caseId}`);
	await expect(page.locator('section[aria-label="Agent research"]')).toBeVisible({
		timeout: 60_000,
	});
	if (process.env.DEMO_HOLD === "1") {
		// Presenter mode: pause on the brief before deciding.
		await page.locator('section[aria-label="Agent research"]').scrollIntoViewIfNeeded();
		await page.waitForTimeout(10_000);
	}
	const panel = page.locator('section[aria-label="Officer decision"]');
	if (decision.outcome === "approve") {
		await panel.locator("#field-note-optional").fill(decision.note);
		await panel.getByRole("button", { name: "Approve" }).click();
	} else {
		await panel.getByRole("radio", { name: "Decline" }).check();
		await panel.locator("#field-reason-code").selectOption("OFFICER_JUDGEMENT");
		await panel.locator("#field-notes-required").fill(decision.notes);
		await panel.getByRole("button", { name: "Decline" }).click();
	}
	await page.waitForURL(/\/officer\/review\/?$/);
}

/** Best-effort: decline a case a failed run left in the officer queue. */
export async function declineIfPending(email: string, caseId: string | null): Promise<void> {
	if (!caseId) return;
	try {
		const applicant = new Api();
		await applicant.login(email);
		const detail: CaseDetail = await getCase(applicant, caseId);
		if (detail.application.status !== "pending_review") return;
		const officer = new Api();
		await officer.login("officer@example.com");
		await officer.post(`/api/review/${caseId}/decision`, {
			requestId: crypto.randomUUID(),
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "e2e cleanup: decline leftover demo case",
		});
	} catch {
		// Must never fail the spec.
	}
}

export interface FraudQueueItem {
	id: string;
	applicationId: string;
	status: string;
	severity: string;
	briefState: "ready" | "stale" | "pending" | "failed" | "missing";
}

/**
 * Officer: claim the case and run the deterministic document cross-check.
 * A high-confidence mismatch opens a fraud-review item, which queues the
 * document-integrity agent (analysis + triage brief) on Temporal. Returns
 * the item once that brief has settled.
 */
export async function officerRunsCrosscheck(
	page: Page,
	officer: Api,
	caseId: string,
): Promise<{ item: FraudQueueItem; signalCodes: string[] }> {
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${caseId}`);
	await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible({
		timeout: 60_000,
	});
	const assign = page.getByRole("button", { name: "Assign to me" });
	const runCrosscheck = page.getByRole("button", { name: "Run cross-check" });
	await expect(assign.or(runCrosscheck)).toBeVisible({ timeout: 60_000 });
	if (await assign.isVisible()) {
		await assign.click();
		await expect(runCrosscheck).toBeVisible({ timeout: 60_000 });
	}
	await runCrosscheck.click();
	await expect(page.getByText("account_holder_name").first()).toBeVisible({ timeout: 120_000 });
	await expect(page.getByText("mismatch").first()).toBeVisible();

	const opened = await poll(
		`fraud-review item for case ${caseId}`,
		async () => {
			const queue = await officer.get<{ items: FraudQueueItem[] }>("/api/fraud-review/queue");
			return queue.items.find((i) => i.applicationId === caseId) ?? null;
		},
		60_000,
		2000,
	);
	const detail = await officer.get<{ review: { signalCodes?: string[] } }>(
		`/api/fraud-review/${opened.id}`,
	);
	const settled = await poll(
		"document-integrity triage brief to settle",
		async () => {
			const queue = await officer.get<{ items: FraudQueueItem[] }>("/api/fraud-review/queue");
			const cur = queue.items.find((i) => i.id === opened.id);
			return cur && cur.briefState !== "pending" && cur.briefState !== "missing" ? cur : null;
		},
		5 * 60_000,
		5000,
	);
	return { item: settled, signalCodes: detail.review.signalCodes ?? [] };
}

/** Re-throw a 404 from a flag-gated AI route with the fix spelled out. */
async function aiCall<T>(feature: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			throw new Error(
				`${feature} is off (404 ${err.code}) — put OPENROUTER_API_KEY in .env and restart \`pnpm start\``,
				{ cause: err },
			);
		}
		throw err;
	}
}

async function openCaseTab(
	page: Page,
	caseId: string,
	tab: "Memo" | "Policy" | "Ask",
): Promise<void> {
	await gotoHydrated(page, `/officer/review/${caseId}`);
	await page.getByRole("button", { name: tab }).click();
}

/** AI: policy navigator — a cited answer from the bank's credit policy corpus. */
export async function officerAsksPolicyNavigator(
	page: Page,
	officer: Api,
	question: string,
	product: "personal_loan" | "sme_term_loan",
): Promise<{ status: string; citations: unknown[] }> {
	const answer = await aiCall("policy navigator", () =>
		officer.post<{ status: string; citations: unknown[] }>("/api/policy/ask", {
			question,
			product,
		}),
	);
	await gotoHydrated(page, "/officer/policies");
	await expect(page.getByText("Ask a policy question")).toBeVisible({ timeout: 60_000 });
	await page.locator("#policy-question").fill(question);
	return answer;
}

/**
 * AI: policy-exception drafter — explains which policy rules the case fails
 * (with citations) and drafts an exception memo for an approver. Advisory:
 * approvers come from the policy registry, never from the model.
 */
export async function officerDraftsPolicyException(
	page: Page,
	officer: Api,
	caseId: string,
): Promise<{ failedRuleIds: string[]; explainedRules: number; memoStatus: string }> {
	const view = await aiCall("policy-exception navigator", () =>
		officer.get<{ context: { failedRules: Array<{ ruleId: string }> } }>(
			`/api/assist/cases/${caseId}/policy-exception`,
		),
	);
	const explained = await aiCall("policy-exception explain", () =>
		officer.post<{ rules: unknown[] }>(`/api/assist/cases/${caseId}/policy-exception/explain`, {}),
	);
	const memo = await aiCall("policy-exception memo", () =>
		officer.post<{ artifact: { status: string } }>(
			`/api/assist/cases/${caseId}/policy-exception/memo`,
			{},
		),
	);
	await openCaseTab(page, caseId, "Policy");
	await expect(page.getByText("Policy & exception navigator")).toBeVisible({ timeout: 60_000 });
	return {
		failedRuleIds: view.context.failedRules.map((r) => r.ruleId),
		explainedRules: explained.rules.length,
		memoStatus: memo.artifact.status,
	};
}

/** AI: credit memo writer — the agent drafts a cited memo; the officer approves it. */
export async function officerDraftsCreditMemo(
	page: Page,
	officer: Api,
	caseId: string,
): Promise<{ writer: string | undefined; citations: number }> {
	const drafted = await aiCall("credit memo", () =>
		officer.post<{
			artifact: {
				id: string;
				revision: number;
				citations: unknown[];
				agentTrace: { writer: string } | null;
			};
		}>(`/api/assist/cases/${caseId}/memos`),
	);
	await officer.post(`/api/assist/artifacts/${drafted.artifact.id}/approve`, {
		expectedRevision: drafted.artifact.revision,
		confirm: true,
	});
	await openCaseTab(page, caseId, "Memo");
	await expect(page.getByRole("heading", { name: "Credit memo" })).toBeVisible({ timeout: 60_000 });
	return {
		writer: drafted.artifact.agentTrace?.writer,
		citations: drafted.artifact.citations.length,
	};
}

/** AI: case assistant — officer Q&A over the case file (read-only tools). */
export async function officerAsksCaseAssistant(
	page: Page,
	officer: Api,
	caseId: string,
	question: string,
): Promise<{ answer: string; toolCalls: number }> {
	const out = await aiCall("case assistant", () =>
		officer.post<{ answer: string; toolCalls: unknown[] }>(`/api/review/${caseId}/assistant`, {
			question,
		}),
	);
	await openCaseTab(page, caseId, "Ask");
	await expect(page.locator('section[aria-label="Case assistant"]')).toBeVisible({
		timeout: 60_000,
	});
	await page.getByPlaceholder("Ask about this case…").fill(question);
	return { answer: out.answer, toolCalls: out.toolCalls.length };
}

/** Switch the browser session to the officer. */
export async function asOfficer(page: Page): Promise<void> {
	await uiLogout(page);
	await uiLogin(page, "officer@example.com");
}
