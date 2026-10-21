// Internal research API (signed). Run/finding routes are officer-only and
// case-scoped (T00 access grants); access grant/revoke routes are
// service-only. All run/finding routes verify the run belongs to
// `:applicationId`; mismatch is 404.
// Wave 3 (review routes/UI) is out of scope — this file serves review only.
import {
	agentEvidence,
	agentFindingReviews,
	agentFindings,
	agentRunViews,
	findingEvidence,
	withTx,
	type Db,
} from "@credit/db/research";
import {
	HttpError,
	readJson,
	requireService,
	zodFields,
	type Logger,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { caseFactsSchema } from "@credit/core";
import {
	auditResearch,
	claimOfficerAccess,
	grantResearchAccess,
	hasResearchAccess,
	requireOrClaimResearchAccess,
	requireResearchAccess,
	revokeResearchAccess,
	type AccessRole,
} from "./access.js";
import type { AgentRunner } from "./agent.js";
import type { ResearchEnv } from "./env.js";
import {
	ensureRunTx,
	getRun,
	latestRunForApplication,
	summarizeRun,
	type CaseFactsPayload,
	type RunRow,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import { executeRun } from "./run.js";
import type { LanguageRepair } from "./repair.js";
import type { SupportJudge } from "./support.js";
import { sha256Hex } from "./validator.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ensureSchema = z
	.object({
		applicationId: z.uuid(),
		caseFacts: caseFactsSchema,
		aiResearchConsent: z.boolean(),
	})
	.strict();

const reviewSchema = z
	.object({
		action: z.enum(["accepted", "rejected"]),
		note: z.string().max(1000).optional(),
	})
	.strict();

// T00 service-only access management. The role matrix lives here as a
// strict enum: anything outside it is 422, never a silent downgrade.
const grantSchema = z
	.object({
		userId: z.uuid(),
		accessRole: z.enum(["assigned_officer", "compliance", "policy_owner", "safeguarding"]),
	})
	.strict();

const revokeSchema = z
	.object({
		userId: z.uuid(),
	})
	.strict();

export interface ResearchRouteDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	runner: AgentRunner;
	judge: SupportJudge;
	repair: LanguageRepair;
	observability: Observability;
}

const requireOfficer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
	await next();
});

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** UTC minute bucket for the per-officer/run/minute view dedupe key. */
export function viewMinuteBucket(d: Date = new Date()): Date {
	return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

async function scopedRun(db: Db, applicationId: string, runId: string): Promise<RunRow> {
	if (!UUID_RE.test(applicationId) || !UUID_RE.test(runId)) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const run = await getRun(db, runId);
	if (!run || run.applicationId !== applicationId) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	return run;
}

export function researchRoutes(deps: ResearchRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, env, logger, runner, judge, repair, observability } = deps;

	app.post("/internal/research/runs/ensure", requireOfficer, async (c) => {
		const me = c.var.user;
		const parsed = ensureSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(
				422,
				"VALIDATION_ERROR",
				"invalid ensure request",
				zodFields(parsed.error),
			);
		}
		const { applicationId, caseFacts, aiResearchConsent } = parsed.data;
		if (applicationId !== caseFacts.applicationId) {
			throw new HttpError(422, "VALIDATION_ERROR", "application id mismatch");
		}
		// T00: fail-closed validation BEFORE the claim, so a rejected
		// request never leaves an orphan grant behind. ensureRun
		// re-validates the same predicates; drift fails closed there.
		if (!aiResearchConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
		}
		if (caseFacts.status !== "pending_review") {
			throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
		}
		if (caseFacts.asOf !== caseFacts.submittedAt) {
			throw new HttpError(422, "VALIDATION_ERROR", "asOf must equal submittedAt");
		}
		// Claim-on-first-run: another user's active assigned_officer grant is
		// 404 (non-disclosure); otherwise this officer owns the case from here.
		await claimOfficerAccess(db, applicationId, me.id);
		// The run insert and its `run.ensure` audit commit atomically: a
		// failed audit leaves no unaudited run behind.
		const { run, inserted } = await withTx(db, async (tx) => {
			const ensured = await ensureRunTx(tx, env, {
				applicationId,
				requestedBy: me.id,
				caseFacts: caseFacts as CaseFactsPayload,
				aiResearchConsent,
			});
			await auditResearch(tx, {
				applicationId,
				runId: ensured.run.id,
				actorId: me.id,
				actorRole: me.role,
				action: "run.ensure",
				metadata: { status: ensured.run.status, inserted: ensured.inserted },
			});
			return ensured;
		});
		if (inserted && run.runToken) {
			// Exactly one background execution, only when this call inserted.
			// executeRun finalizes every failure path itself; the async
			// wrapper keeps the fire-and-forget rejection-free and logs the
			// sanitized outcome (runId + error code, never case content).
			const token: string = run.runToken;
			const runId = run.id;
			const exec = async (): Promise<void> => {
				try {
					await executeRun({ db, env, logger, runner, judge, repair, observability }, runId, token);
				} catch (err) {
					logger.error(
						{ runId, err: err instanceof Error ? err.message : String(err) },
						"research background execution escaped",
					);
				}
			};
			void exec();
		}
		return c.json({ run: summarizeRun(run), inserted }, 202);
	});

	app.get("/internal/research/applications/:applicationId/latest", requireOfficer, async (c) => {
		const applicationId = c.req.param("applicationId");
		if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		// T11: an auto run carries no officer grant — the first officer to
		// open it claims the case here; any later officer gets 404.
		await requireOrClaimResearchAccess(db, applicationId, c.var.user.id, c.var.user.role);
		const run = await latestRunForApplication(db, applicationId);
		if (!run) throw new HttpError(404, "NOT_FOUND", "no research run for this application");
		await auditResearch(db, {
			applicationId,
			runId: run.id,
			actorId: c.var.user.id,
			actorRole: c.var.user.role,
			action: "run.read",
		});
		return c.json(await aggregateRun(db, run, c.var.user.id));
	});

	app.post(
		"/internal/research/applications/:applicationId/runs/:runId/view",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const run = await scopedRun(db, c.req.param("applicationId"), c.req.param("runId"));
			// T11 claim-on-first-read (see latest).
			await requireOrClaimResearchAccess(db, run.applicationId, me.id, me.role);
			await auditResearch(db, {
				applicationId: run.applicationId,
				runId: run.id,
				actorId: me.id,
				actorRole: me.role,
				action: "run.view",
			});
			const recent = (await db.execute(
				sql`SELECT viewed_at FROM agent_run_views
					WHERE run_id = ${run.id} AND officer_id = ${me.id}
					  AND viewed_at > now() - INTERVAL '60 seconds'
					ORDER BY viewed_at DESC LIMIT 1`,
			)) as unknown as Array<{ viewed_at: string }>;
			if (recent[0]) {
				// Raw execute returns timestamptz as text; parse explicitly.
				const viewedAt = new Date(recent[0].viewed_at).toISOString();
				return c.json({ runId: run.id, viewedAt, deduped: true });
			}
			// Minute-bucket unique index + DO NOTHING: concurrent first
			// views collapse to one row instead of double-inserting.
			const inserted = await db
				.insert(agentRunViews)
				.values({ runId: run.id, officerId: me.id, viewedMinute: viewMinuteBucket() })
				.onConflictDoNothing()
				.returning({ viewedAt: agentRunViews.viewedAt });
			if (inserted[0]) {
				return c.json({
					runId: run.id,
					viewedAt: inserted[0].viewedAt.toISOString(),
					deduped: false,
				});
			}
			// Lost the race inside the bucket: re-read the winner.
			const winner = (await db.execute(
				sql`SELECT viewed_at FROM agent_run_views
					WHERE run_id = ${run.id} AND officer_id = ${me.id}
					ORDER BY viewed_at DESC LIMIT 1`,
			)) as unknown as Array<{ viewed_at: string }>;
			return c.json({
				runId: run.id,
				viewedAt: winner[0]
					? new Date(winner[0].viewed_at).toISOString()
					: new Date().toISOString(),
				deduped: true,
			});
		},
	);

	app.get(
		"/internal/research/applications/:applicationId/runs/:runId/bundle",
		requireOfficer,
		async (c) => {
			const run = await scopedRun(db, c.req.param("applicationId"), c.req.param("runId"));
			// T11 claim-on-first-read (see latest).
			await requireOrClaimResearchAccess(db, run.applicationId, c.var.user.id, c.var.user.role);
			if (run.status !== "succeeded" || !run.brief) {
				throw new HttpError(404, "NOT_FOUND", "no succeeded research bundle");
			}
			// The deciding officer's latest view freezes into the bundle
			// (§2.1.5/§8.6): another officer's view never satisfies it.
			const aggregate = await aggregateRun(db, run, c.var.user.id);
			const accepted = aggregate.findings.filter((f) => f.reviewStatus === "accepted");
			// An empty accepted set is stale, not a bundle: the min(1) schema
			// shape would otherwise surprise review with a 503.
			if (accepted.length === 0) {
				throw new HttpError(
					409,
					"RESEARCH_SELECTION_STALE",
					"no accepted findings remain on this run",
				);
			}
			await auditResearch(db, {
				applicationId: run.applicationId,
				runId: run.id,
				actorId: c.var.user.id,
				actorRole: c.var.user.role,
				action: "bundle.read",
			});
			return c.json({
				bundle: {
					agentRunId: run.id,
					applicationId: run.applicationId,
					briefHash: sha256Hex(JSON.stringify(run.brief)),
					viewedAt: aggregate.viewedAt,
					acceptedFindings: accepted.map((f) => ({
						findingId: f.id,
						claim: f.claim,
						category: f.category,
						entityMatch: f.entityMatch,
						evidence: f.evidence.map((e) => ({
							url: e.url,
							quote: e.quote,
							snapshotHash: e.snapshotHash,
						})),
					})),
				},
			});
		},
	);

	app.post(
		"/internal/research/applications/:applicationId/findings/:findingId/review",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			const findingId = c.req.param("findingId");
			if (!UUID_RE.test(applicationId) || !UUID_RE.test(findingId)) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			const parsed = reviewSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid review", zodFields(parsed.error));
			}
			const findingRows = await db
				.select()
				.from(agentFindings)
				.where(eq(agentFindings.id, findingId))
				.limit(1);
			const finding = findingRows[0];
			if (!finding) throw new HttpError(404, "NOT_FOUND", "not found");
			const run = await getRun(db, finding.runId);
			if (!run || run.applicationId !== applicationId) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			await requireResearchAccess(db, applicationId, me.id, me.role);
			if (run.status !== "succeeded") {
				throw new HttpError(
					409,
					"RUN_NOT_SUCCEEDED",
					"findings can be reviewed only on a succeeded run",
				);
			}
			const [review] = await withTx(db, async (tx) => {
				// Review insert + audit commit atomically: a failed audit
				// leaves no unaudited review behind.
				const [row] = await tx
					.insert(agentFindingReviews)
					.values({
						findingId,
						runId: run.id,
						officerId: me.id,
						action: parsed.data.action,
						note: parsed.data.note ?? null,
					})
					.returning({ id: agentFindingReviews.id });
				await auditResearch(tx, {
					applicationId,
					runId: run.id,
					actorId: me.id,
					actorRole: me.role,
					action: "finding.review",
					metadata: { findingId, reviewAction: parsed.data.action },
				});
				return [row];
			});
			return c.json({ id: review.id, findingId, action: parsed.data.action }, 201);
		},
	);

	// T11: recent auto-trigger history (skips, ensures, duplicates) for an
	// authorized officer — this is how a skip reason becomes visible. With
	// no auto.* history AND no run at all the endpoint returns
	// `{entries:[]}` WITHOUT claiming (merely opening a case page must not
	// assign it); when a run exists but the caller holds no grant it
	// returns the same audited 404 as latest (non-disclosure). Only when
	// history exists does the first officer claim via T00
	// `claimOfficerAccess` (a skip usually leaves no run and no grant
	// behind, so plain requireResearchAccess would 404 for everyone) — any
	// later officer gets 404. An officer who already holds an active grant
	// (assigned or specialist) reads without claiming. Entries carry
	// ids/codes/reasons only, never case facts, quotes, or applicant data.
	app.get("/internal/research/applications/:applicationId/audit", requireOfficer, async (c) => {
		const applicationId = c.req.param("applicationId");
		if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = (await db.execute(
			sql`SELECT action, actor_role, run_id, metadata, created_at FROM research_audit_log
				WHERE application_id = ${applicationId} AND action IN ('auto.skip', 'auto.ensure', 'auto.duplicate')
				ORDER BY created_at DESC LIMIT 50`,
		)) as unknown as Array<{
			action: string;
			actor_role: string;
			run_id: string | null;
			metadata: unknown;
			created_at: string;
		}>;
		if (rows.length === 0) {
			// No auto history: a stranger on a run-less case sees the same
			// empty answer as the owner (nothing is assigned by looking);
			// a stranger on a case with a run gets the audited 404.
			if (await hasResearchAccess(db, applicationId, c.var.user.id)) {
				return c.json({ applicationId, entries: [] });
			}
			const runs = (await db.execute(
				sql`SELECT id FROM agent_runs WHERE application_id = ${applicationId} LIMIT 1`,
			)) as unknown as Array<{ id: string }>;
			if (runs.length === 0) return c.json({ applicationId, entries: [] });
			await requireResearchAccess(db, applicationId, c.var.user.id, c.var.user.role);
			return c.json({ applicationId, entries: [] });
		}
		if (await hasResearchAccess(db, applicationId, c.var.user.id)) {
			await auditResearch(db, {
				applicationId,
				actorId: c.var.user.id,
				actorRole: c.var.user.role,
				action: "run.read",
				metadata: { scope: "auto-audit" },
			});
			return c.json({
				applicationId,
				entries: rows.map((r) => ({
					action: r.action,
					actorRole: r.actor_role,
					runId: r.run_id,
					metadata: r.metadata ?? {},
					createdAt: new Date(r.created_at).toISOString(),
				})),
			});
		}
		await claimOfficerAccess(db, applicationId, c.var.user.id);
		await auditResearch(db, {
			applicationId,
			actorId: c.var.user.id,
			actorRole: c.var.user.role,
			action: "run.read",
			metadata: { scope: "auto-audit" },
		});
		return c.json({
			applicationId,
			entries: rows.map((r) => ({
				action: r.action,
				actorRole: r.actor_role,
				runId: r.run_id,
				metadata: r.metadata ?? {},
				createdAt: new Date(r.created_at).toISOString(),
			})),
		});
	});

	// T00 service-only access management (future auto-trigger principal and
	// specialist grants). Officers and applicants get 403 via
	// `requireService`; every grant/revoke is audited with ids/roles only.
	app.post(
		"/internal/research/applications/:applicationId/access/grants",
		requireService,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			const parsed = grantSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid grant", zodFields(parsed.error));
			}
			const grant = await grantResearchAccess(db, {
				applicationId,
				userId: parsed.data.userId,
				accessRole: parsed.data.accessRole as AccessRole,
				grantedBy: me.id,
				granterRole: me.role,
			});
			return c.json(
				{
					grant: {
						id: grant.id,
						applicationId: grant.applicationId,
						userId: grant.userId,
						accessRole: grant.accessRole,
						grantedBy: grant.grantedBy,
						grantedAt: grant.grantedAt.toISOString(),
						revokedAt: grant.revokedAt?.toISOString() ?? null,
					},
				},
				201,
			);
		},
	);

	app.post(
		"/internal/research/applications/:applicationId/access/revoke",
		requireService,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			const parsed = revokeSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid revoke", zodFields(parsed.error));
			}
			await revokeResearchAccess(db, {
				applicationId,
				userId: parsed.data.userId,
				revokedBy: me.id,
				revokerRole: me.role,
			});
			return c.json({ applicationId, userId: parsed.data.userId, revoked: true });
		},
	);

	return app;
}

interface AggregateFinding {
	id: string;
	claim: string;
	category: string;
	whyItMatters: string;
	allegationStatus: string;
	support: string;
	confidence: string;
	confidenceBasis: unknown;
	entityMatch: unknown;
	evidenceIds: string[];
	evidence: AggregateEvidence[];
	reviewStatus: string;
	reviewedAt: string | null;
}

interface AggregateEvidence {
	id: string;
	url: string;
	finalUrl: string;
	title: string | null;
	publisher: string;
	publishedAt: string | null;
	dateBasis: string;
	retrievedAt: string | null;
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotText: string;
	snapshotHash: string;
	rawContentSha256: string | null;
	sourceTier: string;
}

/** Single evidence DTO: top-level and per-finding share it. */
function toEvidenceDto(e: typeof agentEvidence.$inferSelect): AggregateEvidence {
	return {
		id: e.id,
		url: e.url,
		finalUrl: e.finalUrl,
		title: e.title,
		publisher: e.publisher,
		publishedAt: e.publishedAt,
		dateBasis: e.dateBasis,
		retrievedAt: iso(e.retrievedAt),
		quote: e.quote,
		quoteStart: e.quoteStart,
		quoteEnd: e.quoteEnd,
		snapshotText: e.snapshotText,
		snapshotHash: e.snapshotHash,
		rawContentSha256: e.rawContentSha256,
		sourceTier: e.sourceTier,
	};
}

async function aggregateRun(
	db: Db,
	run: RunRow,
	officerId: string,
): Promise<{
	run: Record<string, unknown>;
	brief: unknown;
	validation: unknown;
	usage: unknown;
	evidence: AggregateEvidence[];
	findings: AggregateFinding[];
	viewedAt: string | null;
}> {
	const [evidenceRows, findingRows, linkRows, reviewRows, viewRows] = await Promise.all([
		db.select().from(agentEvidence).where(eq(agentEvidence.runId, run.id)),
		db.select().from(agentFindings).where(eq(agentFindings.runId, run.id)),
		db
			.select()
			.from(findingEvidence)
			.where(sql`finding_id IN (SELECT id FROM agent_findings WHERE run_id = ${run.id})`),
		db
			.select()
			.from(agentFindingReviews)
			.where(eq(agentFindingReviews.runId, run.id))
			.orderBy(desc(agentFindingReviews.createdAt)),
		db
			.select({ viewedAt: agentRunViews.viewedAt })
			.from(agentRunViews)
			.where(and(eq(agentRunViews.runId, run.id), eq(agentRunViews.officerId, officerId)))
			.orderBy(desc(agentRunViews.viewedAt))
			.limit(1),
	]);
	const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
	const findingEvidenceIds = new Map<string, string[]>();
	for (const link of linkRows) {
		const list = findingEvidenceIds.get(link.findingId) ?? [];
		list.push(link.evidenceId);
		findingEvidenceIds.set(link.findingId, list);
	}
	const latestReview = new Map<string, { action: string; createdAt: Date }>();
	for (const review of reviewRows) {
		if (!latestReview.has(review.findingId)) {
			latestReview.set(review.findingId, { action: review.action, createdAt: review.createdAt });
		}
	}
	return {
		run: summarizeRun(run),
		brief: run.brief,
		validation: run.validation,
		usage: run.usage,
		evidence: evidenceRows.map(toEvidenceDto),
		findings: findingRows.map((f) => {
			const evidenceIds = findingEvidenceIds.get(f.id) ?? [];
			const review = latestReview.get(f.id);
			return {
				id: f.id,
				claim: f.claim,
				category: f.category,
				whyItMatters: f.whyItMatters,
				allegationStatus: f.allegationStatus,
				support: f.support,
				confidence: f.confidence,
				confidenceBasis: f.confidenceBasis,
				entityMatch: f.entityMatch,
				evidenceIds,
				evidence: evidenceIds.flatMap((id) => {
					const e = evidenceById.get(id);
					return e ? [toEvidenceDto(e)] : [];
				}),
				reviewStatus: review?.action ?? "pending",
				reviewedAt: review ? review.createdAt.toISOString() : null,
			};
		}),
		viewedAt: viewRows[0] ? viewRows[0].viewedAt.toISOString() : null,
	};
}
