// Research-service integration: real credit_research Postgres, fake
// agent/judge (no model, Tavily, or Grafana network).
import { randomUUID } from "node:crypto";
import { agentEvidence, agentFindingReviews, agentFindings, agentRuns } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { stubAgentRunner, ModelUnavailableError, type AgentResult } from "../../src/agent.js";
import { loadEnv } from "../../src/env.js";
import {
	claimRun,
	ensureRun,
	finalizeFailure,
	getRun,
	reapStaleRuns,
	type CaseFactsPayload,
} from "../../src/lifecycle.js";
import { executeRun } from "../../src/run.js";
import { stubLanguageRepair, type LanguageRepair } from "../../src/repair.js";
import { stubSupportJudge, type SupportJudge } from "../../src/support.js";
import { TavilyError } from "../../src/tavily.js";
import { sha256Hex } from "../../src/validator.js";
import {
	APPLICANT,
	caseFacts,
	setupApp,
	signed,
	successFixture,
	teardown,
	user,
	type TestContext,
} from "../helper.js";

async function post(
	ctx: TestContext,
	path: string,
	who: { id: string; email: string; role: "applicant" | "officer" },
	payload: unknown,
): Promise<Response> {
	const body = JSON.stringify(payload);
	return ctx.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...signed(ctx, who, "POST", path, {}, body) },
		body,
	});
}

async function get(
	ctx: TestContext,
	path: string,
	who: { id: string; email: string; role: "applicant" | "officer" },
): Promise<Response> {
	return ctx.app.request(path, { headers: signed(ctx, who, "GET", path) });
}

function ensurePayload(facts: CaseFactsPayload): Record<string, unknown> {
	return {
		applicationId: facts.applicationId,
		caseFacts: { ...facts },
		aiResearchConsent: facts.aiResearchConsent,
	};
}

/** Silent service logger for direct executeRun calls (routes wire the real one). */
const testLogger = createLogger("research-test");

interface LatestResponse {
	run: {
		id: string;
		status: string;
		applicationId: string;
		grafanaConversationId: string;
		observability: string;
		errorCode: string | null;
	};
	brief: { summary: string; unknowns: string[] } | null;
	validation: {
		scores: Record<string, number>;
		unsupportedClaims: number;
		discarded: Array<{ findingIndex: number; reason: string; claimHash: string }>;
	} | null;
	usage: { judgeCalls: number; repairCalls: number; costUsd: number } | null;
	evidence: Array<{
		id: string;
		url: string;
		quote: string;
		snapshotHash: string;
		snapshotText: string;
		quoteStart: number;
		quoteEnd: number;
		publishedAt: string | null;
		dateBasis: string;
	}>;
	findings: Array<{
		id: string;
		claim: string;
		evidenceIds: string[];
		evidence: Array<{ url: string; quote: string; snapshotHash: string }>;
		reviewStatus: string;
	}>;
	viewedAt: string | null;
}

/** Poll latest until the background execution settles. Pass the viewing
 * officer when asserting `viewedAt` — views are per officer. */
async function waitLatest(
	ctx: TestContext,
	applicationId: string,
	who: { id: string; email: string; role: "applicant" | "officer" } | null = null,
): Promise<LatestResponse> {
	const officer = who ?? user("officer");
	const deadline = Date.now() + 10_000;
	for (;;) {
		const res = await get(ctx, `/internal/research/applications/${applicationId}/latest`, officer);
		expect(res.status).toBe(200);
		const body = (await res.json()) as LatestResponse;
		if (body.run.status === "succeeded" || body.run.status === "failed") return body;
		if (Date.now() > deadline) throw new Error(`run did not settle (status=${body.run.status})`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function settledRun(
	ctx: TestContext,
	facts: CaseFactsPayload,
): Promise<{ runId: string; findings: LatestResponse["findings"] }> {
	const officer = user("officer");
	await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
	const latest = await waitLatest(ctx, facts.applicationId);
	return { runId: latest.run.id, findings: latest.findings };
}

describe("POST /internal/research/runs/ensure", () => {
	it("inserts a queued run and settles to a validated succeeded aggregate", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			expect(res.status).toBe(202);
			const created = (await res.json()) as {
				run: { id: string; status: string };
				inserted: boolean;
			};
			expect(created.inserted).toBe(true);
			expect(created.run.status).toBe("queued");

			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.id).toBe(created.run.id);
			// The run id doubles as the Grafana conversation id (not PII).
			expect(latest.run.grafanaConversationId).toBe(created.run.id);
			expect(latest.run.observability).toBe("degraded");
			expect(latest.run.errorCode).toBe(null);
			expect(latest.usage?.repairCalls).toBe(0);
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.evidence).toHaveLength(2);
			expect(latest.findings).toHaveLength(2);
			for (const f of latest.findings) {
				expect(f.reviewStatus).toBe("pending");
				expect(f.evidenceIds.length).toBeGreaterThan(0);
			}
			// Quotes are substrings of the stored snapshot window.
			for (const e of latest.evidence) {
				expect(e.snapshotText.slice(e.quoteStart, e.quoteEnd)).toBe(e.quote);
				expect(e.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
			}
			expect(latest.validation?.scores.unsupported_claims).toBe(0);
			expect(latest.viewedAt).toBe(null);
			// Judge work is tracked: 2 linked pairs, first-call supported.
			expect(latest.usage?.judgeCalls).toBe(2);
			// Model dates verified in the page text stay publisher_metadata.
			for (const e of latest.evidence) {
				expect(e.publishedAt).not.toBe(null);
				expect(e.dateBasis).toBe("publisher_metadata");
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("is idempotent: concurrent clicks share one active run", async () => {
		// Gated runner holds the first run active while all clicks land, so
		// the test proves sharing rather than racing the background fake.
		const use = successFixture();
		let release!: (v: AgentResult) => void;
		const gate = new Promise<AgentResult>((r) => {
			release = r;
		});
		const ctx = setupApp(use, { runner: { runBrief: () => gate } });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const results = await Promise.all(
				Array.from({ length: 10 }, () =>
					post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts)),
				),
			);
			const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
				run: { id: string };
				inserted: boolean;
			}>;
			expect(results.every((r) => r.status === 202)).toBe(true);
			const ids = new Set(bodies.map((b) => b.run.id));
			expect(ids.size).toBe(1);
			expect(bodies.filter((b) => b.inserted)).toHaveLength(1);
			release({
				brief: use.brief,
				fetched: use.fetched,
				usage: { inputTokens: 100, outputTokens: 100, toolCalls: 2, searches: 1, extracts: 1 },
				model: "deepseek/deepseek-v4.1-flash-1017",
			});
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects without consent, wrong status, incomplete facts, and bad asOf", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");

			const noConsent = caseFacts({ aiResearchConsent: false });
			const r1 = await post(ctx, "/internal/research/runs/ensure", officer, {
				...ensurePayload(noConsent),
				aiResearchConsent: false,
			});
			expect(r1.status).toBe(403);

			const decided = caseFacts({ status: "approved" });
			const r2 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(decided));
			expect(r2.status).toBe(409);

			const legacy = caseFacts({ city: null, registrationNumber: null });
			const r3 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(legacy));
			expect(r3.status).toBe(202);
			const failed = (await r3.json()) as { run: { status: string }; inserted: boolean };
			expect(failed.run.status).toBe("failed");
			expect(failed.inserted).toBe(false);

			const drifted = caseFacts({ asOf: "2026-02-01T10:00:00.000Z" });
			const r4 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(drifted));
			expect(r4.status).toBe(422);
		} finally {
			await teardown(ctx);
		}
	});

	it("enforces HMAC: unsigned 401, applicant 403, body-swap 401", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const path = "/internal/research/runs/ensure";
			const payload = ensurePayload(caseFacts());

			const unsigned = await ctx.app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(unsigned.status).toBe(401);

			const applicant = await post(ctx, path, APPLICANT, payload);
			expect(applicant.status).toBe(403);

			const body = JSON.stringify(payload);
			const swappedBody = JSON.stringify(ensurePayload(caseFacts()));
			const swapped = await ctx.app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, officer, "POST", path, {}, body),
				},
				body: swappedBody,
			});
			expect(swapped.status).toBe(401);
		} finally {
			await teardown(ctx);
		}
	});

	it("persists no partial rows when the agent fails", async () => {
		const use = successFixture();
		const ctx = setupApp(use, {
			runner: stubAgentRunner({ brief: null, fetched: [], throw: new TavilyError("boom") }),
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			expect(res.status).toBe(202);
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("failed");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			// No partial rows for this run (scoped by run id, not by the
			// empty aggregate above).
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, latest.run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, latest.run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("discards unsupported findings and succeeds with an empty brief", async () => {
		const ctx = setupApp(undefined, { judge: stubSupportJudge({ unsupportedIf: /./ }) });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.unsupportedClaims).toBe(2);
			expect(latest.brief?.unknowns.join(" ")).toContain("no supported findings");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("run token + reaper (lifecycle)", () => {
	it("claim/finalize are conditional on the token", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const facts = caseFacts();
			const { run, inserted } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			expect(inserted).toBe(true);
			const token = run.runToken as string;

			expect(await claimRun(ctx.db, run.id, "wrong-token")).toBe(false);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await claimRun(ctx.db, run.id, token)).toBe(false); // already running
			expect(await finalizeFailure(ctx.db, run.id, "wrong-token", "timeout", "x")).toBe(false);
			expect(await finalizeFailure(ctx.db, run.id, token, "timeout", "timed out")).toBe(true);
			const rows = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.runToken).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("completes a queued insert started outside the route (crash-after-insert)", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: {
						status: "degraded",
						hooksFor: () => ({ detach: () => {} }),
						trackModelCall: (_opts, fn) => fn(),
						trackToolExecution: (_opts, fn) => fn(),
					},
				},
				run.id,
				run.runToken as string,
			);
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("reaps stale queued/running runs and leaves live runs alone", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const mk = (f: CaseFactsPayload) =>
				ensureRun(ctx.db, env, {
					applicationId: f.applicationId,
					requestedBy: randomUUID(),
					caseFacts: f,
					aiResearchConsent: true,
				});
			const staleQueued = (await mk(caseFacts())).run;
			const staleRunning = (await mk(caseFacts())).run;
			const live = (await mk(caseFacts())).run;
			expect(await claimRun(ctx.db, live.id, live.runToken as string)).toBe(true);
			expect(await claimRun(ctx.db, staleRunning.id, staleRunning.runToken as string)).toBe(true);
			// Backdate: queued past its timeout, running silent 90s+, live fresh.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET timeout_at = now() - INTERVAL '61 seconds' WHERE id = ${staleQueued.id}`,
			);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${staleRunning.id}`,
			);
			const reaped = await reapStaleRuns(ctx.db);
			// Containment, not exact equality: rows accumulate in the shared
			// dev DB across runs (repo convention), including other stale rows.
			expect(reaped).toContain(staleQueued.id);
			expect(reaped).toContain(staleRunning.id);
			expect(reaped).not.toContain(live.id);
			const rows = await ctx.db.select().from(agentRuns);
			const byId = new Map(rows.map((r) => [r.id, r]));
			for (const id of [staleQueued.id, staleRunning.id]) {
				expect(byId.get(id)?.status).toBe("failed");
				expect(byId.get(id)?.errorCode).toBe("timeout");
				expect(byId.get(id)?.runToken).toBe(null);
			}
			expect(byId.get(live.id)?.status).toBe("running");
			expect(await reapStaleRuns(ctx.db)).toEqual([]);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("app-scoped views, reviews, and bundle", () => {
	it("latest 404s when no run exists; view dedupes within the minute", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const missing = await get(
				ctx,
				`/internal/research/applications/${randomUUID()}/latest`,
				officer,
			);
			expect(missing.status).toBe(404);

			const facts = caseFacts();
			const { runId } = await settledRun(ctx, facts);
			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			const v1 = await post(ctx, viewPath, officer, {});
			expect(v1.status).toBe(200);
			expect(((await v1.json()) as { deduped: boolean }).deduped).toBe(false);
			const v2 = await post(ctx, viewPath, officer, {});
			expect(((await v2.json()) as { deduped: boolean }).deduped).toBe(true);
			// Views are per officer: poll latest as the viewing officer.
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.viewedAt).not.toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("reviews are append-only; the bundle carries accepted findings only", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const { runId, findings } = await settledRun(ctx, facts);
			expect(findings).toHaveLength(2);
			const reviewPath = (id: string) =>
				`/internal/research/applications/${facts.applicationId}/findings/${id}/review`;
			const a1 = await post(ctx, reviewPath(findings[0].id), officer, { action: "accepted" });
			expect(a1.status).toBe(201);
			const r2 = await post(ctx, reviewPath(findings[1].id), officer, { action: "rejected" });
			expect(r2.status).toBe(201);

			const bundlePath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/bundle`;
			const bundleRes = await get(ctx, bundlePath, officer);
			expect(bundleRes.status).toBe(200);
			const bundle = (await bundleRes.json()) as {
				bundle: {
					agentRunId: string;
					applicationId: string;
					briefHash: string;
					viewedAt: string | null;
					acceptedFindings: Array<{
						findingId: string;
						claim: string;
						category: string;
						entityMatch: unknown;
						evidence: Array<{ url: string; quote: string; snapshotHash: string }>;
					}>;
				};
			};
			expect(bundle.bundle.agentRunId).toBe(runId);
			expect(bundle.bundle.applicationId).toBe(facts.applicationId);
			expect(bundle.bundle.briefHash).toMatch(/^[0-9a-f]{64}$/);
			// The kept finding carries its exact claim and evidence quotes,
			// hashed against the frozen brief.
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(bundle.bundle.briefHash).toBe(sha256Hex(JSON.stringify(latest.brief)));
			expect(bundle.bundle.acceptedFindings).toHaveLength(1);
			const [kept] = bundle.bundle.acceptedFindings;
			expect(kept.findingId).toBe(findings[0].id);
			expect(kept.claim).toBe(findings[0].claim);
			expect(kept.evidence.map((e) => e.quote)).toEqual(findings[0].evidence.map((e) => e.quote));
			expect(latest.findings.find((f) => f.id === findings[0].id)?.reviewStatus).toBe("accepted");
			expect(latest.findings.find((f) => f.id === findings[1].id)?.reviewStatus).toBe("rejected");

			// Append-only: rejecting the kept finding adds a row (latest
			// wins) and removes it from the frozen bundle.
			const a2 = await post(ctx, reviewPath(findings[0].id), officer, {
				action: "rejected",
				note: "second look",
			});
			expect(a2.status).toBe(201);
			const reviews = await ctx.db
				.select({ id: agentFindingReviews.id })
				.from(agentFindingReviews)
				.where(eq(agentFindingReviews.findingId, findings[0].id));
			expect(reviews).toHaveLength(2);
			const bundleRes2 = await get(ctx, bundlePath, officer);
			// Nothing stays accepted: explicit stale, not an empty bundle.
			expect(bundleRes2.status).toBe(409);
			const stale2 = (await bundleRes2.json()) as { error: { code: string } };
			expect(stale2.error.code).toBe("RESEARCH_SELECTION_STALE");
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle 404s cross-application; findings/views reject mismatches", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const factsA = caseFacts();
			const factsB = caseFacts();
			const { runId, findings } = await settledRun(ctx, factsA);
			await settledRun(ctx, factsB);

			const crossBundle = await get(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/runs/${runId}/bundle`,
				officer,
			);
			expect(crossBundle.status).toBe(404);

			const crossView = await post(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/runs/${runId}/view`,
				officer,
				{},
			);
			expect(crossView.status).toBe(404);

			const crossReview = await post(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/findings/${findings[0].id}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(crossReview.status).toBe(404);

			const missingFinding = await post(
				ctx,
				`/internal/research/applications/${factsA.applicationId}/findings/${randomUUID()}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(missingFinding.status).toBe(404);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects reviews while the run has not succeeded", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const env = loadEnv();
			const facts = caseFacts();
			// Direct insert: no background execution, run stays queued.
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const [finding] = await ctx.db
				.insert(agentFindings)
				.values({
					runId: run.id,
					claim: "Seeded claim.",
					category: "registry",
					whyItMatters: "Seeded relevance.",
					allegationStatus: "unknown",
					confidenceBasis: {},
					entityMatch: {},
				})
				.returning({ id: agentFindings.id });
			const res = await post(
				ctx,
				`/internal/research/applications/${facts.applicationId}/findings/${finding.id}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(res.status).toBe(409);
		} finally {
			await teardown(ctx);
		}
	});

	it("a reaped run's old token writes nothing (stale success cannot land)", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			// Silence the heartbeat so the reaper takes the run; the token
			// turns over (null) on reap.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
			);
			expect(await reapStaleRuns(ctx.db)).toContain(run.id);
			// The background worker still holding the old token must not
			// write: claim fails, zero evidence/finding rows land.
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: {
						status: "degraded",
						hooksFor: () => ({ detach: () => {} }),
						trackModelCall: (_opts, fn) => fn(),
						trackToolExecution: (_opts, fn) => fn(),
					},
				},
				run.id,
				token,
			);
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			expect(after?.errorCode).toBe("timeout");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("a run reaped mid-flight cannot finalize success with the old token", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			// The runner reaps the run mid-flight (after executeRun claimed
			// it): the token turns over before finalize, so the success
			// guard must reject the write — no seam, just a slow agent.
			const reapingRunner = {
				async runBrief(): Promise<AgentResult> {
					await ctx.db.execute(
						sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
					);
					expect(await reapStaleRuns(ctx.db)).toContain(run.id);
					return {
						brief: use.brief,
						fetched: use.fetched,
						usage: {
							inputTokens: 100,
							outputTokens: 100,
							toolCalls: 2,
							searches: 1,
							extracts: 1,
						},
						model: "deepseek/deepseek-v4.1-flash-1017",
					};
				},
			};
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: reapingRunner,
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: {
						status: "degraded",
						hooksFor: () => ({ detach: () => {} }),
						trackModelCall: (_opts, fn) => fn(),
						trackToolExecution: (_opts, fn) => fn(),
					},
				},
				run.id,
				token,
			);
			// finalizeSuccess's stale-token guard fired: the run stays
			// failed/timeout with zero evidence/finding rows, even though
			// validation built findings before the finalize attempt.
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			expect(after?.errorCode).toBe("timeout");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle 404s before success, 409s when nothing stays accepted", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const env = loadEnv();
			const facts = caseFacts();
			// Queued run: no succeeded bundle yet.
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const queued = await get(
				ctx,
				`/internal/research/applications/${facts.applicationId}/runs/${run.id}/bundle`,
				officer,
			);
			expect(queued.status).toBe(404);

			// Succeeded run with zero accepted findings: explicit stale, not
			// a min(1) schema surprise.
			const settledFacts = caseFacts();
			const { runId, findings } = await settledRun(ctx, settledFacts);
			expect(findings.length).toBeGreaterThan(0);
			const empty = await get(
				ctx,
				`/internal/research/applications/${settledFacts.applicationId}/runs/${runId}/bundle`,
				officer,
			);
			expect(empty.status).toBe(409);
			const body = (await empty.json()) as { error: { code: string } };
			expect(body.error.code).toBe("RESEARCH_SELECTION_STALE");
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle viewedAt follows the requesting officer, not any officer", async () => {
		const ctx = setupApp();
		try {
			const officerA = user("officer");
			const officerB = user("officer");
			const facts = caseFacts();
			const { runId, findings } = await settledRun(ctx, facts);
			const reviewPath = (id: string) =>
				`/internal/research/applications/${facts.applicationId}/findings/${id}/review`;
			await post(ctx, reviewPath(findings[0].id), officerA, { action: "accepted" });

			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			const bundlePath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/bundle`;
			// Only officer A views.
			expect((await post(ctx, viewPath, officerA, {})).status).toBe(200);

			const bundleA = (await (await get(ctx, bundlePath, officerA)).json()) as {
				bundle: { viewedAt: string | null };
			};
			expect(bundleA.bundle.viewedAt).not.toBe(null);
			// Officer B never viewed: their bundle carries no viewedAt, even
			// though the run was viewed by someone.
			const bundleB = (await (await get(ctx, bundlePath, officerB)).json()) as {
				bundle: { viewedAt: string | null };
			};
			expect(bundleB.bundle.viewedAt).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});
});

const SCOPED_OFFICIAL_URL = "https://find-and-update.company-information.service.gov.uk/company/9";
const SCOPED_NEWS_URL = "https://www.bbc.co.uk/news/scoped-case";

/** Quote-aware judge: a claim is supported only by its own passage. */
const scopedJudge: SupportJudge = async (claim, quote) => {
	const supported =
		(claim.includes("Alpha") && quote.includes("Alpha")) ||
		(claim.includes("Beta") && quote.includes("Beta"));
	if (!supported) return { verdict: "unsupported", span: null };
	return { verdict: "supported", span: quote.slice(0, Math.min(quote.length, 200)) };
};

function scopedFixture(): { brief: unknown; fetched: AgentResult["fetched"] } {
	const quoteA = "Alpha Corp opened a Leeds office in 2024.";
	const quoteB = "Beta Ltd filed 2024 accounts on time.";
	return {
		brief: {
			summary: "Two findings.",
			findings: [
				{
					claim: "Alpha Corp opened a Leeds office in 2024.",
					category: "market",
					whyItMatters: "Context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
				{
					// Links ONLY ev-1, whose quote cannot support it; ev-2
					// must not rescue it (per-finding scope).
					claim: "Beta Ltd filed 2024 accounts on time.",
					category: "registry",
					whyItMatters: "Context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
			],
			evidence: [
				{
					localId: "ev-1",
					url: SCOPED_OFFICIAL_URL,
					title: "Alpha filing",
					publisher: "Companies House",
					publishedAt: null,
					quote: quoteA,
				},
				{
					localId: "ev-2",
					url: SCOPED_NEWS_URL,
					title: "Beta news",
					publisher: "BBC",
					publishedAt: null,
					quote: quoteB,
				},
			],
			contradictions: [],
			unknowns: [],
			questionsForOfficer: [],
		},
		fetched: [
			{
				requestedUrl: SCOPED_OFFICIAL_URL,
				returnedUrl: SCOPED_OFFICIAL_URL,
				title: "Alpha filing",
				searchPublishedDate: null,
				rawContent: `page\n${quoteA}\nmore`,
			},
			{
				requestedUrl: SCOPED_NEWS_URL,
				returnedUrl: SCOPED_NEWS_URL,
				title: "Beta news",
				searchPublishedDate: null,
				rawContent: `page\n${quoteB}\nmore`,
			},
		],
	};
}

describe("failure boundary + judge budget (Wave 2.5)", () => {
	it("judges each finding only against its own linked evidence", async () => {
		const use = scopedFixture();
		const ctx = setupApp(use, { judge: scopedJudge });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(1);
			expect(latest.findings[0].claim).toContain("Alpha");
			// The rejected claim is never persisted in full: index + hash only.
			const discarded = latest.validation?.discarded ?? [];
			expect(discarded).toHaveLength(1);
			expect(discarded[0].findingIndex).toBe(1);
			expect(discarded[0].claimHash).toMatch(/^[0-9a-f]{64}$/);
			expect(JSON.stringify(latest.validation)).not.toContain("Beta Ltd filed");
		} finally {
			await teardown(ctx);
		}
	});

	it("clears the summary and reports pii_leak when content is quarantined", async () => {
		const quote = "The director's diabetes treatment was discussed at the Acme Leeds meeting.";
		const url = "https://www.bbc.co.uk/news/pii-case";
		const ctx = setupApp({
			brief: {
				summary: "The director has a health condition and the firm met.",
				findings: [
					{
						claim: "Acme Ltd held a meeting in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Meeting",
						publisher: "BBC",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Meeting",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
			expect(latest.validation?.scores.pii_leak).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("stores null + unknown when the model date is absent from the page", async () => {
		const quote = "Dated item mentions Acme Ltd opening in Leeds.";
		const url = "https://www.bbc.co.uk/news/dateless-case";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: "Dated item mentions Acme Ltd opening in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Item",
						publisher: "BBC",
						publishedAt: "2025-06-01",
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Item",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.evidence[0].publishedAt).toBe(null);
			expect(latest.evidence[0].dateBasis).toBe("unknown");
		} finally {
			await teardown(ctx);
		}
	});

	it("merges two quotes from one small page into a single evidence row", async () => {
		const url = "https://www.bbc.co.uk/news/shared-page";
		const quoteA = "Alpha line one.";
		const quoteB = "Beta line two.";
		const raw = `start\n${quoteA}\nMiddle.\n${quoteB}\nend`;
		const ctx = setupApp({
			brief: {
				summary: "Shared page.",
				findings: [
					{
						claim: "Alpha line one.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1a", "ev-1b"],
					},
				],
				evidence: [
					{
						localId: "ev-1a",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteA,
					},
					{
						localId: "ev-1b",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteB,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Page",
					searchPublishedDate: null,
					rawContent: raw,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			// One row, not a 23505 on the (run, url, hash) unique key.
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.findings).toHaveLength(1);
			expect(latest.findings[0].evidenceIds).toHaveLength(1);
			// Exact attribution: the surviving row keeps the first quote —
			// the dropped second quote is never attached to this finding.
			expect(latest.evidence[0].quote).toBe(quoteA);
			expect(latest.findings[0].evidence).toHaveLength(1);
			expect(latest.findings[0].evidence[0].quote).toBe(quoteA);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops a finding that cites only the duplicate quote, never misattributing it", async () => {
		const url = "https://www.bbc.co.uk/news/shared-page-second";
		const quoteA = "Alpha line one here.";
		const quoteB = "Beta line two here.";
		const raw = `start\n${quoteA}\nMiddle.\n${quoteB}\nend`;
		const ctx = setupApp({
			brief: {
				summary: "Shared page.",
				findings: [
					{
						claim: "Beta line two here.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1b"],
					},
				],
				evidence: [
					{
						localId: "ev-1a",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteA,
					},
					{
						localId: "ev-1b",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteB,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Page",
					searchPublishedDate: null,
					rawContent: raw,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.evidence[0].quote).toBe(quoteA);
			// The finding cited only the dropped duplicate: discarded with
			// an explicit reason, never attached to the first row's quote.
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded).toHaveLength(1);
			expect(latest.validation?.discarded[0].reason).toMatch(/duplicate/);
			expect(JSON.stringify(latest.validation)).not.toContain("Beta line two here.");
		} finally {
			await teardown(ctx);
		}
	});

	it("never rejects: bad tokens and runner crashes settle without unhandled rejection", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const degraded = {
				status: "degraded" as const,
				hooksFor: () => ({ detach: () => {} }),
				trackModelCall: <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
				trackToolExecution: <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
			};
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await expect(
				executeRun(
					{
						db: ctx.db,
						env,
						logger: testLogger,
						runner: stubAgentRunner({ brief: null, fetched: [] }),
						judge: stubSupportJudge(),
						repair: stubLanguageRepair(),
						observability: degraded,
					},
					run.id,
					"not-a-token",
				),
			).resolves.toBeUndefined();
			const still = await getRun(ctx.db, run.id);
			expect(still?.status).toBe("queued");

			const facts2 = caseFacts();
			const second = await ensureRun(ctx.db, env, {
				applicationId: facts2.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts2,
				aiResearchConsent: true,
			});
			await expect(
				executeRun(
					{
						db: ctx.db,
						env,
						logger: testLogger,
						runner: stubAgentRunner({ brief: null, fetched: [], throw: new Error("boom") }),
						judge: stubSupportJudge(),
						repair: stubLanguageRepair(),
						observability: degraded,
					},
					second.run.id,
					second.run.runToken as string,
				),
			).resolves.toBeUndefined();
			const latest = await waitLatest(ctx, facts2.applicationId);
			expect(latest.run.status).toBe("failed");
		} finally {
			await teardown(ctx);
		}
	});

	it("enforces AGENT_MAX_COST_USD end-to-end including judge work", async () => {
		const ctx = setupApp();
		try {
			const env = loadEnv();
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await executeRun(
				{
					db: ctx.db,
					env: { ...env, maxCostUsd: 0 },
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: {
						status: "degraded",
						hooksFor: () => ({ detach: () => {} }),
						trackModelCall: (_opts, fn) => fn(),
						trackToolExecution: (_opts, fn) => fn(),
					},
				},
				run.id,
				run.runToken as string,
			);
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("failed");
		} finally {
			await teardown(ctx);
		}
	});

	it("collapses concurrent first views to one row", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const { runId } = await settledRun(ctx, facts);
			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			const results = await Promise.all(
				Array.from({ length: 5 }, () => post(ctx, viewPath, officer, {})),
			);
			expect(results.every((r) => r.status === 200)).toBe(true);
			const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
				deduped: boolean;
			}>;
			expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
			const rows = (await ctx.db.execute(
				sql`SELECT count(*)::int AS n FROM agent_run_views WHERE run_id = ${runId} AND officer_id = ${officer.id}`,
			)) as unknown as Array<{ n: number }>;
			expect(rows[0]?.n).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("language repair (Wave 5)", () => {
	/** successFixture brief with decision language in the summary and findings. */
	function forbiddenFixture(): { brief: unknown; fetched: AgentResult["fetched"] } {
		const use = successFixture();
		const brief = use.brief as {
			findings: Array<Record<string, unknown>>;
			evidence: unknown;
			contradictions: unknown;
			unknowns: unknown;
			questionsForOfficer: unknown;
		};
		return {
			brief: {
				summary: "Registry shows timely filings; the loan terms look fine.",
				findings: [
					{ ...brief.findings[0], whyItMatters: "Timely filing supports approval." },
					{
						...brief.findings[1],
						claim: "Local paper rates Acme Ltd a growing firm in Leeds.",
						whyItMatters: "Growth decides the application.",
					},
				],
				evidence: brief.evidence,
				contradictions: brief.contradictions,
				unknowns: brief.unknowns,
				questionsForOfficer: brief.questionsForOfficer,
			},
			fetched: use.fetched,
		};
	}

	it("repairs decision language once and succeeds", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair({
			repair: (brief) => ({
				...brief,
				summary: "Registry shows timely filings in the public record.",
				findings: brief.findings.map((f, i) => ({
					...f,
					claim: i === 1 ? "Local paper describes Acme Ltd as a growing firm in Leeds." : f.claim,
					whyItMatters: "This is part of the public record for the officer to weigh.",
				})),
			}),
		});
		const ctx = setupApp(use, { repair });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			// Exactly one repair call; usage counts toward the run budget.
			expect(repair.calls).toBe(1);
			expect(latest.usage?.repairCalls).toBe(1);
			// Nothing added or lost: same findings, evidence, and links.
			expect(latest.findings).toHaveLength(2);
			expect(latest.evidence).toHaveLength(2);
			expect(latest.brief?.summary).toBe("Registry shows timely filings in the public record.");
			expect(JSON.stringify(latest)).not.toMatch(
				/loan terms|supports approval|decides the application/i,
			);
		} finally {
			await teardown(ctx);
		}
	});

	it("fails safely with zero persisted rows when repair cannot clean the brief", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair(); // identity: still dirty
		const ctx = setupApp(use, {
			repair,
			observability: {
				status: "ok",
				hooksFor: () => ({ detach: () => {} }),
				trackModelCall: (_opts, fn) => fn(),
				trackToolExecution: (_opts, fn) => fn(),
			},
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("failed");
			expect(latest.run.errorCode).toBe("validation_failed");
			expect(repair.calls).toBe(1);
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief).toBe(null);
			// The failure row carries the real status, not the insert default.
			expect(latest.run.observability).toBe("ok");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, latest.run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, latest.run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects a repair that adds findings or evidence", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair({
			repair: (brief) => ({
				...brief,
				summary: "Registry shows timely filings in the public record.",
				findings: [
					...brief.findings.map((f) => ({
						...f,
						whyItMatters: "This is part of the public record.",
					})),
					{
						claim: "Acme Ltd held a meeting in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					...brief.evidence,
					{
						localId: "ev-3",
						url: "https://www.bbc.co.uk/news/acme-leeds",
						title: "Extra",
						publisher: "BBC",
						publishedAt: null,
						quote: "Local paper notes Acme Ltd opened a second warehouse in Leeds.",
					},
				],
			}),
		});
		const ctx = setupApp(use, { repair });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("failed");
			expect(latest.run.errorCode).toBe("validation_failed");
			expect(repair.calls).toBe(1);
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(JSON.stringify(latest.validation)).not.toContain("held a meeting");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("run conversation threading (Wave 7)", () => {
	it("threads the run id to every judge and repair call", async () => {
		const judgeRunIds: Array<string | undefined> = [];
		const repairRunIds: Array<string | undefined> = [];
		const use = successFixture();
		const brief = use.brief as { summary: string } & Record<string, unknown>;
		const judge: SupportJudge = async (_claim, quote, opts) => {
			judgeRunIds.push(opts?.runId);
			return { verdict: "supported", span: quote.slice(0, Math.min(quote.length, 200)) };
		};
		const repair: LanguageRepair = async (b, opts) => {
			repairRunIds.push(opts?.runId);
			return {
				brief: {
					...b,
					summary: "Registry shows timely filings in the public record.",
				},
			};
		};
		const ctx = setupApp(
			{
				brief: { ...brief, summary: "Registry shows timely filings; the loan terms look fine." },
				fetched: use.fetched,
			},
			{ judge, repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const created = (await res.json()) as { run: { id: string } };
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			// Every direct model call joins the run conversation: same id throughout.
			expect(judgeRunIds.length).toBeGreaterThan(0);
			expect(judgeRunIds.every((id) => id === created.run.id)).toBe(true);
			expect(repairRunIds).toEqual([created.run.id]);
			expect(latest.usage?.repairCalls).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("correctness boundaries (Wave A)", () => {
	it("rejects evidence dated after asOf, discarding the citing finding", async () => {
		const quote = "Acme Ltd filed accounts for the year ending March 2025 on time.";
		const url = "https://find-and-update.company-information.service.gov.uk/company/9";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: quote,
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Filings",
						publisher: "Companies House",
						publishedAt: "2026-02-01",
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Filings",
					searchPublishedDate: null,
					rawContent: `Published 2026-02-01.\n${quote}\nfooter`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded).toHaveLength(1);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
		} finally {
			await teardown(ctx);
		}
	});

	it("maps ModelUnavailableError to model_unavailable and missing keys to config_error", async () => {
		for (const [err, code] of [
			[new ModelUnavailableError("boom"), "model_unavailable"],
			[new ModelUnavailableError("model is not configured"), "config_error"],
			[new TavilyError("search is not configured"), "config_error"],
			[new TavilyError("tool budget exceeded"), "tool_error"],
		] as Array<[Error, string]>) {
			const use = successFixture();
			const ctx = setupApp(use, {
				runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched, throw: err }),
			});
			try {
				const officer = user("officer");
				const facts = caseFacts();
				await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
				const latest = await waitLatest(ctx, facts.applicationId);
				expect(latest.run.status).toBe("failed");
				expect(latest.run.errorCode).toBe(code);
			} finally {
				await teardown(ctx);
			}
		}
	});

	it("discards common-name individual adverse-media (name_only) with an explicit reason", async () => {
		const quote = "John Smith was convicted of fraud in 2021, the gazette notes.";
		const url = "https://www.bbc.co.uk/news/common-name-case";
		const ctx = setupApp({
			brief: {
				summary: "One adverse finding.",
				findings: [
					{
						claim: "John Smith was convicted of fraud in 2021.",
						category: "adverse_media",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: { identifierType: "name_only", value: "John Smith", confidence: "high" },
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{ localId: "ev-1", url, title: "News", publisher: "BBC", publishedAt: null, quote },
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts({
				companyName: null,
				registrationNumber: null,
				applicantName: "John Smith",
			});
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded[0].reason).toMatch(/name_only/);
			expect(JSON.stringify(latest.validation)).not.toContain("John Smith was convicted");
		} finally {
			await teardown(ctx);
		}
	});

	it("caps single-source SME adverse-media at low with a limitation note", async () => {
		const quote = "Acme Ltd was fined for a filing breach, the paper reports.";
		const url = "https://www.bbc.co.uk/news/sme-adverse-case";
		const ctx = setupApp({
			brief: {
				summary: "One adverse finding.",
				findings: [
					{
						claim: "Acme Ltd was fined for a filing breach.",
						category: "adverse_media",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{ localId: "ev-1", url, title: "News", publisher: "BBC", publishedAt: null, quote },
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(1);
			const rows = await ctx.db
				.select({ confidence: agentFindings.confidence })
				.from(agentFindings)
				.where(
					inArray(
						agentFindings.id,
						latest.findings.map((f) => f.id),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.confidence).toBe("low");
			expect(latest.brief?.unknowns.join(" ")).toMatch(/single-source adverse/);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops a finding whose judge claims supported without a span", async () => {
		const use = successFixture();
		const spanless: SupportJudge = async () => ({ verdict: "supported", span: null });
		const ctx = setupApp(use, { judge: spanless });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.unsupportedClaims).toBe(2);
		} finally {
			await teardown(ctx);
		}
	});

	it("keeps an official fraud-record quote carrying a protected term", async () => {
		// The quote carries a protected term (diabetes) inside a genuine
		// fraud record: the exception keeps it on an official source.
		const quote =
			"The filing notes Acme Ltd's director disclosed diabetes treatment before Acme was convicted of fraud in 2021.";
		const url = "https://find-and-update.company-information.service.gov.uk/company/9";
		const ctx = setupApp({
			brief: {
				summary: "One registry finding.",
				findings: [
					{
						claim: "Acme Ltd was convicted of fraud in 2021.",
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Filing",
						publisher: "Companies House",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Filing",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.findings).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops the same protected quote on a non-official source", async () => {
		// Identical protected term + fraud text, but a news tier cannot
		// invoke the fraud-record exception: the quote is quarantined and
		// the citing finding is discarded with zero persisted rows.
		const quote =
			"The filing notes Acme Ltd's director disclosed diabetes treatment before Acme was convicted of fraud in 2021.";
		const url = "https://www.bbc.co.uk/news/protected-quote-case";
		const ctx = setupApp({
			brief: {
				summary: "One registry finding.",
				findings: [
					{
						claim: "Acme Ltd was convicted of fraud in 2021.",
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "News",
						publisher: "BBC",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
			expect(latest.validation?.scores.pii_leak).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops dirty unknowns without a repair call instead of failing the run", async () => {
		const use = successFixture();
		const brief = use.brief as Record<string, unknown>;
		const repair = stubLanguageRepair();
		const ctx = setupApp(
			{
				brief: {
					...brief,
					unknowns: ["No adverse media found, but the loan terms need review."],
				},
				fetched: use.fetched,
			},
			{ repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			// Summary/findings are clean: no repair call is spent on
			// droppable non-findings.
			expect(repair.calls).toBe(0);
			expect(latest.usage?.repairCalls).toBe(0);
			expect(latest.findings).toHaveLength(2);
			expect(JSON.stringify(latest.brief)).not.toMatch(/loan terms/);
		} finally {
			await teardown(ctx);
		}
	});

	it("a repair transport failure cannot fail a run with only dirty non-findings", async () => {
		const use = successFixture();
		const brief = use.brief as Record<string, unknown>;
		const repair = stubLanguageRepair({ throw: new Error("connection refused") });
		const ctx = setupApp(
			{
				brief: {
					...brief,
					unknowns: ["No adverse media found, but the loan terms need review."],
					questionsForOfficer: ["Should we approve this application?"],
				},
				fetched: use.fetched,
			},
			{ repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId);
			expect(latest.run.status).toBe("succeeded");
			expect(repair.calls).toBe(0);
			expect(latest.findings).toHaveLength(2);
			expect(JSON.stringify(latest.brief)).not.toMatch(/loan terms|approve/);
		} finally {
			await teardown(ctx);
		}
	});
});
