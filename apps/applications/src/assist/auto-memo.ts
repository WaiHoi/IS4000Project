// Preliminary credit-memo auto-draft sweep. Runs in the applications service,
// outside the referral workflow, so a slow model never delays the officer
// decision. It is deterministic: case facts, score and policy only, with no
// document text, research fetch, or model call, so the artifact is visible
// before assignment. A later manual Draft memo can add documents/research.
import { applications, generatedArtifacts, withTx, type Db } from "@credit/db/applications";
import { HttpError, writeAudit, type Logger } from "@credit/service-kit";
import { and, asc, eq, gte, inArray, ne, notExists, notInArray } from "drizzle-orm";
import type { AssistActor } from "./access.js";
import { draftCreditMemo } from "./draft.js";
import type { AssistRuntime } from "./types.js";

const SERVICE_ACTOR: AssistActor = {
	id: "00000000-0000-0000-0000-000000000000",
	email: "service:applications",
	role: "service",
};

const FAILURE_BACKOFF_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
// ponytail: process-lifetime cap; a restart re-arms three attempts per case.
// Persist the failure audit count if provider failures become routine.
const MAX_AUTO_ATTEMPTS = 3;
const WINDOW_MS = 24 * 60 * 60_000;

/** Exponential backoff for transient failures; exported for its unit test. */
export function autoMemoBackoffMs(attempt: number): number {
	return Math.min(FAILURE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

export function startAutoMemoSweep(input: {
	db: Db;
	runtime: AssistRuntime;
	logger: Logger;
	intervalMs?: number;
	/** Test scoping only; production sweeps every pending case in the window. */
	applicationIds?: string[];
}): { stop: () => void } {
	const { db, runtime, logger } = input;
	const config = runtime.config;
	if (!config.enabled || !config.memoAutoEnabled) return { stop: () => {} };

	const inFlight = new Set<string>();
	const backoffUntil = new Map<string, number>();
	const failures = new Map<string, number>();
	const givenUp = new Set<string>();
	let ticking = false;

	const audit = async (
		applicationId: string,
		action: "assist.memo.auto_drafted" | "assist.memo.auto_failed",
		payload: Record<string, string | number | boolean | null>,
	): Promise<void> => {
		try {
			await withTx(db, (tx) =>
				writeAudit(tx, {
					applicationId,
					actor: "system",
					action,
					entity: "generated_artifact",
					payload: { feature: "credit_memo", applicationId, ...payload },
				}),
			);
		} catch {
			// Auto-memo audit is best-effort; the artifact audit still runs.
		}
	};

	const tick = async (): Promise<void> => {
		if (ticking) return;
		ticking = true;
		try {
			const since = new Date(runtime.now().getTime() - WINDOW_MS);
			const now = runtime.now().getTime();
			const blocked = [
				...givenUp,
				...inFlight,
				...[...backoffUntil.entries()].filter(([, until]) => until > now).map(([id]) => id),
			];
			const liveMemo = db
				.select({ id: generatedArtifacts.id })
				.from(generatedArtifacts)
				.where(
					and(
						eq(generatedArtifacts.applicationId, applications.id),
						eq(generatedArtifacts.type, "credit_memo"),
						ne(generatedArtifacts.status, "superseded"),
						ne(generatedArtifacts.status, "deleted"),
					),
				);
			const rows = await db
				.select()
				.from(applications)
				.where(
					and(
						eq(applications.status, "pending_review"),
						gte(applications.updatedAt, since),
						notExists(liveMemo),
						blocked.length > 0 ? notInArray(applications.id, blocked) : undefined,
						input.applicationIds ? inArray(applications.id, input.applicationIds) : undefined,
					),
				)
				.orderBy(asc(applications.updatedAt))
				.limit(10);
			for (const application of rows) {
				if (inFlight.has(application.id)) continue;
				if (givenUp.has(application.id)) continue;
				const until = backoffUntil.get(application.id) ?? 0;
				if (until > runtime.now().getTime()) continue;
				inFlight.add(application.id);
				try {
					const result = await draftCreditMemo({
						db,
						runtime,
						logger,
						application,
						actor: SERVICE_ACTOR,
						assignedToMe: false,
						documents: false,
						research: false,
						autoDrafted: true,
						skipIfLive: true,
						// Preliminary drafts are deterministic: no documents or
						// research means the model would only paraphrase facts.
						writer: "deterministic",
					});
					if (!result.ok) {
						// Same evidence builds the same invalid content; retrying
						// cannot change the outcome.
						givenUp.add(application.id);
						await audit(application.id, "assist.memo.auto_failed", {
							code: "GENERATED_TEXT_INVALID",
							issueCount: result.issues.length,
						});
						continue;
					}
					failures.delete(application.id);
					backoffUntil.delete(application.id);
					if (!result.replayed) {
						await audit(application.id, "assist.memo.auto_drafted", {
							artifactId: result.artifact.id,
							version: result.artifact.version,
							writer: result.artifact.agentTrace?.writer ?? "deterministic",
						});
					}
				} catch (err) {
					const attempt = (failures.get(application.id) ?? 0) + 1;
					failures.set(application.id, attempt);
					const permanent =
						err instanceof HttpError &&
						(err.status === 404 ||
							err.status === 422 ||
							(err.status === 409 && err.code !== "DRAFT_EXISTS"));
					if (permanent || attempt >= MAX_AUTO_ATTEMPTS) {
						givenUp.add(application.id);
					} else {
						backoffUntil.set(application.id, runtime.now().getTime() + autoMemoBackoffMs(attempt));
					}
					logger.warn(
						{
							applicationId: application.id,
							attempt,
							err: err instanceof Error ? err.message : String(err),
						},
						"auto memo draft failed",
					);
					await audit(application.id, "assist.memo.auto_failed", {
						code: err instanceof HttpError ? err.code : "ERROR",
						attempt,
					});
				} finally {
					inFlight.delete(application.id);
				}
			}
		} catch (err) {
			logger.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				"auto memo sweep failed",
			);
		} finally {
			ticking = false;
		}
	};

	const timer = setInterval(() => void tick(), input.intervalMs ?? 30_000);
	timer.unref?.();
	void tick();
	return { stop: () => clearInterval(timer) };
}
