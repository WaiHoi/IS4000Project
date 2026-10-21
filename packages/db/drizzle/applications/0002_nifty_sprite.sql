CREATE TYPE "public"."case_access_role" AS ENUM('assigned_officer');--> statement-breakpoint
CREATE TYPE "public"."chase_request_status" AS ENUM('draft');--> statement-breakpoint
CREATE TYPE "public"."document_crosscheck_status" AS ENUM('succeeded', 'failed', 'redacted');--> statement-breakpoint
CREATE TYPE "public"."document_file_kind" AS ENUM('id', 'business_registration', 'bank_statement', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_file_status" AS ENUM('ready', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."document_finding_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."document_finding_field" AS ENUM('company_name', 'registration_number', 'account_holder_name', 'applicant_name', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_finding_status" AS ENUM('mismatch', 'needs_chase');--> statement-breakpoint
CREATE TYPE "public"."document_ocr_status" AS ENUM('not_applicable', 'ready', 'low_confidence', 'unsupported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_text_source" AS ENUM('pdf_text', 'ocr');--> statement-breakpoint
CREATE TABLE "case_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_role" "case_access_role" NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chase_request_findings" (
	"chase_request_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	CONSTRAINT "chase_request_findings_chase_request_id_finding_id_pk" PRIMARY KEY("chase_request_id","finding_id")
);
--> statement-breakpoint
CREATE TABLE "chase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"crosscheck_id" uuid NOT NULL,
	"status" "chase_request_status" DEFAULT 'draft' NOT NULL,
	"body" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"inspected_original_at" timestamp with time zone NOT NULL,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_crosschecks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"status" "document_crosscheck_status" NOT NULL,
	"validator_version" text NOT NULL,
	"documents_checked" jsonb NOT NULL,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "document_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "document_file_kind" NOT NULL,
	"status" "document_file_status" NOT NULL,
	"ocr_status" "document_ocr_status" NOT NULL,
	"text_layer_risk" boolean DEFAULT false NOT NULL,
	"original_filename" text,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text,
	"encryption_nonce" text,
	"encryption_tag" text,
	"key_id" text NOT NULL,
	"crypto_version" text NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"ocr_confidence" real,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"blob_purged_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crosscheck_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"document_file_id" uuid,
	"field" "document_finding_field" NOT NULL,
	"expected" text,
	"observed" text,
	"page_number" integer,
	"quote" text,
	"quote_start" integer,
	"quote_end" integer,
	"quote_hash" text,
	"confidence" "document_finding_confidence" NOT NULL,
	"status" "document_finding_status" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_findings_mismatch_citation_chk" CHECK (CAST("document_findings"."status" AS text) != 'mismatch' OR ("document_findings"."document_file_id" IS NOT NULL AND "document_findings"."page_number" IS NOT NULL AND "document_findings"."quote" IS NOT NULL AND "document_findings"."quote_start" IS NOT NULL AND "document_findings"."quote_end" IS NOT NULL AND "document_findings"."quote_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_file_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_file_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"text_source" "document_text_source" NOT NULL,
	"confidence" real NOT NULL,
	"text_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "document_processing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "document_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "document_consent_version" text;--> statement-breakpoint
ALTER TABLE "case_access_grants" ADD CONSTRAINT "case_access_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chase_request_findings" ADD CONSTRAINT "chase_request_findings_chase_request_id_chase_requests_id_fk" FOREIGN KEY ("chase_request_id") REFERENCES "public"."chase_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chase_request_findings" ADD CONSTRAINT "chase_request_findings_finding_id_document_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."document_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chase_requests" ADD CONSTRAINT "chase_requests_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chase_requests" ADD CONSTRAINT "chase_requests_crosscheck_id_document_crosschecks_id_fk" FOREIGN KEY ("crosscheck_id") REFERENCES "public"."document_crosschecks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_crosschecks" ADD CONSTRAINT "document_crosschecks_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_findings" ADD CONSTRAINT "document_findings_crosscheck_id_document_crosschecks_id_fk" FOREIGN KEY ("crosscheck_id") REFERENCES "public"."document_crosschecks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_findings" ADD CONSTRAINT "document_findings_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_findings" ADD CONSTRAINT "document_findings_document_file_id_document_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_legal_holds" ADD CONSTRAINT "document_legal_holds_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_legal_holds" ADD CONSTRAINT "document_legal_holds_document_file_id_document_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_file_id_document_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."document_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_access_grants_application_id_idx" ON "case_access_grants" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_access_grants_active_officer_uniq" ON "case_access_grants" USING btree ("application_id") WHERE "case_access_grants"."access_role" = 'assigned_officer' AND "case_access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chase_requests_application_id_idx" ON "chase_requests" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_crosschecks_application_id_idx" ON "document_crosschecks" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_files_application_id_idx" ON "document_files" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_files_application_kind_sha_uniq" ON "document_files" USING btree ("application_id","kind","sha256") WHERE "document_files"."status" != 'deleted';--> statement-breakpoint
CREATE INDEX "document_findings_crosscheck_id_idx" ON "document_findings" USING btree ("crosscheck_id");--> statement-breakpoint
CREATE INDEX "document_findings_application_id_idx" ON "document_findings" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_legal_holds_application_id_idx" ON "document_legal_holds" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_legal_holds_active_idx" ON "document_legal_holds" USING btree ("application_id") WHERE "document_legal_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_pages_file_page_uniq" ON "document_pages" USING btree ("document_file_id","page_number");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_log_mutation"();