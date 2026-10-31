// Agent-worker sweep: closes the gap between "row committed" and "workflow
// started" (the API commits first), and guarantees nothing stays active
// forever. Starts are idempotent (workflow id = kind:runId:token).
//
// The sweep never fails work a live workflow still owns:
//   - a queued row is failed only when its workflow cannot be started (the
//     re-issued start failed, or this worker does not dispatch) and it is
//     older than the whole-run horizon, or at once when its workflow already
//     closed (it will never claim the row). A queued row whose workflow is
//     still running is backlog waiting for a worker slot and is left alone
//     (up to a day).
//   - queued rows are visited in batches through a rotating cursor, so a
//     long-lived backlog cannot starve newer rows of a re-issued start.
//   - a running row is failed only when its lease went stale beyond the
//     whole-run horizon (the workflow and its cleanup were lost), fenced on
//     the stale lease token so a re-lease wins.
import { AGENT_RUN_RETRY } from "@credit/agent-kit/temporal/types";
import { documentIntegrityRuns } from "@credit/db/applications";
import { and, asc, eq, lt, sql, type SQL } from "drizzle-orm";
import {
	failIntegrityRun,
	integrityLeaseSeconds,
	startIntegrityRun,
	type IntegrityRunDeps,
} from "./runs.js";
import type { IntegrityConfig } from "./types.js";

export const SWEEP_RESTART_AFTER_MS = 10_000;
export const SWEEP_OVERDUE_GRACE_MS = 5 * 60_000;
/** Queued backlog whose workflow exists is still failed after this long. */
export const SWEEP_ABANDON_AFTER_MS = 24 * 3_600_000;
/** agentRunWorkflow's backoff cap between attempts (an upper bound per attempt). */
const WORKFLOW_BACKOFF_CAP_MS = AGENT_RUN_RETRY.backoffMaxMs;
const SWEEP_BATCH = 50;

export interface SweepResult {
	restarted: number;
	failed: number;
}

/**
 * Longest a started run can legitimately stay active: every attempt uses
 * its full lease (the activity's start-to-close budget) plus the maximum
 * backoff, plus grace.
 */
export function integrityRunHorizonMs(
	config: Pick<IntegrityConfig, "timeoutMs">,
	maxAttempts: number,
): number {
	const perAttemptMs = integrityLeaseSeconds(config) * 1000 + WORKFLOW_BACKOFF_CAP_MS;
	return Math.max(1, maxAttempts) * perAttemptMs + SWEEP_OVERDUE_GRACE_MS;
}

/**
 * Sweep position across calls: the last queued row visited. Keep one per
 * sweeping process; without it every sweep restarts from the oldest row.
 */
export interface IntegritySweepCursor {
	afterId: string | null;
}

export function createIntegritySweepCursor(): IntegritySweepCursor {
	return { afterId: null };
}

type QueuedRow = { id: string; maxAttempts: number; createdAt: Date };

async function queuedPage(
	deps: IntegrityRunDeps,
	before: Date,
	afterId: string | null,
): Promise<QueuedRow[]> {
	// Keyset on (created_at, id) of the cursor row, compared in SQL so
	// timestamp precision is exact. A vanished cursor row yields no rows,
	// which wraps the cursor.
	const after: SQL | undefined = afterId
		? sql`(${documentIntegrityRuns.createdAt}, ${documentIntegrityRuns.id}) > (SELECT c.created_at, c.id FROM document_integrity_runs c WHERE c.id = ${afterId}::uuid)`
		: undefined;
	return deps.db
		.select({
			id: documentIntegrityRuns.id,
			maxAttempts: documentIntegrityRuns.maxAttempts,
			createdAt: documentIntegrityRuns.createdAt,
		})
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "queued"),
				lt(documentIntegrityRuns.createdAt, before),
				after,
			),
		)
		.orderBy(asc(documentIntegrityRuns.createdAt), asc(documentIntegrityRuns.id))
		.limit(SWEEP_BATCH);
}

/**
 * The next batch of queued rows older than `before`, resuming after the
 * cursor and wrapping to the oldest row once the end is reached, so every
 * queued row gets a start attempt within ceil(backlog / batch) sweeps.
 */
async function queuedBefore(
	deps: IntegrityRunDeps,
	before: Date,
	cursor: IntegritySweepCursor,
): Promise<QueuedRow[]> {
	let rows = await queuedPage(deps, before, cursor.afterId);
	if (rows.length === 0 && cursor.afterId !== null) {
		rows = await queuedPage(deps, before, null);
	}
	cursor.afterId = rows.length < SWEEP_BATCH ? null : (rows[rows.length - 1]?.id ?? null);
	return rows;
}

/** Running rows whose lease expired longer ago than the whole-run horizon. */
async function orphanedRunning(
	deps: IntegrityRunDeps,
	now: Date,
): Promise<Array<{ id: string; leaseToken: string | null }>> {
	const perAttemptMs = integrityLeaseSeconds(deps.config) * 1000 + WORKFLOW_BACKOFF_CAP_MS;
	return deps.db
		.select({ id: documentIntegrityRuns.id, leaseToken: documentIntegrityRuns.leaseToken })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "running"),
				sql`${documentIntegrityRuns.leaseExpiresAt} + (GREATEST(${documentIntegrityRuns.maxAttempts}, 1) * ${perAttemptMs}::bigint + ${SWEEP_OVERDUE_GRACE_MS}::bigint) * interval '1 millisecond' < ${now.toISOString()}::timestamptz`,
			),
		)
		.orderBy(asc(documentIntegrityRuns.leaseExpiresAt))
		.limit(SWEEP_BATCH);
}

/**
 * Re-issues the idempotent start for queued rows older than 10s (when
 * `dispatch`), fails queued rows whose workflow already closed, fails queued
 * rows that cannot be started past the run horizon, and fails running rows
 * orphaned past it. Pass a long-lived `cursor` so successive sweeps rotate
 * through the whole queued backlog.
 */
export async function sweepQueuedIntegrityRuns(
	deps: IntegrityRunDeps,
	opts: { dispatch: boolean; now?: Date; cursor?: IntegritySweepCursor },
): Promise<SweepResult> {
	const now = opts.now ?? deps.now?.() ?? new Date();
	const canStart = opts.dispatch && Boolean(deps.starter);
	let failed = 0;
	let restarted = 0;
	const cursor = opts.cursor ?? createIntegritySweepCursor();
	const restartBefore = new Date(now.getTime() - SWEEP_RESTART_AFTER_MS);
	for (const row of await queuedBefore(deps, restartBefore, cursor)) {
		const ageMs = now.getTime() - row.createdAt.getTime();
		const overdue = ageMs > integrityRunHorizonMs(deps.config, row.maxAttempts);
		let startable = false;
		if (canStart) {
			const outcome = await startIntegrityRun(deps, row);
			if (outcome === "closed") {
				// The workflow finished without claiming the row: no live owner,
				// so the row is not backlog. Fail it now (status-guarded, so a row
				// claimed meanwhile is left alone).
				if (
					await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "workflow closed", {
						onlyStatus: "queued",
					})
				) {
					failed++;
				}
				continue;
			}
			startable = outcome === "started" || outcome === "exists";
			if (startable) restarted++;
		}
		const abandon = overdue && (!startable || ageMs > SWEEP_ABANDON_AFTER_MS);
		if (
			abandon &&
			(await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "queued too long", {
				onlyStatus: "queued",
			}))
		) {
			failed++;
		}
	}
	for (const row of await orphanedRunning(deps, now)) {
		if (!row.leaseToken) continue;
		if (
			await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "lease abandoned", {
				onlyStatus: "running",
				leaseToken: row.leaseToken,
			})
		) {
			failed++;
		}
	}
	return { restarted, failed };
}
