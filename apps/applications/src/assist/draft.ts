// Shared credit-memo draft path for the manual route and the auto-memo sweep.
// The model writes prose only; the number-led sections are composed from the
// the deterministic builder after the agent returns. Both callers validate
// before persistence and audit metadata only.
import { randomUUID } from "node:crypto";
import { validateGeneratedText, type ValidationIssue } from "@credit/core";
import { applications, type Db } from "@credit/db/applications";
import { HttpError, type Logger } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { MemoAgentError, runMemoAgent } from "../agents/memo-writer/index.js";
import { evidenceHash } from "../agents/shared/trace.js";
import type { AssistActor } from "./access.js";
import { createArtifact, findArtifactByEvidence, listArtifacts } from "./artifacts.js";
import type { CreateArtifactInput } from "./artifacts.js";
import { assembleCaseEvidence, isDocumentDerived } from "./evidence.js";
import { buildCreditMemo, composeCreditMemo } from "./memo.js";
import type { ArtifactDto, AssistConfig, AssistRuntime, MemoAgentTrace } from "./types.js";

type ApplicationRow = typeof applications.$inferSelect;

export function validationFailure(issues: ValidationIssue[]): {
	error: { code: "GENERATED_TEXT_INVALID"; message: string; issues: ValidationIssue[] };
} {
	return {
		error: {
			code: "GENERATED_TEXT_INVALID",
			message: "generated text failed validation",
			issues: issues.slice(0, 100),
		},
	};
}

/** Idempotent replay only within the current writer configuration: the
 * existing artifact must have been produced by the current mode and versions.
 * A hash hit from the other writer (or a version drift) regenerates instead of
 * returning stale provenance. */
export function memoReplayMatches(
	artifact: ArtifactDto,
	config: AssistConfig,
	writer: "deterministic" | "agent" = config.memoWriter,
): boolean {
	const trace = artifact.agentTrace;
	if (writer === "agent") {
		return (
			trace?.writer === "agent" &&
			artifact.model === config.memoModel &&
			artifact.promptVersion === config.memoPromptVersion &&
			trace?.agentVersion === config.memoAgentVersion
		);
	}
	return (
		trace?.writer === "deterministic" &&
		artifact.model === config.model &&
		artifact.promptVersion === config.promptVersion
	);
}

export interface DraftMemoInput {
	db: Db;
	runtime: AssistRuntime;
	logger: Logger;
	application: ApplicationRow;
	actor: AssistActor;
	assignedToMe: boolean;
	/** False for the preliminary auto draft: no document text. */
	documents: boolean;
	/** False for the preliminary auto draft: no research/policy-review fetch. */
	research: boolean;
	/** True for the auto sweep; recorded on the trace and audit metadata. */
	autoDrafted?: boolean;
	/** Auto sweep: never create when any live credit memo already exists. */
	skipIfLive?: boolean;
	/** Preliminary auto drafts force the deterministic writer (no model call). */
	writer?: "deterministic" | "agent";
}

export type DraftMemoResult =
	| { ok: true; artifact: ArtifactDto; replayed: boolean }
	| { ok: false; issues: ValidationIssue[] };

function isLiveMemo(artifact: ArtifactDto): boolean {
	return artifact.status !== "superseded" && artifact.status !== "deleted";
}

/** Auto sweep: a concurrent manual draft/approval wins. */
async function persistMemo(
	db: Db,
	input: CreateArtifactInput,
	skipIfLive: boolean,
): Promise<ArtifactDto | null> {
	try {
		return await createArtifact(db, input);
	} catch (err) {
		if (skipIfLive && err instanceof HttpError && err.code === "DRAFT_EXISTS") return null;
		throw err;
	}
}

export async function draftCreditMemo(input: DraftMemoInput): Promise<DraftMemoResult> {
	const { db, runtime, logger, application, actor } = input;
	const config = runtime.config;
	const writer = input.writer ?? config.memoWriter;
	if (application.status !== "pending_review") {
		throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
	}
	if (!config.enabled) throw new HttpError(404, "NOT_FOUND", "not found");
	if (input.skipIfLive) {
		const live = (await listArtifacts(db, application.id, "credit_memo")).find(isLiveMemo);
		if (live) return { ok: true, artifact: live, replayed: true };
	}
	// The sweep selects rows up front and may run long model calls; re-read the
	// status so a case decided mid-sweep never gets a new memo.
	const [current] = await db
		.select({ status: applications.status })
		.from(applications)
		.where(eq(applications.id, application.id))
		.limit(1);
	if (current?.status !== "pending_review") {
		throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
	}

	const evidence = await assembleCaseEvidence({
		db,
		application,
		officer: actor,
		assignedToMe: input.assignedToMe,
		documentsEnabled: input.documents && runtime.documentsEnabled,
		fraudReviewEnabled: runtime.fraudReviewEnabled,
		now: runtime.now(),
		research: input.research
			? {
					url: config.researchUrl,
					secret: config.internalSecret,
					timeoutMs: config.researchTimeoutMs,
					fetchImpl: runtime.researchFetchImpl,
				}
			: { url: null, secret: "", timeoutMs: 0 },
	});
	const startedAt = Date.now();
	const hash = evidenceHash(evidence);
	const replayed = await findArtifactByEvidence(db, {
		applicationId: application.id,
		type: "credit_memo",
		evidenceHash: hash,
	});
	if (replayed && memoReplayMatches(replayed, config, writer)) {
		return { ok: true, artifact: replayed, replayed: true };
	}
	const documentDerived = isDocumentDerived(evidence.items);

	if (writer === "agent") {
		const memoAgentRunner = runtime.memoAgentRunner;
		if (!memoAgentRunner) {
			throw new HttpError(503, "MEMO_AGENT_UNAVAILABLE", "memo agent is not configured");
		}
		const built = buildCreditMemo({ application, evidence });
		let result: Awaited<ReturnType<typeof runMemoAgent>>;
		try {
			result = await runMemoAgent({
				application,
				evidence,
				base: built,
				runner: memoAgentRunner,
				runId: randomUUID(),
				config: {
					model: config.memoModel,
					promptVersion: config.memoPromptVersion,
					agentVersion: config.memoAgentVersion,
					maxSteps: config.memoMaxSteps,
					maxToolCalls: config.memoMaxToolCalls,
					timeoutMs: config.memoTimeoutMs,
					maxCostUsd: config.memoMaxCostUsd,
				},
				signal: AbortSignal.timeout(config.memoTimeoutMs),
			});
		} catch (err) {
			if (err instanceof MemoAgentError) {
				logger.warn(
					{
						applicationId: application.id,
						code: err.code,
						issueCodes: err.issues.map((issue) => issue.code),
						autoDrafted: input.autoDrafted === true,
					},
					"assist memo agent failed",
				);
				if (err.code === "TIMEOUT")
					throw new HttpError(504, "MEMO_AGENT_TIMEOUT", "memo agent timed out");
				if (err.code === "MODEL_ERROR")
					throw new HttpError(502, "MEMO_AGENT_UNAVAILABLE", "memo agent is unavailable");
				if (
					err.code === "STEP_LIMIT" ||
					err.code === "TOOL_CALL_LIMIT" ||
					err.code === "BUDGET_EXCEEDED"
				) {
					throw new HttpError(422, "MEMO_AGENT_BUDGET", "memo agent budget exceeded");
				}
				throw new HttpError(422, "MEMO_AGENT_INVALID", "memo agent output failed validation");
			}
			throw err;
		}
		const content = composeCreditMemo(result.content, built);
		const validation = validateGeneratedText({
			artifactType: "credit_memo",
			content,
			evidence,
		});
		if (!validation.ok) {
			logger.warn(
				{
					applicationId: application.id,
					issueCodes: validation.issues.map((issue) => issue.code),
					autoDrafted: input.autoDrafted === true,
				},
				"assist memo validation failed",
			);
			return { ok: false, issues: validation.issues };
		}
		const trace: MemoAgentTrace = {
			...result.trace,
			autoDrafted: input.autoDrafted === true ? true : undefined,
		};
		const artifact = await persistMemo(
			db,
			{
				applicationId: application.id,
				type: "credit_memo",
				content: validation.content,
				citations: validation.citations,
				documentDerived,
				createdBy: actor.id,
				actorRole: actor.role,
				model: config.memoModel,
				promptVersion: config.memoPromptVersion,
				retentionDays: config.retentionDays,
				supersedeDraft: input.skipIfLive !== true,
				onlyIfNoLive: input.skipIfLive === true,
				agentTrace: trace,
				evidenceHash: hash,
				auditMetadata: {
					writer: trace.writer,
					agentVersion: trace.agentVersion,
					toolCallCount: trace.toolCalls.length,
					sourceRefCount: trace.sourceRefs.length,
					repairAttempted: trace.repairAttempted,
					autoDrafted: input.autoDrafted === true,
				},
				now: runtime.now(),
			},
			input.skipIfLive === true,
		);
		if (artifact === null) {
			const live = (await listArtifacts(db, application.id, "credit_memo")).find(isLiveMemo);
			if (live) return { ok: true, artifact: live, replayed: true };
			throw new HttpError(409, "DRAFT_EXISTS", "a live artifact already exists");
		}
		logger.info(
			{
				applicationId: application.id,
				artifactId: artifact.id,
				version: artifact.version,
				writer: trace.writer,
				autoDrafted: input.autoDrafted === true,
			},
			"assist memo drafted",
		);
		return { ok: true, artifact, replayed: false };
	}

	const content = buildCreditMemo({ application, evidence });
	const validation = validateGeneratedText({
		artifactType: "credit_memo",
		content,
		evidence,
	});
	if (!validation.ok) {
		logger.warn(
			{
				applicationId: application.id,
				issueCount: validation.issues.length,
				autoDrafted: input.autoDrafted === true,
			},
			"assist memo validation failed",
		);
		return { ok: false, issues: validation.issues };
	}
	const trace: MemoAgentTrace = {
		writer: "deterministic",
		agentVersion: config.memoAgentVersion,
		model: config.model,
		promptVersion: config.promptVersion,
		evidenceHash: hash,
		steps: 1,
		toolCalls: [],
		sourceRefs: [...new Set(validation.citations.map((citation) => citation.ref))].sort(),
		repairAttempted: false,
		repairSucceeded: null,
		fallbackReason: null,
		inputTokens: 0,
		outputTokens: 0,
		latencyMs: Math.max(0, Date.now() - startedAt),
		autoDrafted: input.autoDrafted === true ? true : undefined,
	};
	const artifact = await persistMemo(
		db,
		{
			applicationId: application.id,
			type: "credit_memo",
			content: validation.content,
			citations: validation.citations,
			documentDerived,
			createdBy: actor.id,
			actorRole: actor.role,
			model: config.model,
			promptVersion: config.promptVersion,
			retentionDays: config.retentionDays,
			supersedeDraft: input.skipIfLive !== true,
			onlyIfNoLive: input.skipIfLive === true,
			agentTrace: trace,
			evidenceHash: hash,
			auditMetadata: {
				writer: trace.writer,
				agentVersion: trace.agentVersion,
				toolCallCount: 0,
				sourceRefCount: trace.sourceRefs.length,
				repairAttempted: false,
				autoDrafted: input.autoDrafted === true,
			},
			now: runtime.now(),
		},
		input.skipIfLive === true,
	);
	if (artifact === null) {
		const live = (await listArtifacts(db, application.id, "credit_memo")).find(isLiveMemo);
		if (live) return { ok: true, artifact: live, replayed: true };
		throw new HttpError(409, "DRAFT_EXISTS", "a live artifact already exists");
	}
	logger.info(
		{
			applicationId: application.id,
			artifactId: artifact.id,
			version: artifact.version,
			writer: trace.writer,
			autoDrafted: input.autoDrafted === true,
		},
		"assist memo drafted",
	);
	return { ok: true, artifact, replayed: false };
}
