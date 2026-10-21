// @credit/db/applications — applications service only (credit_applications):
// applications, kyc_checks, external_reports, documents, scores,
// policy_evaluations, decisions, idempotency_keys, plus the shared
// audit_log/outbox_events. applicant_user_id / officer_user_id are plain
// uuids — no FK to users (cross-database references must never be FKs).
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export { auditLog, outboxEvents } from "./shared.js";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

const updatedAt = () =>
	timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

const money = (name: string) => bigint(name, { mode: "number" }).notNull();
const moneyNullable = (name: string) => bigint(name, { mode: "number" });

export const applicationType = pgEnum("application_type", ["individual", "sme"]);
export const applicationProduct = pgEnum("application_product", ["personal_loan", "sme_term_loan"]);
export const applicationStatus = pgEnum("application_status", [
	"submitted",
	"processing",
	"pending_review",
	"booked",
	"declined",
	"expired",
	"failed",
]);
export const kycCheckStatus = pgEnum("kyc_check_status", ["passed", "failed"]);
export const reportKind = pgEnum("report_kind", ["bureau", "bank"]);
export const documentStatus = pgEnum("document_status", ["required", "verified"]);
export const decisionOutcome = pgEnum("decision_outcome", ["approved", "declined"]);
export const decidedBy = pgEnum("decided_by", ["system", "officer"]);
// T01 document workflow (SPEC-t01-t02 §4). Enum values are append-only:
// v1 uses `assigned_officer` only; specialist roles extend this list later.
export const caseAccessRole = pgEnum("case_access_role", ["assigned_officer"]);
export const documentFileKind = pgEnum("document_file_kind", [
	"id",
	"business_registration",
	"bank_statement",
	"other",
]);
export const documentFileStatus = pgEnum("document_file_status", ["ready", "rejected", "deleted"]);
export const documentOcrStatus = pgEnum("document_ocr_status", [
	"not_applicable",
	"ready",
	"low_confidence",
	"unsupported",
	"failed",
]);
export const documentTextSource = pgEnum("document_text_source", ["pdf_text", "ocr"]);
export const documentCrosscheckStatus = pgEnum("document_crosscheck_status", [
	"succeeded",
	"failed",
	"redacted",
]);
export const documentFindingField = pgEnum("document_finding_field", [
	"company_name",
	"registration_number",
	"account_holder_name",
	"applicant_name",
	"other",
]);
export const documentFindingConfidence = pgEnum("document_finding_confidence", [
	"low",
	"medium",
	"high",
]);
export const documentFindingStatus = pgEnum("document_finding_status", ["mismatch", "needs_chase"]);
export const chaseRequestStatus = pgEnum("chase_request_status", ["draft"]);

export const applications = pgTable(
	"applications",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		reference: text("reference").notNull().unique(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		applicantUserId: uuid("applicant_user_id").notNull(),
		type: applicationType("type").notNull(),
		product: applicationProduct("product").notNull(),
		status: applicationStatus("status").notNull().default("submitted"),
		amountCents: money("amount_cents"),
		termMonths: integer("term_months").notNull(),
		purpose: text("purpose").notNull(),
		identity: jsonb("identity").notNull(),
		financial: jsonb("financial"),
		business: jsonb("business"),
		consents: jsonb("consents").notNull(),
		aiResearchConsent: boolean("ai_research_consent").notNull().default(false),
		documentProcessingConsent: boolean("document_processing_consent").notNull().default(false),
		documentConsentAt: timestamp("document_consent_at", {
			withTimezone: true,
			mode: "date",
		}),
		documentConsentVersion: text("document_consent_version"),
		submittedAt: timestamp("submitted_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		workflowStartedAt: timestamp("workflow_started_at", {
			withTimezone: true,
			mode: "date",
		}),
		decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
		failedReason: text("failed_reason"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("applications_status_idx").on(t.status)],
);

export const kycChecks = pgTable(
	"kyc_checks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		type: text("type").notNull(),
		status: kycCheckStatus("status").notNull(),
		details: jsonb("details"),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("kyc_checks_application_id_type_uniq").on(t.applicationId, t.type)],
);

export const externalReports = pgTable(
	"external_reports",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		provider: text("provider").notNull(),
		kind: reportKind("kind").notNull(),
		version: text("version").notNull(),
		payload: jsonb("payload").notNull(),
		fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("external_reports_application_provider_kind_uniq").on(
			t.applicationId,
			t.provider,
			t.kind,
		),
	],
);

export const documents = pgTable(
	"documents",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		kind: text("kind").notNull(),
		status: documentStatus("status").notNull().default("required"),
		note: text("note"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("documents_application_id_kind_uniq").on(t.applicationId, t.kind)],
);

export const scores = pgTable(
	"scores",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		modelVersion: text("model_version").notNull(),
		score: integer("score").notNull(),
		grade: text("grade").notNull(),
		components: jsonb("components"),
		factors: jsonb("factors").notNull(),
		affordability: jsonb("affordability").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("scores_application_id_model_version_uniq").on(t.applicationId, t.modelVersion),
	],
);

export const policyEvaluations = pgTable(
	"policy_evaluations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		policyVersion: text("policy_version").notNull(),
		outcome: text("outcome").notNull(),
		reasons: jsonb("reasons").notNull(),
		maxAmountCents: money("max_amount_cents"),
		inputs: jsonb("inputs").notNull(),
		inputHash: text("input_hash").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("policy_evaluations_application_id_policy_version_uniq").on(
			t.applicationId,
			t.policyVersion,
		),
	],
);

export const decisions = pgTable("decisions", {
	id: uuid("id").defaultRandom().primaryKey(),
	applicationId: uuid("application_id")
		.notNull()
		.unique()
		.references(() => applications.id, { onDelete: "restrict" }),
	outcome: decisionOutcome("outcome").notNull(),
	decidedBy: decidedBy("decided_by").notNull(),
	// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
	officerUserId: uuid("officer_user_id"),
	// Nullable: system/check-only decisions carry no request id. Postgres
	// treats NULLs as distinct, so the unique constraint only guards
	// officer request ids — exactly the replay semantics FR-6.2 needs.
	requestId: text("request_id").unique(),
	approvedAmountCents: moneyNullable("approved_amount_cents"),
	termMonths: integer("term_months"),
	rateBps: integer("rate_bps"),
	reasons: jsonb("reasons").notNull(),
	notes: text("notes"),
	snapshot: jsonb("snapshot").notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
	createdAt: createdAt(),
});

export const idempotencyKeys = pgTable(
	"idempotency_keys",
	{
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		userId: uuid("user_id").notNull(),
		key: text("key").notNull(),
		requestHash: text("request_hash").notNull(),
		applicationId: uuid("application_id").references(() => applications.id, {
			onDelete: "restrict",
		}),
		response: jsonb("response"),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// --- T01 document workflow (SPEC-t01-t02 §4). D0 wires schema + consent
// only; upload/OCR/crosscheck/chase handlers land in D1/D2. ---

// Explicit case assignment. The applicant owner is implicit (never a row);
// v1 grants `assigned_officer` only. One active officer per application.
export const caseAccessGrants = pgTable(
	"case_access_grants",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		userId: uuid("user_id").notNull(),
		accessRole: caseAccessRole("access_role").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		grantedBy: uuid("granted_by"),
		grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("case_access_grants_application_id_idx").on(t.applicationId),
		uniqueIndex("case_access_grants_active_officer_uniq")
			.on(t.applicationId)
			.where(sql`${t.accessRole} = 'assigned_officer' AND ${t.revokedAt} IS NULL`),
	],
);

// One row per uploaded file; terminal metadata only, never page text.
// `rejected` rows hold no blob (scan/validation failure); there is no
// `failed` file status — storage/DB finalization failures leave no row.
export const documentFiles = pgTable(
	"document_files",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		kind: documentFileKind("kind").notNull(),
		status: documentFileStatus("status").notNull(),
		ocrStatus: documentOcrStatus("ocr_status").notNull(),
		textLayerRisk: boolean("text_layer_risk").notNull().default(false),
		originalFilename: text("original_filename"),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: text("sha256").notNull(),
		storageKey: text("storage_key"),
		encryptionNonce: text("encryption_nonce"),
		encryptionTag: text("encryption_tag"),
		keyId: text("key_id").notNull(),
		cryptoVersion: text("crypto_version").notNull(),
		pageCount: integer("page_count").notNull().default(0),
		ocrConfidence: real("ocr_confidence"),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		uploadedBy: uuid("uploaded_by").notNull(),
		uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		retentionUntil: timestamp("retention_until", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		blobPurgedAt: timestamp("blob_purged_at", { withTimezone: true, mode: "date" }),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("document_files_application_id_idx").on(t.applicationId),
		// Same bytes + kind dedupe: re-upload replays the existing row
		// instead of storing a second blob. Deleted rows don't collide.
		// (No CAST in the predicate: enum::text is not immutable, and PG
		// rejects it in index predicates — compare the enum directly.)
		uniqueIndex("document_files_application_kind_sha_uniq")
			.on(t.applicationId, t.kind, t.sha256)
			.where(sql`${t.status} != 'deleted'`),
	],
);

// Extracted page text with confidence and provenance. `id`-kind files
// store no pages (encrypted bytes only).
export const documentPages = pgTable(
	"document_pages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		documentFileId: uuid("document_file_id")
			.notNull()
			.references(() => documentFiles.id, { onDelete: "cascade" }),
		pageNumber: integer("page_number").notNull(),
		text: text("text").notNull(),
		textSource: documentTextSource("text_source").notNull(),
		confidence: real("confidence").notNull(),
		textSha256: text("text_sha256").notNull(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex("document_pages_file_page_uniq").on(t.documentFileId, t.pageNumber)],
);

// One deterministic cross-check run over an application's ready documents.
export const documentCrosschecks = pgTable(
	"document_crosschecks",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		status: documentCrosscheckStatus("status").notNull(),
		validatorVersion: text("validator_version").notNull(),
		documentsChecked: jsonb("documents_checked").notNull(),
		findingCount: integer("finding_count").notNull().default(0),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		requestedBy: uuid("requested_by").notNull(),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		errorCode: text("error_code"),
	},
	(t) => [index("document_crosschecks_application_id_idx").on(t.applicationId)],
);

// A single field comparison outcome. `mismatch` must cite an exact raw-page
// substring (file/page/quote/offsets/hash); `needs_chase` may cite nothing.
// Code-point offsets into raw `document_pages.text` — enforced here at the
// row level (presence) and in the service transaction (exactness).
export const documentFindings = pgTable(
	"document_findings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		crosscheckId: uuid("crosscheck_id")
			.notNull()
			.references(() => documentCrosschecks.id, { onDelete: "cascade" }),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		documentFileId: uuid("document_file_id").references(() => documentFiles.id, {
			onDelete: "restrict",
		}),
		field: documentFindingField("field").notNull(),
		expected: text("expected"),
		observed: text("observed"),
		pageNumber: integer("page_number"),
		quote: text("quote"),
		quoteStart: integer("quote_start"),
		quoteEnd: integer("quote_end"),
		quoteHash: text("quote_hash"),
		confidence: documentFindingConfidence("confidence").notNull(),
		status: documentFindingStatus("status").notNull(),
		reason: text("reason").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		index("document_findings_crosscheck_id_idx").on(t.crosscheckId),
		index("document_findings_application_id_idx").on(t.applicationId),
		check(
			"document_findings_mismatch_citation_chk",
			sql`CAST(${t.status} AS text) != 'mismatch' OR (${t.documentFileId} IS NOT NULL AND ${t.pageNumber} IS NOT NULL AND ${t.quote} IS NOT NULL AND ${t.quoteStart} IS NOT NULL AND ${t.quoteEnd} IS NOT NULL AND ${t.quoteHash} IS NOT NULL)`,
		),
	],
);

// Draft-only chase request (v1 never sends). `sent_at` stays null.
export const chaseRequests = pgTable(
	"chase_requests",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		crosscheckId: uuid("crosscheck_id")
			.notNull()
			.references(() => documentCrosschecks.id, { onDelete: "restrict" }),
		status: chaseRequestStatus("status").notNull().default("draft"),
		body: text("body"),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
		inspectedOriginalAt: timestamp("inspected_original_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [index("chase_requests_application_id_idx").on(t.applicationId)],
);

// The draft's selected findings; both sides cascade so retention can clear
// links without touching the crosscheck row itself.
export const chaseRequestFindings = pgTable(
	"chase_request_findings",
	{
		chaseRequestId: uuid("chase_request_id")
			.notNull()
			.references(() => chaseRequests.id, { onDelete: "cascade" }),
		findingId: uuid("finding_id")
			.notNull()
			.references(() => documentFindings.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.chaseRequestId, t.findingId] })],
);

// Retention blockers, application-wide (file null) or per file. An active
// hold (`released_at IS NULL`) blocks the retention sweep transactionally.
export const documentLegalHolds = pgTable(
	"document_legal_holds",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "restrict" }),
		documentFileId: uuid("document_file_id").references(() => documentFiles.id, {
			onDelete: "restrict",
		}),
		reason: text("reason").notNull(),
		// Cross-DB reference to credit_auth.users — plain uuid, never an FK.
		createdBy: uuid("created_by").notNull(),
		createdAt: createdAt(),
		releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("document_legal_holds_application_id_idx").on(t.applicationId),
		index("document_legal_holds_active_idx")
			.on(t.applicationId)
			.where(sql`${t.releasedAt} IS NULL`),
	],
);
