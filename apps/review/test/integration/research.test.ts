// Review research routes (SPEC §5, §11–12): officer-only gated ensure/
// latest/view/finding-review plus frozen-bundle decision validation, all
// against fake applications/research/gateway services.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupApp, signed, type TestContext } from "../helper.js";

function fresh(): TestContext {
	return setupApp();
}

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

async function post(
	c: TestContext,
	path: string,
	user: { id: string; email: string; role: "applicant" | "officer" },
	payload?: unknown,
): Promise<Response> {
	const body = payload === undefined ? undefined : JSON.stringify(payload);
	return c.app.request(path, {
		method: "POST",
		headers: {
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...signed(c, user, "POST", path, {}, body),
		},
		body,
	});
}

async function get(
	c: TestContext,
	path: string,
	user: { id: string; email: string; role: "applicant" | "officer" },
): Promise<Response> {
	return c.app.request(path, { headers: signed(c, user, "GET", path) });
}

function errorCode(res: Response): Promise<string> {
	return jsonBody<{ error: { code: string } }>(res).then((b) => b.error.code);
}

async function decide(
	c: TestContext,
	appId: string,
	officer: { id: string; email: string; role: "applicant" | "officer" },
	payload: unknown,
): Promise<Response> {
	const body = JSON.stringify(payload);
	const path = `/api/review/${appId}/decision`;
	return c.app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...signed(c, officer, "POST", path, {}, body),
		},
		body,
	});
}

function seedBundle(c: TestContext, appId: string, runId: string, findingIds: string[]): void {
	c.research.runs.set(runId, { applicationId: appId, status: "succeeded" });
	c.research.bundles.set(runId, {
		agentRunId: runId,
		applicationId: appId,
		briefHash: "sha256:test",
		viewedAt: null,
		acceptedFindings: findingIds.map((findingId) => ({
			findingId,
			claim: "Cited claim.",
			category: "registry",
			entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
			evidence: [{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" }],
		})),
	});
}

describe("POST /api/review/:id/research", () => {
	it("202s {runId,status}; concurrent ensures share the active run", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const path = `/api/review/${appId}/research`;

		const first = await post(c, path, officer);
		expect(first.status).toBe(202);
		const { runId, status } = await jsonBody<{ runId: string; status: string }>(first);
		expect(status).toBe("queued");

		const second = await post(c, path, officer);
		expect(second.status).toBe(202);
		// Idempotent: the active run is returned, no second insert.
		expect(await jsonBody<unknown>(second)).toEqual({ runId, status: "queued" });
		expect(c.research.ensureBodies).toHaveLength(1);
	});

	it("sends only allowlisted case facts plus asOf/consent", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const submittedAt = new Date().toISOString();
		c.research.caseFacts.set(appId, {
			applicationId: appId,
			reference: "APP-1",
			type: "individual",
			product: "personal_loan",
			amountCents: 1_000_000,
			termMonths: 24,
			submittedAt,
			asOf: submittedAt,
			applicantName: "Extra Fields",
			companyName: null,
			registrationNumber: null,
			industry: null,
			yearsTrading: null,
			city: "Demo City",
			aiResearchConsent: true,
			status: "pending_review",
		});
		const res = await post(c, `/api/review/${appId}/research`, officer);
		expect(res.status).toBe(202);
		expect(c.research.ensureBodies).toHaveLength(1);
		const sent = c.research.ensureBodies[0] as {
			applicationId: string;
			caseFacts: Record<string, unknown>;
			aiResearchConsent: boolean;
		};
		expect(sent.applicationId).toBe(appId);
		expect(sent.aiResearchConsent).toBe(true);
		expect(Object.keys(sent.caseFacts).sort()).toEqual(
			[
				"aiResearchConsent",
				"amountCents",
				"applicantName",
				"applicationId",
				"asOf",
				"city",
				"companyName",
				"industry",
				"product",
				"reference",
				"registrationNumber",
				"status",
				"submittedAt",
				"termMonths",
				"type",
				"yearsTrading",
			].sort(),
		);
	});

	it("fails closed on extra case-fact keys: PII never travels", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const submittedAt = new Date().toISOString();
		c.research.caseFacts.set(appId, {
			applicationId: appId,
			reference: "APP-1",
			type: "individual",
			product: "personal_loan",
			amountCents: 1_000_000,
			termMonths: 24,
			submittedAt,
			asOf: submittedAt,
			applicantName: "Extra Fields",
			companyName: null,
			registrationNumber: null,
			industry: null,
			yearsTrading: null,
			city: "Demo City",
			aiResearchConsent: true,
			status: "pending_review",
			// Must never travel: PII beyond the allowlist fails the
			// request instead of being forwarded to research.
			purpose: "renovation",
			nationalId: "SECRET123",
			address: "1 Private Lane",
			dob: "1990-01-01",
		});
		const res = await post(c, `/api/review/${appId}/research`, officer);
		expect(res.status).toBe(502);
		expect(c.research.ensureBodies).toHaveLength(0);
	});

	it("403s applicants; 404s when disabled; 403 without consent; 409 when not pending; 404 unknown", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const applicant = createUser();
		const appId = randomUUID();
		const path = `/api/review/${appId}/research`;

		expect((await post(c, path, applicant)).status).toBe(403);

		const off = setupApp({ agentsEnabled: false });
		const offOfficer = createUser("officer");
		const disabled = await post(off, path, offOfficer);
		expect(disabled.status).toBe(404);
		expect(await errorCode(disabled)).toBe("RESEARCH_DISABLED");

		const noConsentId = randomUUID();
		const noConsentAt = new Date().toISOString();
		c.research.caseFacts.set(noConsentId, {
			applicationId: noConsentId,
			reference: "APP-1",
			type: "individual",
			product: "personal_loan",
			amountCents: 1_000_000,
			termMonths: 24,
			submittedAt: noConsentAt,
			asOf: noConsentAt,
			applicantName: "No Consent",
			companyName: null,
			registrationNumber: null,
			industry: null,
			yearsTrading: null,
			city: "Demo City",
			aiResearchConsent: false,
			status: "pending_review",
		});
		const noConsent = await post(c, `/api/review/${noConsentId}/research`, officer);
		expect(noConsent.status).toBe(403);
		expect(await errorCode(noConsent)).toBe("CONSENT_REQUIRED");

		const decidedId = randomUUID();
		const decidedAt = new Date().toISOString();
		c.research.caseFacts.set(decidedId, {
			applicationId: decidedId,
			reference: "APP-1",
			type: "individual",
			product: "personal_loan",
			amountCents: 1_000_000,
			termMonths: 24,
			submittedAt: decidedAt,
			asOf: decidedAt,
			applicantName: "Decided Case",
			companyName: null,
			registrationNumber: null,
			industry: null,
			yearsTrading: null,
			city: "Demo City",
			aiResearchConsent: true,
			status: "booked",
		});
		const decided = await post(c, `/api/review/${decidedId}/research`, officer);
		expect(decided.status).toBe(409);
		expect(await errorCode(decided)).toBe("CASE_NOT_PENDING");

		const missingId = randomUUID();
		c.research.caseFactsMissing.add(missingId);
		expect((await post(c, `/api/review/${missingId}/research`, officer)).status).toBe(404);
	});
});

describe("GET /api/review/:id/research", () => {
	it("returns the latest aggregate, 404s when none, never records a view", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const applicant = createUser();
		const appId = randomUUID();
		const path = `/api/review/${appId}/research`;

		expect((await get(c, path, applicant)).status).toBe(403);
		expect((await get(c, path, officer)).status).toBe(404);

		const aggregate = {
			run: { id: randomUUID(), applicationId: appId, status: "succeeded" },
			brief: { summary: "Neutral summary." },
			findings: [],
			viewedAt: null,
		};
		c.research.aggregates.set(appId, aggregate);
		const ok = await get(c, path, officer);
		expect(ok.status).toBe(200);
		expect(await jsonBody<unknown>(ok)).toEqual(aggregate);
		expect(c.research.calls.filter((call) => call.includes("/view"))).toHaveLength(0);

		const off = setupApp({ caseBriefEnabled: false });
		const disabled = await get(off, path, createUser("officer"));
		expect(disabled.status).toBe(404);
		expect(await errorCode(disabled)).toBe("RESEARCH_DISABLED");
	});
});

describe("POST /api/review/:id/research/view", () => {
	it("records an app-scoped view; 404 on run/application mismatch", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const otherId = randomUUID();
		const runId = randomUUID();
		c.research.runs.set(runId, { applicationId: appId, status: "succeeded" });

		const ok = await post(c, `/api/review/${appId}/research/view`, officer, { runId });
		expect(ok.status).toBe(200);
		expect(await jsonBody<unknown>(ok)).toMatchObject({ runId, deduped: false });

		const mismatch = await post(c, `/api/review/${otherId}/research/view`, officer, { runId });
		expect(mismatch.status).toBe(404);

		const unknown = await post(c, `/api/review/${appId}/research/view`, officer, {
			runId: randomUUID(),
		});
		expect(unknown.status).toBe(404);

		const bad = await post(c, `/api/review/${appId}/research/view`, officer, {});
		expect(bad.status).toBe(422);
	});
});

describe("POST /api/review/:id/research/findings/:findingId", () => {
	it("appends accept/reject; 404 mismatch; 409 unless the run succeeded", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const runId = randomUUID();
		const findingId = randomUUID();
		const runningId = randomUUID();
		c.research.runs.set(runId, { applicationId: appId, status: "succeeded" });
		c.research.findings.set(findingId, { runId, applicationId: appId, status: "succeeded" });
		c.research.findings.set(runningId, { runId, applicationId: appId, status: "running" });

		const accept = await post(c, `/api/review/${appId}/research/findings/${findingId}`, officer, {
			action: "accepted",
		});
		expect(accept.status).toBe(201);

		const reject = await post(c, `/api/review/${appId}/research/findings/${findingId}`, officer, {
			action: "rejected",
			note: "stale source",
		});
		expect(reject.status).toBe(201);

		const otherApp = randomUUID();
		expect(
			(
				await post(c, `/api/review/${otherApp}/research/findings/${findingId}`, officer, {
					action: "accepted",
				})
			).status,
		).toBe(404);
		expect(
			(
				await post(c, `/api/review/${appId}/research/findings/${runningId}`, officer, {
					action: "accepted",
				})
			).status,
		).toBe(409);
		expect(
			(
				await post(c, `/api/review/${appId}/research/findings/${findingId}`, officer, {
					action: "maybe",
				})
			).status,
		).toBe(422);
	});
});

describe("POST /api/review/:id/decision with research", () => {
	it("503s RESEARCH_UNAVAILABLE when research is down; ordinary decisions still work", async () => {
		const c = fresh();
		const officer = createUser("officer");
		c.research.down = true;

		const appId = randomUUID();
		const researchDecision = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: randomUUID(),
			acceptedFindingIds: [randomUUID()],
		});
		expect(researchDecision.status).toBe(503);
		const failed = await jsonBody<{
			error: { code: string; fields?: Record<string, string[]> };
		}>(researchDecision);
		expect(failed.error.code).toBe("RESEARCH_UNAVAILABLE");
		expect(failed.error.fields?.["retryable"]).toEqual(["true"]);
		expect(c.gateway.decisionCalls).toHaveLength(0);

		// Decide-without path: the same case decides fine with no selection.
		const plain = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
		});
		expect(plain.status).toBe(200);
		expect(c.gateway.decisionCalls.at(-1)?.input).not.toHaveProperty("research");
	});

	it("404s RESEARCH_DISABLED on a selection while disabled, without calling research", async () => {
		const c = setupApp({ agentsEnabled: false });
		const officer = createUser("officer");
		const appId = randomUUID();

		const gated = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: randomUUID(),
			acceptedFindingIds: [randomUUID()],
		});
		expect(gated.status).toBe(404);
		expect(await errorCode(gated)).toBe("RESEARCH_DISABLED");
		expect(c.research.calls).toHaveLength(0);
		expect(c.gateway.decisionCalls).toHaveLength(0);

		// Ordinary decisions skip the gate entirely.
		const plain = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
		});
		expect(plain.status).toBe(200);
		expect(c.research.calls).toHaveLength(0);
	});

	it("accept→decision forwards the frozen bundle covering the accepted finding", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const runId = randomUUID();
		const findingId = randomUUID();
		c.research.runs.set(runId, { applicationId: appId, status: "succeeded" });
		c.research.findings.set(findingId, { runId, applicationId: appId, status: "succeeded" });
		const frozen = {
			agentRunId: runId,
			applicationId: appId,
			briefHash: "sha256:test",
			viewedAt: null,
			acceptedFindings: [
				{
					findingId,
					claim: "Cited claim.",
					category: "registry",
					entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
					evidence: [
						{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" },
					],
				},
			],
		};
		c.research.bundles.set(runId, frozen);

		const accept = await post(c, `/api/review/${appId}/research/findings/${findingId}`, officer, {
			action: "accepted",
		});
		expect(accept.status).toBe(201);

		const res = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [findingId],
		});
		expect(res.status).toBe(200);
		expect(c.gateway.decisionCalls.at(-1)?.input.research).toEqual(frozen);
	});

	it("409s RESEARCH_SELECTION_STALE when the selection is not covered by the frozen bundle", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const runId = randomUUID();
		const acceptedId = randomUUID();
		seedBundle(c, appId, runId, [acceptedId]);

		// Unknown finding id.
		const unknown = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [randomUUID()],
		});
		expect(unknown.status).toBe(409);
		expect(await errorCode(unknown)).toBe("RESEARCH_SELECTION_STALE");
		expect(c.gateway.decisionCalls).toHaveLength(0);

		// Bundle owned by another application.
		const otherApp = randomUUID();
		const cross = await decide(c, otherApp, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [acceptedId],
		});
		expect(cross.status).toBe(409);
		expect(await errorCode(cross)).toBe("RESEARCH_SELECTION_STALE");
		expect(c.gateway.decisionCalls).toHaveLength(0);
	});

	it("409s stale when the run has not succeeded or nothing stays accepted", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const runId = randomUUID();
		const findingId = randomUUID();

		// Running run: the stub bundle endpoint 404s (no succeeded bundle).
		c.research.runs.set(runId, { applicationId: appId, status: "running" });
		const running = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [findingId],
		});
		expect(running.status).toBe(409);
		expect(await errorCode(running)).toBe("RESEARCH_SELECTION_STALE");

		// Succeeded run whose findings were all re-reviewed away: the bundle
		// shape carries an empty accepted list (min(1) schema failure).
		c.research.runs.set(runId, { applicationId: appId, status: "succeeded" });
		c.research.bundles.set(runId, {
			agentRunId: runId,
			applicationId: appId,
			briefHash: "sha256:test",
			viewedAt: null,
			acceptedFindings: [],
		});
		const empty = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [findingId],
		});
		expect(empty.status).toBe(409);
		expect(await errorCode(empty)).toBe("RESEARCH_SELECTION_STALE");
		expect(c.gateway.decisionCalls).toHaveLength(0);
	});

	it("narrows the forwarded bundle to exactly the accepted selection", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const runId = randomUUID();
		const keepId = randomUUID();
		const dropId = randomUUID();
		seedBundle(c, appId, runId, [keepId, dropId]);

		const res = await decide(c, appId, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId: runId,
			acceptedFindingIds: [keepId],
		});
		expect(res.status).toBe(200);
		const forwarded = c.gateway.decisionCalls.at(-1)?.input.research;
		expect(forwarded?.agentRunId).toBe(runId);
		// §8.6: only the used research is frozen — never the whole list.
		expect(forwarded?.acceptedFindings.map((f) => f.findingId)).toEqual([keepId]);
	});

	it("replays without touching research", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const requestId = randomUUID();
		c.internal.decisions.set(appId, {
			status: "declined",
			decision: { id: "dec-1", outcome: "declined", requestId },
		});
		c.research.down = true;
		const replay = await decide(c, appId, officer, {
			requestId,
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "retry",
			agentRunId: randomUUID(),
			acceptedFindingIds: [randomUUID()],
		});
		expect(replay.status).toBe(200);
		expect(c.research.calls).toHaveLength(0);
	});
});

describe("GET /api/review/:id/research/audit", () => {
	it("returns skip entries with no run; 200s empty with no run; 404s cross-officer and unknown cases", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const applicant = createUser();
		const appId = randomUUID();
		const path = `/api/review/${appId}/research/audit`;

		expect((await get(c, path, applicant)).status).toBe(403);

		// No run, but an auto skip is recorded: skip reasons stay visible.
		const eventId = randomUUID();
		c.research.audits.set(appId, [
			{
				action: "auto.skip",
				actorRole: "service",
				runId: null,
				metadata: { triggerEventId: eventId, reason: "consent_required" },
				createdAt: new Date().toISOString(),
			},
		]);
		const ok = await get(c, path, officer);
		expect(ok.status).toBe(200);
		const body = await jsonBody<{
			applicationId: string;
			entries: Array<{ action: string; metadata: Record<string, unknown> }>;
		}>(ok);
		expect(body.applicationId).toBe(appId);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0]).toMatchObject({
			action: "auto.skip",
			metadata: { triggerEventId: eventId, reason: "consent_required" },
		});
		expect(
			c.research.calls.some(
				(call) => call === `GET /internal/research/applications/${appId}/audit`,
			),
		).toBe(true);

		// No history and no run at all: 200 empty, never 404.
		const bareId = randomUUID();
		const bare = await get(c, `/api/review/${bareId}/research/audit`, officer);
		expect(bare.status).toBe(200);
		expect(await jsonBody<unknown>(bare)).toEqual({ applicationId: bareId, entries: [] });

		// Cross-officer read (a run exists the caller cannot see):
		// upstream 404 passes through, never a raw error.
		const strangerId = randomUUID();
		c.research.runs.set(randomUUID(), { applicationId: strangerId, status: "succeeded" });
		expect((await get(c, `/api/review/${strangerId}/research/audit`, officer)).status).toBe(404);

		// Unknown case: the decision probe 404s before research is touched.
		const missingId = randomUUID();
		c.internal.missing.add(missingId);
		const callsBefore = c.research.calls.length;
		expect((await get(c, `/api/review/${missingId}/research/audit`, officer)).status).toBe(404);
		expect(c.research.calls).toHaveLength(callsBefore);

		expect((await get(c, "/api/review/not-a-uuid/research/audit", officer)).status).toBe(404);

		const off = setupApp({ agentsEnabled: false });
		const disabled = await get(off, path, createUser("officer"));
		expect(disabled.status).toBe(404);
		expect(await errorCode(disabled)).toBe("RESEARCH_DISABLED");
	});
});
