// Run lifecycle (§4): idempotent ensure with advisory lock, token-claimed
// execution, conditional finalize, and a SKIP LOCKED reaper. No partial
// writes: evidence/findings persist in the same transaction as success.
import { randomUUID } from "node:crypto";
import { agentRuns, withTx, type Db } from "@credit/db/research";
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
	caseFacts: CaseFactsPayload;
	aiResearchConsent: boolean;
}

/** Public run summary for API responses (no case facts, no internals). */
export function summarizeRun(run: RunRow): Record<string, unknown> {
	return {
		id: run.id,
		applicationId: run.applicationId,
		feature: run.feature,
		status: run.status,
		requestedBy: run.requestedBy,
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
 * Idempotent by application: returns the active run when one exists,
 * otherwise inserts `queued` with a fresh run token. Execution starts only
 * when `{inserted: true}`. Throws HttpError (403/409/422) for rejected
 * requests; incomplete facts persist a failed run so latest explains why.
 */
export async function ensureRun(
	db: Db,
	env: ResearchEnv,
	input: EnsureInput,
): Promise<{ run: RunRow; inserted: boolean }> {
	if (!input.aiResearchConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
	}
	const facts = input.caseFacts;
	return withTx(db, async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.applicationId}))`);
		// Legacy rows without city need an SME registration number, else reject.
		if (facts.city === null && !facts.registrationNumber) {
			const [row] = await tx
				.insert(agentRuns)
				.values({
					applicationId: input.applicationId,
					feature: "case_brief",
					status: "failed",
					trigger: "officer",
					requestedBy: input.requestedBy,
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
				trigger: "officer",
				requestedBy: input.requestedBy,
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
	});
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
 * the insert default. */
export async function finalizeFailure(
	db: Db,
	runId: string,
	token: string,
	code: RunErrorCode,
	error: string,
	observability: "ok" | "degraded" = "degraded",
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			status: "failed",
			errorCode: code,
			error,
			observability,
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
