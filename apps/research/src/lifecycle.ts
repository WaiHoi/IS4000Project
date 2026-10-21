// Run lifecycle (§4): idempotent ensure with advisory lock, token-claimed
// execution, conditional finalize, and a SKIP LOCKED reaper. No partial
// writes: evidence/findings persist in the same transaction as success.
import { randomUUID } from "node:crypto";
import { agentRuns, withTx, type Db, type Tx } from "@credit/db/research";
import { HttpError } from "@credit/service-kit";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ResearchEnv } from "./env.js";
import { AGENT_VERSION, promptHash, PROMPT_VERSION } from "./prompt.js";
import { caseFactsSchema, type CaseFacts } from "@credit/core";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunErrorCode =
	| "model_unavailable"
	| "tool_error"
	| "timeout"
	| "validation_failed"
	| "config_error"
	| "internal_error"
	| "case_facts_incomplete";

export type RunRow = typeof agentRuns.$inferSelect;

export type CaseFactsPayload = CaseFacts;

export interface EnsureInput {
	applicationId: string;
	requestedBy: string;
	/** Officer path: officer (default). Auto path: service. */
	requestedByRole?: "officer" | "service";
	/** Officer path: officer (default). Auto path: auto. */
	trigger?: "officer" | "auto";
	/** Auto path only: the Kafka envelope id (dedupe key). */
	triggerEventId?: string | null;
	/** Auto path only: internal cap accounting, never prompt/trace. */
	applicantUserId?: string | null;
	caseFacts: CaseFactsPayload;
	aiResearchConsent: boolean;
}

/** Public run summary for API responses (no case facts, no internals —
 * `applicantUserId` is cap accounting and never leaves the service). */
export function summarizeRun(run: RunRow): Record<string, unknown> {
	return {
		id: run.id,
		applicationId: run.applicationId,
		feature: run.feature,
		status: run.status,
		trigger: run.trigger,
		requestedBy: run.requestedBy,
		requestedByRole: run.requestedByRole,
		model: run.model,
		agentVersion: run.agentVersion,
		promptVersion: run.promptVersion,
		asOf: run.asOf.toISOString(),
		observability: run.observability,
		errorCode: run.errorCode,
		grafanaConversationId: run.grafanaConversationId,
		createdAt: run.createdAt.toISOString(),
		startedAt: run.startedAt?.toISOString() ?? null,
		finishedAt: run.finishedAt?.toISOString() ?? null,
	};
}

function storedCaseFacts(facts: CaseFactsPayload): Record<string, unknown> {
	// Single schema: new keys flow to storage, never silently dropped.
	// Consent rides the request, never the stored facts/prompt.
	const parsed = caseFactsSchema.parse(facts);
	const { aiResearchConsent: _consent, ...stored } = parsed;
	return stored;
}

/**
 * Idempotent by application: a repeat `triggerEventId` returns the original
 * run (even terminal) with `{inserted:false}` — zero new paid calls —
 * otherwise the active run when one exists, otherwise inserts `queued` with
 * a fresh run token. Execution starts only when `{inserted: true}`. Throws
 * HttpError (403/409/422) for rejected requests; incomplete facts persist
 * a failed run so latest explains why.
 */
export async function ensureRun(
	db: Db,
	env: ResearchEnv,
	input: EnsureInput,
): Promise<{ run: RunRow; inserted: boolean }> {
	return withTx(db, (tx) => ensureRunTx(tx, env, input));
}

/**
 * Same as `ensureRun`, but joins the caller's transaction so the insert
 * and the caller's audit row commit atomically (a failed audit leaves no
 * unaudited run behind).
 */
export async function ensureRunTx(
	tx: Tx,
	env: ResearchEnv,
	input: EnsureInput,
): Promise<{ run: RunRow; inserted: boolean }> {
	if (!input.aiResearchConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
	}
	const facts = input.caseFacts;
	const trigger = input.trigger ?? "officer";
	const requestedByRole = input.requestedByRole ?? "officer";
	const triggerEventId = input.triggerEventId ?? null;
	const applicantUserId = input.applicantUserId ?? null;
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.applicationId}))`);
	// T11: a repeat referral generation returns the original run even
	// when terminal — first, so redelivered events never insert again
	// (not even the failed row below). The advisory lock serializes
	// this with the inserts further down.
	if (triggerEventId) {
		const dup = await tx
			.select()
			.from(agentRuns)
			.where(
				and(
					eq(agentRuns.applicationId, input.applicationId),
					eq(agentRuns.trigger, trigger),
					eq(agentRuns.triggerEventId, triggerEventId),
				),
			)
			.limit(1);
		if (dup[0]) return { run: dup[0], inserted: false };
	}
	// Legacy rows without city need an SME registration number, else reject.
	if (facts.city === null && !facts.registrationNumber) {
		const [row] = await tx
			.insert(agentRuns)
			.values({
				applicationId: input.applicationId,
				feature: "case_brief",
				status: "failed",
				trigger,
				requestedBy: input.requestedBy,
				requestedByRole,
				triggerEventId,
				applicantUserId,
				runToken: null,
				caseFacts: storedCaseFacts(facts),
				model: env.agentModel,
				agentVersion: AGENT_VERSION,
				promptVersion: PROMPT_VERSION,
				promptHash: promptHash(),
				asOf: new Date(facts.asOf),
				grafanaConversationId: randomUUID(),
				observability: "degraded",
				errorCode: "case_facts_incomplete",
				error: "case facts are incomplete for research",
				usage: {},
				timeoutAt: new Date(Date.now() + env.timeoutMs + 30_000),
				finishedAt: new Date(),
			})
			.returning();
		return { run: row, inserted: false };
	}
	if (facts.status !== "pending_review") {
		throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
	}
	if (facts.asOf !== facts.submittedAt) {
		throw new HttpError(422, "VALIDATION_ERROR", "asOf must equal submittedAt");
	}
	const active = await tx
		.select()
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.applicationId, input.applicationId),
				eq(agentRuns.feature, "case_brief"),
				inArray(agentRuns.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(agentRuns.createdAt))
		.limit(1);
	if (active[0]) return { run: active[0], inserted: false };
	const id = randomUUID();
	const [row] = await tx
		.insert(agentRuns)
		.values({
			id,
			applicationId: input.applicationId,
			feature: "case_brief",
			status: "queued",
			trigger,
			requestedBy: input.requestedBy,
			requestedByRole,
			triggerEventId,
			applicantUserId,
			runToken: randomUUID(),
			caseFacts: storedCaseFacts(facts),
			model: env.agentModel,
			agentVersion: AGENT_VERSION,
			promptVersion: PROMPT_VERSION,
			promptHash: promptHash(),
			asOf: new Date(facts.asOf),
			grafanaConversationId: id,
			observability: "degraded",
			usage: {},
			timeoutAt: new Date(Date.now() + env.timeoutMs + 30_000),
		})
		.returning();
	return { run: row, inserted: true };
}

export class StaleRunError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids/tokens match nothing (uuid columns reject them with 22P02). */
function tokenMatch(runId: string, token: string): boolean {
	return UUID_RE.test(runId) && UUID_RE.test(token);
}

/** Claim a queued run for execution; false unless status+token match. */
export async function claimRun(db: Db, runId: string, token: string): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function heartbeatRun(db: Db, runId: string, token: string): Promise<void> {
	if (!tokenMatch(runId, token)) return;
	await db
		.update(agentRuns)
		.set({ heartbeatAt: new Date() })
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		);
}

/** Fail a run; false when the token already turned over (stale). The
 * failure row carries the caller's real observability status, never just
 * the insert default. `usage` is the accumulated partial spend (agent +
 * judge + repair tokens/cost so far): failed runs keep counting toward
 * the auto daily budget instead of reading as free. Omit it only when no
 * work was done (e.g. a losing claim race, which returns false anyway). */
export async function finalizeFailure(
	db: Db,
	runId: string,
	token: string,
	code: RunErrorCode,
	error: string,
	observability: "ok" | "degraded" = "degraded",
	usage?: Record<string, unknown>,
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			status: "failed",
			errorCode: code,
			error,
			observability,
			...(usage !== undefined ? { usage } : {}),
			finishedAt: new Date(),
			runToken: null,
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

/**
 * Reap abandoned runs (§4 predicates): queued past timeout+60s (via the
 * insert-time timeout_at, +30s grace), or running past timeout_at / silent
 * 90s. SKIP LOCKED so concurrent reapers never double-fail.
 */
export async function reapStaleRuns(db: Db): Promise<string[]> {
	return withTx(db, async (tx) => {
		const stale = (await tx.execute(sql`SELECT id FROM agent_runs
			WHERE (status = 'queued' AND timeout_at < now() - INTERVAL '30 seconds')
			   OR (status = 'running' AND (timeout_at < now()
			       OR heartbeat_at IS NULL
			       OR heartbeat_at < now() - INTERVAL '90 seconds'))
			FOR UPDATE SKIP LOCKED`)) as unknown as Array<{ id: string }>;
		if (stale.length === 0) return [];
		const ids = stale.map((r) => r.id);
		await tx
			.update(agentRuns)
			.set({
				status: "failed",
				errorCode: "timeout",
				error: "research run timed out",
				finishedAt: new Date(),
				runToken: null,
			})
			.where(inArray(agentRuns.id, ids));
		return ids;
	});
}

export async function latestRunForApplication(
	db: Db,
	applicationId: string,
): Promise<RunRow | null> {
	const rows = await db
		.select()
		.from(agentRuns)
		.where(and(eq(agentRuns.applicationId, applicationId), eq(agentRuns.feature, "case_brief")))
		.orderBy(desc(agentRuns.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

export async function getRun(db: Db, runId: string): Promise<RunRow | null> {
	const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
	return rows[0] ?? null;
}

/**
 * T11 crash recovery: runs still `queued` ~10s after insert were committed
 * but never claimed (crash between insert and execution start). Returns
 * their ids + tokens; the caller starts each via `executeRun`, whose
 * token-conditional claim makes concurrent starts safe. SKIP LOCKED so
 * concurrent recoverers never double-start. The reaper stays the fallback
 * for runs that never start.
 *
 * Recovery refreshes each row's lease (`timeout_at`/`heartbeat_at`) in the
 * same transaction: a crash-left row is usually already past its timeout,
 * and without the refresh the boot reaper — which runs right after
 * recovery — would fail it before `executeRun` claims it. The refreshed
 * lease only buys one grace window; the claim still requires
 * status+token, so a genuinely stuck run is reaped on the next sweep.
 */
export async function resumeQueuedRuns(db: Db): Promise<Array<{ id: string; runToken: string }>> {
	return withTx(db, async (tx) => {
		const rows = (await tx.execute(sql`SELECT id, run_token FROM agent_runs
			WHERE status = 'queued' AND run_token IS NOT NULL
			  AND created_at < now() - INTERVAL '10 seconds'
			FOR UPDATE SKIP LOCKED`)) as unknown as Array<{ id: string; run_token: string }>;
		if (rows.length === 0) return [];
		const freshTimeout = new Date(Date.now() + RECOVERY_LEASE_MS);
		await tx
			.update(agentRuns)
			.set({ timeoutAt: freshTimeout, heartbeatAt: new Date() })
			.where(
				inArray(
					agentRuns.id,
					rows.map((r) => r.id),
				),
			);
		return rows.map((r) => ({ id: r.id, runToken: r.run_token }));
	});
}

/** Grace window a recovered queued run gets before the reaper may fail it. */
const RECOVERY_LEASE_MS = 5 * 60_000;
