CREATE TYPE "public"."agent_error_code" AS ENUM('model_unavailable', 'tool_error', 'timeout', 'validation_failed', 'config_error', 'internal_error', 'case_facts_incomplete');--> statement-breakpoint
CREATE TYPE "public"."agent_observability" AS ENUM('ok', 'degraded');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_trigger" AS ENUM('officer');--> statement-breakpoint
CREATE TYPE "public"."evidence_date_basis" AS ENUM('publisher_metadata', 'tavily_estimate', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."evidence_source_tier" AS ENUM('official', 'registry', 'reputable_news', 'review_platform', 'other');--> statement-breakpoint
CREATE TYPE "public"."finding_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."finding_review_action" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."finding_support" AS ENUM('verified', 'unverified');--> statement-breakpoint
CREATE TABLE "agent_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"title" text,
	"publisher" text NOT NULL,
	"published_at" date,
	"date_basis" "evidence_date_basis" DEFAULT 'unknown' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"snapshot_text" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"raw_content_sha256" text,
	"source_tier" "evidence_source_tier" DEFAULT 'other' NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "agent_finding_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"officer_id" uuid NOT NULL,
	"action" "finding_review_action" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"category" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"allegation_status" text NOT NULL,
	"support" "finding_support" DEFAULT 'unverified' NOT NULL,
	"confidence" "finding_confidence" DEFAULT 'low' NOT NULL,
	"confidence_basis" jsonb NOT NULL,
	"entity_match" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"officer_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"trigger" "agent_trigger" DEFAULT 'officer' NOT NULL,
	"requested_by" uuid NOT NULL,
	"run_token" uuid,
	"case_facts" jsonb NOT NULL,
	"model" text NOT NULL,
	"agent_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"grafana_conversation_id" text NOT NULL,
	"observability" "agent_observability" DEFAULT 'degraded' NOT NULL,
	"brief" jsonb,
	"validation" jsonb,
	"error_code" "agent_error_code",
	"error" text,
	"usage" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"timeout_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"finding_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	CONSTRAINT "finding_evidence_finding_id_evidence_id_pk" PRIMARY KEY("finding_id","evidence_id")
);
--> statement-breakpoint
ALTER TABLE "agent_evidence" ADD CONSTRAINT "agent_evidence_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_finding_reviews" ADD CONSTRAINT "agent_finding_reviews_finding_id_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_finding_reviews" ADD CONSTRAINT "agent_finding_reviews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_views" ADD CONSTRAINT "agent_run_views_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_evidence_id_agent_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."agent_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evidence_run_url_hash_uniq" ON "agent_evidence" USING btree ("run_id","final_url","snapshot_hash");--> statement-breakpoint
CREATE INDEX "agent_evidence_run_idx" ON "agent_evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_finding_reviews_finding_idx" ON "agent_finding_reviews" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_findings_run_idx" ON "agent_findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_run_views_run_officer_idx" ON "agent_run_views" USING btree ("run_id","officer_id","viewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_application_uniq" ON "agent_runs" USING btree ("application_id","feature") WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_application_created_idx" ON "agent_runs" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_timeout_idx" ON "agent_runs" USING btree ("status","timeout_at");