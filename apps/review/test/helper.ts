// Integration setup: real Postgres (compose) is NOT needed by the review
// service — it is stateless. Tests inject a stub gateway plus a fake
// internal fetch standing in for the applications/loans services.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubGateway, type FakeGateway } from "@credit/service-kit/test";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

process.env.LOG_LEVEL ??= "silent";

export interface TestUser {
	id: string;
	email: string;
	role: "applicant" | "officer";
}

export interface InternalStub {
	/** GET /internal/review/queue body. */
	queue: { items: unknown[] };
	/** GET /internal/applications/:id/decision by application id. */
	decisions: Map<string, { status: string; decision: unknown }>;
	/** Application ids whose decision probe is 404. */
	missing: Set<string>;
	/** GET /internal/loans/by-application/:id by application id (absent → 404). */
	loans: Map<string, { loan: { id: string } }>;
	calls: string[];
}

export interface ResearchStub {
	/** Recorded ensure request bodies. */
	ensureBodies: unknown[];
	/** Recorded `METHOD path` for research calls (view-dedupe assertions). */
	calls: string[];
	/** Case-facts overrides by application id (default: pending + consent). */
	caseFacts: Map<string, Record<string, unknown>>;
	/** Application ids whose case-facts lookup is 404. */
	caseFactsMissing: Set<string>;
	/** Active runs by application id (ensure idempotency). */
	activeRuns: Map<string, { runId: string; status: string }>;
	/** Latest aggregate by application id (absent → 404). */
	aggregates: Map<string, unknown>;
	/** Auto-trigger audit entries by application id (absent → the real
	 * contract: 200 empty when no run exists for the app, 404 when a run
	 * exists that the caller cannot see). */
	audits: Map<string, unknown>;
	/** Run metadata by run id (scoping + status checks). */
	runs: Map<string, { applicationId: string; status: string }>;
	/** Frozen bundles by run id (absent on a succeeded run → 404). */
	bundles: Map<string, unknown>;
	/** Finding reviews by finding id: run, owning app, run status. */
	findings: Map<string, { runId: string; applicationId: string; status: string }>;
	/** Context signals by signal id: run, owning app, superseded flag. */
	signals: Map<string, { runId: string; applicationId: string; superseded: boolean }>;
	/** Run ids whose context retry is claimed/exhausted (→ 409). */
	retryBlocked: Set<string>;
	/** When true, every research call fails transport (→ 502/503). */
	down: boolean;
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	gateway: FakeGateway;
	internal: InternalStub;
	research: ResearchStub;
	secret: string;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function defaultCaseFacts(applicationId: string): Record<string, unknown> {
	const submittedAt = new Date().toISOString();
	return {
		applicationId,
		reference: "APP-2026-TEST",
		type: "sme",
		product: "sme_term_loan",
		amountCents: 6_000_000,
		termMonths: 60,
		submittedAt,
		asOf: submittedAt,
		applicantName: "Test Applicant",
		companyName: "Test Co",
		registrationNumber: "TESTCO1",
		industry: "retail",
		yearsTrading: 4,
		city: "Demo City",
		aiResearchConsent: true,
		status: "pending_review",
	};
}

export interface SetupOptions {
	agentsEnabled?: boolean;
	caseBriefEnabled?: boolean;
}

export function setupApp(opts: SetupOptions = {}): TestContext {
	const base = loadEnv();
	const env = {
		...base,
		agentsEnabled: opts.agentsEnabled ?? true,
		caseBriefEnabled: opts.caseBriefEnabled ?? true,
	};
	const gateway = stubGateway();
	const internal: InternalStub = {
		queue: { items: [] },
		decisions: new Map(),
		missing: new Set(),
		loans: new Map(),
		calls: [],
	};
	const research: ResearchStub = {
		ensureBodies: [],
		calls: [],
		caseFacts: new Map(),
		caseFactsMissing: new Set(),
		activeRuns: new Map(),
		aggregates: new Map(),
		audits: new Map(),
		runs: new Map(),
		bundles: new Map(),
		findings: new Map(),
		signals: new Map(),
		retryBlocked: new Set(),
		down: false,
	};
	const fetchImpl = (async (
		url: string | URL | Request,
		init?: { method?: string; body?: unknown },
	): Promise<Response> => {
		const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const path = new URL(raw).pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		internal.calls.push(path);
		if (path === "/internal/review/queue") return jsonResponse(200, internal.queue);
		let match = path.match(/^\/internal\/applications\/([^/]+)\/decision$/);
		if (match) {
			if (internal.missing.has(match[1])) return jsonResponse(404, { error: "not found" });
			return jsonResponse(
				200,
				internal.decisions.get(match[1]) ?? { status: "pending_review", decision: null },
			);
		}
		match = path.match(/^\/internal\/loans\/by-application\/([^/]+)$/);
		if (match) {
			const loan = internal.loans.get(match[1]);
			return loan ? jsonResponse(200, loan) : jsonResponse(404, { error: "not found" });
		}
		match = path.match(/^\/internal\/applications\/([^/]+)\/case-facts$/);
		if (match) {
			const id = match[1];
			if (internal.missing.has(id) || research.caseFactsMissing.has(id)) {
				return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
			}
			return jsonResponse(200, research.caseFacts.get(id) ?? defaultCaseFacts(id));
		}
		if (path.startsWith("/internal/research/")) {
			research.calls.push(`${method} ${path}`);
			if (research.down) throw new Error("connection refused");
			if (method === "POST" && path === "/internal/research/runs/ensure") {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					applicationId: string;
				};
				const active = research.activeRuns.get(body.applicationId);
				if (active) {
					return jsonResponse(202, {
						run: { id: active.runId, applicationId: body.applicationId, status: active.status },
						inserted: false,
					});
				}
				research.ensureBodies.push(body);
				const runId = randomUUID();
				research.runs.set(runId, { applicationId: body.applicationId, status: "queued" });
				research.activeRuns.set(body.applicationId, { runId, status: "queued" });
				return jsonResponse(202, {
					run: { id: runId, applicationId: body.applicationId, status: "queued" },
					inserted: true,
				});
			}
			match = path.match(/^\/internal\/research\/applications\/([^/]+)\/latest$/);
			if (match && method === "GET") {
				const aggregate = research.aggregates.get(match[1]);
				return aggregate === undefined
					? jsonResponse(404, { error: { code: "NOT_FOUND", message: "no research run" } })
					: jsonResponse(200, aggregate);
			}
			match = path.match(/^\/internal\/research\/applications\/([^/]+)\/audit$/);
			if (match && method === "GET") {
				const appId = match[1];
				const entries = research.audits.get(appId);
				if (entries !== undefined) {
					return jsonResponse(200, { applicationId: appId, entries });
				}
				// Real research contract with no auto history: no run at
				// all → 200 empty (no claim); a run the caller cannot see →
				// audited 404.
				const hasRun = [...research.runs.values()].some((r) => r.applicationId === appId);
				return hasRun
					? jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } })
					: jsonResponse(200, { applicationId: appId, entries: [] });
			}
			match = path.match(/^\/internal\/research\/applications\/([^/]+)\/runs\/([^/]+)\/view$/);
			if (match && method === "POST") {
				const run = research.runs.get(match[2]);
				if (!run || run.applicationId !== match[1]) {
					return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
				}
				return jsonResponse(200, {
					runId: match[2],
					viewedAt: new Date().toISOString(),
					deduped: false,
				});
			}
			match = path.match(/^\/internal\/research\/applications\/([^/]+)\/runs\/([^/]+)\/bundle$/);
			if (match && method === "GET") {
				const run = research.runs.get(match[2]);
				if (!run || run.applicationId !== match[1] || run.status !== "succeeded") {
					return jsonResponse(404, {
						error: { code: "NOT_FOUND", message: "no succeeded research bundle" },
					});
				}
				const bundle = research.bundles.get(match[2]);
				return bundle === undefined
					? jsonResponse(404, {
							error: { code: "NOT_FOUND", message: "no succeeded research bundle" },
						})
					: jsonResponse(200, { bundle });
			}
			match = path.match(
				/^\/internal\/research\/applications\/([^/]+)\/findings\/([^/]+)\/review$/,
			);
			if (match && method === "POST") {
				const finding = research.findings.get(match[2]);
				if (!finding || finding.applicationId !== match[1]) {
					return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
				}
				if (finding.status !== "succeeded") {
					return jsonResponse(409, {
						error: { code: "RUN_NOT_SUCCEEDED", message: "run is not succeeded" },
					});
				}
				const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
				return jsonResponse(201, { id: randomUUID(), findingId: match[2], action: body.action });
			}
			match = path.match(
				/^\/internal\/research\/applications\/([^/]+)\/runs\/([^/]+)\/context\/retry$/,
			);
			if (match && method === "POST") {
				const run = research.runs.get(match[2]);
				if (!run || run.applicationId !== match[1]) {
					return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
				}
				if (research.retryBlocked.has(match[2])) {
					return jsonResponse(409, {
						error: { code: "RETRY_UNAVAILABLE", message: "context retry is not available" },
					});
				}
				return jsonResponse(202, {
					runId: match[2],
					contextStageToken: randomUUID(),
					contextStageVersion: 2,
				});
			}
			match = path.match(
				/^\/internal\/research\/applications\/([^/]+)\/context\/signals\/([^/]+)\/review$/,
			);
			if (match && method === "POST") {
				const signal = research.signals.get(match[2]);
				if (!signal || signal.applicationId !== match[1]) {
					return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
				}
				if (signal.superseded) {
					return jsonResponse(409, {
						error: { code: "SIGNAL_SUPERSEDED", message: "signal was superseded" },
					});
				}
				const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
				return jsonResponse(201, {
					id: randomUUID(),
					signalId: match[2],
					action: body.action,
					signal: { id: match[2], reviewStatus: body.action },
				});
			}
		}
		return jsonResponse(404, { error: "not found" });
	}) as typeof fetch;
	const app = createApp({
		env,
		gateway,
		logger: createLogger("review-test"),
		fetchImpl,
	});
	return { app, gateway, internal, research, secret: base.internalSecret };
}

export function createUser(role: "applicant" | "officer" = "applicant"): TestUser {
	return { id: randomUUID(), email: `svc-${randomUUID()}@example.com`, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	user: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
	body?: string,
): Record<string, string> {
	return {
		...signInternalHeaders(ctx.secret, {
			userId: user.id,
			role: user.role,
			email: user.email,
			method,
			path,
			body,
		}),
		...extra,
	};
}
