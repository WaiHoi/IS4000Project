// T01 document routes (SPEC-t01-t02 §5): upload, list, metadata,
// pages, download, retry-ocr, claim. Every nested lookup joins
// application_id and 404s on mismatch; feature-off 404s; missing consent
// is 403 CONSENT_REQUIRED; cross-applicant/officer is a non-leaking 404.
// T02 cross-check/chase (D2) live here too: assigned-officer only, no-store,
// ids-only audits.
import { withTx, type Db } from "@credit/db/applications";
import {
	HttpError,
	readJson,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
} from "@credit/service-kit";
import { Hono } from "hono";
import { z } from "zod";
import { claimAssignedOfficer, resolveDocumentAccess } from "./access.js";
import { createChaseDraft, getLatestCrosscheck, runDocumentCrosscheck } from "./crosscheck.js";
import { LockTimeout, parseKind } from "./pipeline.js";
import { contentDispositionFor } from "./storage.js";
import { DocumentService, type DocumentsConfig, type DocumentFileRow } from "./service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chaseDraftSchema = z
	.object({
		findingIds: z.array(z.string().regex(UUID_RE)).min(1).max(100),
		inspectedOriginal: z.literal(true),
	})
	.strict();

export interface DocumentRouteDeps {
	db: Db;
	config: DocumentsConfig;
	service: DocumentService;
	logger: Logger;
}

/** Metadata only — never page text, nonces, tags, or storage keys. */
export function presentFile(row: DocumentFileRow): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		kind: row.kind,
		status: row.status,
		ocrStatus: row.ocrStatus,
		textLayerRisk: row.textLayerRisk,
		originalFilename: row.originalFilename,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		pageCount: row.pageCount,
		ocrConfidence: row.ocrConfidence,
		uploadedBy: row.uploadedBy,
		uploadedAt: row.uploadedAt.toISOString(),
		retentionUntil: row.retentionUntil.toISOString(),
		errorCode: row.errorCode,
	};
}

function noStore(c: { header: (name: string, value: string) => void }): void {
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
}

export function documentRoutes(deps: DocumentRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, config, service, logger } = deps;

	/** Feature → access → consent gate shared by every document route. */
	const gate = async (c: {
		req: { param: (name: string) => string };
		var: { user: { id: string; role: string } };
	}) => {
		const applicationId = c.req.param("id");
		if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.featureEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		const resolved = await resolveDocumentAccess(db, applicationId, c.var.user);
		if (!resolved) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!resolved.application.documentProcessingConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
		}
		return { applicationId, application: resolved.application };
	};

	const auditViewed = async (
		applicationId: string,
		actor: string,
		payload: Record<string, unknown>,
	): Promise<void> => {
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				applicationId,
				actor,
				action: "document.viewed",
				entity: "document_file",
				payload,
			});
		});
	};

	/** Crosscheck/chase gate: assigned officer only. The applicant owner
	 * is a 403 (they own the case but may never cross-check); everyone
	 * else is a non-leaking 404. Consent follows assignment. */
	const gateOfficer = async (c: {
		req: { param: (name: string) => string };
		var: { user: { id: string; role: string } };
	}) => {
		const applicationId = c.req.param("id");
		if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.featureEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		const resolved = await resolveDocumentAccess(db, applicationId, c.var.user);
		if (!resolved) throw new HttpError(404, "NOT_FOUND", "not found");
		if (resolved.access !== "assigned") {
			throw new HttpError(403, "FORBIDDEN", "assigned officers only");
		}
		if (!resolved.application.documentProcessingConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
		}
		return { applicationId };
	};

	// NOTE: static D2 routes register BEFORE the `:fileId` param routes
	// below — otherwise `crosscheck` matches `:fileId` and 404s.

	// Deterministic cross-check (SPEC §7, D2): synchronous, cites
	// document/page/quote. 200 {crosscheck,findings}; 409 only when no
	// ready document exists (or the lock times out).
	app.post("/api/applications/:id/documents/crosscheck", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gateOfficer(c);
		const result = await runDocumentCrosscheck(db, config, {
			applicationId,
			officerId: me.id,
		});
		noStore(c);
		logger.info({ crosscheckId: (result.crosscheck as { id: string }).id }, "document crosscheck");
		return c.json(result, 200);
	});

	app.get("/api/applications/:id/documents/crosscheck", async (c) => {
		const { applicationId } = await gateOfficer(c);
		const latest = await getLatestCrosscheck(db, applicationId);
		if (!latest) throw new HttpError(404, "NOT_FOUND", "not found");
		noStore(c);
		return c.json(latest);
	});

	// Draft-only chase (SPEC §7, D2): strict body, nested ids validated,
	// server-recorded original-open required. Draft status, sent_at null —
	// there is no send path.
	app.post("/api/applications/:id/documents/crosscheck/:crosscheckId/chase", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gateOfficer(c);
		const crosscheckId = c.req.param("crosscheckId");
		if (!UUID_RE.test(crosscheckId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = chaseDraftSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid chase draft", zodFields(parsed.error));
		}
		const result = await createChaseDraft(db, config, {
			applicationId,
			crosscheckId,
			officerId: me.id,
			findingIds: parsed.data.findingIds,
			inspectedOriginal: true,
		});
		noStore(c);
		logger.info(
			{ chaseRequestId: (result.chase as { id: string }).id, crosscheckId },
			"document chase drafted",
		);
		return c.json(result, 201);
	});

	// Synchronous multipart upload: `file` + `kind` (SPEC §5/§6).
	app.post("/api/applications/:id/documents", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		let body: Record<string, string | File>;
		try {
			body = await c.req.parseBody();
		} catch {
			throw new HttpError(400, "INVALID_MULTIPART", "request must be multipart with file+kind");
		}
		const kind = parseKind(typeof body.kind === "string" ? body.kind : undefined);
		const file = body.file;
		if (!(file instanceof File)) {
			throw new HttpError(400, "MISSING_FILE", "multipart field 'file' is required");
		}
		const bytes = Buffer.from(await file.arrayBuffer());
		const outcome = await service.upload({
			applicationId,
			userId: me.id,
			kind,
			originalFilename: file.name || null,
			bytes,
		});
		noStore(c);
		logger.info({ documentFileId: outcome.file.id, replayed: outcome.replayed }, "document upload");
		return c.json({ file: presentFile(outcome.file) }, outcome.httpStatus as 200 | 201);
	});

	app.get("/api/applications/:id/documents", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const files = await service.listFiles(applicationId);
		await auditViewed(applicationId, me.id, { fileCount: files.length });
		noStore(c);
		return c.json({ files: files.map(presentFile) });
	});

	app.get("/api/applications/:id/documents/:fileId", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!UUID_RE.test(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		const pages = await service.getPages(file.id);
		await auditViewed(applicationId, me.id, { documentFileId: file.id, fileCount: 1 });
		noStore(c);
		return c.json({
			file: presentFile(file),
			pages: pages.map((p) => ({
				pageNumber: p.pageNumber,
				source: p.textSource,
				confidence: p.confidence,
				charCount: [...p.text].length,
			})),
		});
	});

	app.get("/api/applications/:id/documents/:fileId/pages", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!UUID_RE.test(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		if (file.kind === "id") throw new HttpError(409, "NO_TEXT", "id documents carry no page text");
		const pages = await service.getPages(file.id);
		await auditViewed(applicationId, me.id, {
			documentFileId: file.id,
			pageCount: pages.length,
		});
		noStore(c);
		return c.json({
			pages: pages.map((p) => ({
				pageNumber: p.pageNumber,
				text: p.text,
				source: p.textSource,
				confidence: p.confidence,
				charCount: [...p.text].length,
			})),
		});
	});

	app.get("/api/applications/:id/documents/:fileId/file", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!UUID_RE.test(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const file = await service.getFile(applicationId, fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		const bytes = await service.openOriginal(file);
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				applicationId,
				actor: me.id,
				action: "document.original_opened",
				entity: "document_file",
				payload: { documentFileId: file.id, sizeBytes: bytes.length },
			});
		});
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Content-Disposition", contentDispositionFor(file.id, file.mimeType));
		c.header("Content-Length", String(bytes.length));
		return c.body(new Uint8Array(bytes), 200, { "Content-Type": file.mimeType });
	});

	app.post("/api/applications/:id/documents/:fileId/retry-ocr", async (c) => {
		const me = c.var.user;
		const { applicationId } = await gate(c);
		const fileId = c.req.param("fileId");
		if (!UUID_RE.test(fileId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const { file } = await service.retryOcr({ applicationId, fileId, userId: me.id });
		noStore(c);
		logger.info({ documentFileId: file.id }, "document retry-ocr");
		return c.json({ file: presentFile(file) }, 200);
	});

	// Explicit case assignment (SPEC §5/§8): officer-only, idempotent for
	// self. Any other outcome — missing case, another active officer, a
	// revoked self-grant, non-officer caller — is a non-leaking 404. Claim
	// deliberately skips the consent gate (assignment precedes access).
	app.post("/api/applications/:id/documents/claim", async (c) => {
		const me = c.var.user;
		const applicationId = c.req.param("id");
		if (!UUID_RE.test(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.featureEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		if (me.role !== "officer") throw new HttpError(404, "NOT_FOUND", "not found");
		try {
			const { assignment, idempotent } = await claimAssignedOfficer(db, {
				applicationId,
				userId: me.id,
				lockTimeoutMs: config.lockTimeoutMs,
			});
			noStore(c);
			logger.info({ applicationId, idempotent }, "document claim");
			return c.json(
				{
					assignment: {
						applicationId: assignment.applicationId,
						userId: assignment.userId,
						accessRole: assignment.accessRole,
						grantedAt: assignment.grantedAt.toISOString(),
					},
					idempotent,
				},
				200,
			);
		} catch (err) {
			if (err instanceof LockTimeout) {
				throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
			}
			throw err;
		}
	});

	return app;
}
