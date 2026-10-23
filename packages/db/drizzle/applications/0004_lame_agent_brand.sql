CREATE TYPE "public"."application_source" AS ENUM('live', 'demo_case');--> statement-breakpoint
CREATE TYPE "public"."customer_account_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."customer_account_type" AS ENUM('personal_current', 'business_current', 'savings');--> statement-breakpoint
CREATE TYPE "public"."customer_document_scan_status" AS ENUM('clean', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."customer_kyc_status" AS ENUM('verified', 'expired', 'not_started');--> statement-breakpoint
CREATE TYPE "public"."customer_segment" AS ENUM('individual', 'sme');--> statement-breakpoint
CREATE TYPE "public"."customer_source" AS ENUM('demo_seed', 'customer_master');--> statement-breakpoint
CREATE TYPE "public"."customer_transaction_category" AS ENUM('income', 'transfer', 'payroll', 'loan', 'fee', 'purchase', 'cash', 'returned_payment', 'other');--> statement-breakpoint
CREATE TYPE "public"."customer_transaction_source" AS ENUM('demo_seed', 'statement', 'feed');--> statement-breakpoint
CREATE TYPE "public"."document_date_source" AS ENUM('statement_import', 'server_ocr', 'reused', 'customer_kyc');--> statement-breakpoint
CREATE TYPE "public"."document_file_source" AS ENUM('upload', 'customer_reuse', 'demo_seed');--> statement-breakpoint
CREATE TABLE "application_profile_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value_hash" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"account_type" "customer_account_type" NOT NULL,
	"masked_number" text NOT NULL,
	"currency" text NOT NULL,
	"opened_at" date,
	"status" "customer_account_status" NOT NULL,
	"source" "customer_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"text_source" "document_text_source" NOT NULL,
	"confidence" real NOT NULL,
	"text_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"fixture_key" text,
	"kind" "document_file_kind" NOT NULL,
	"status" "document_file_status" NOT NULL,
	"scan_status" "customer_document_scan_status" NOT NULL,
	"scanned_at" timestamp with time zone,
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
	"ocr_status" "document_ocr_status" NOT NULL,
	"ocr_confidence" real,
	"text_layer_risk" boolean DEFAULT false NOT NULL,
	"document_date" date,
	"period_end" date,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"blob_purged_at" timestamp with time zone,
	"source" "customer_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_document_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"segment" "customer_segment" NOT NULL,
	"customer_since" date NOT NULL,
	"kyc_status" "customer_kyc_status" NOT NULL,
	"kyc_verified_at" timestamp with time zone,
	"kyc_expires_at" timestamp with time zone,
	"identity" jsonb NOT NULL,
	"business" jsonb,
	"source" "customer_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "customer_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"counterparty" text,
	"category" "customer_transaction_category" NOT NULL,
	"returned" boolean DEFAULT false NOT NULL,
	"source" "customer_transaction_source" NOT NULL,
	"source_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "document_files_application_kind_sha_uniq";--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "submitted_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "submitted_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "source" "application_source" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "fixture_key" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "context_analysis_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "context_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "context_consent_version" text;--> statement-breakpoint
ALTER TABLE "document_files" ADD COLUMN "source" "document_file_source" DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_files" ADD COLUMN "reused_from_customer_document_id" uuid;--> statement-breakpoint
ALTER TABLE "document_files" ADD COLUMN "document_date" date;--> statement-breakpoint
ALTER TABLE "document_files" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "document_files" ADD COLUMN "document_date_source" "document_date_source";--> statement-breakpoint
ALTER TABLE "application_profile_confirmations" ADD CONSTRAINT "application_profile_confirmations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_profile_confirmations" ADD CONSTRAINT "application_profile_confirmations_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customer_id_customer_profiles_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_document_pages" ADD CONSTRAINT "customer_document_pages_customer_document_id_customer_documents_id_fk" FOREIGN KEY ("customer_document_id") REFERENCES "public"."customer_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_customer_profiles_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legal_holds" ADD CONSTRAINT "customer_legal_holds_customer_id_customer_profiles_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legal_holds" ADD CONSTRAINT "customer_legal_holds_customer_document_id_customer_documents_id_fk" FOREIGN KEY ("customer_document_id") REFERENCES "public"."customer_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_account_id_customer_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_profile_confirmations_app_field_uniq" ON "application_profile_confirmations" USING btree ("application_id","field");--> statement-breakpoint
CREATE INDEX "customer_accounts_customer_status_idx" ON "customer_accounts" USING btree ("customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_document_pages_file_page_uniq" ON "customer_document_pages" USING btree ("customer_document_id","page_number");--> statement-breakpoint
CREATE INDEX "customer_documents_customer_id_idx" ON "customer_documents" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_documents_customer_kind_fixture_uniq" ON "customer_documents" USING btree ("customer_id","kind","fixture_key") WHERE "customer_documents"."fixture_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_legal_holds_customer_id_idx" ON "customer_legal_holds" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_legal_holds_active_idx" ON "customer_legal_holds" USING btree ("customer_id") WHERE "customer_legal_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customer_transactions_account_posted_idx" ON "customer_transactions" USING btree ("account_id","posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_transactions_account_source_ref_uniq" ON "customer_transactions" USING btree ("account_id","source","source_reference") WHERE "customer_transactions"."source_reference" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_reused_from_customer_document_id_customer_documents_id_fk" FOREIGN KEY ("reused_from_customer_document_id") REFERENCES "public"."customer_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_files_application_kind_sha_uniq" ON "document_files" USING btree ("application_id","kind","sha256") WHERE "document_files"."status" != 'deleted';--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_fixture_key_unique" UNIQUE("fixture_key");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_draft_submitted_chk" CHECK (("applications"."status" = 'draft') = ("applications"."submitted_at" IS NULL));
