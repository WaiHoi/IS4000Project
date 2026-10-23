CREATE TYPE "public"."context_signal_status" AS ENUM('review', 'needs_chase', 'insufficient_data');--> statement-breakpoint
CREATE TYPE "public"."context_status" AS ENUM('not_applicable', 'queued', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "context_signal_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"signal_snapshot" jsonb NOT NULL,
	"officer_id" uuid NOT NULL,
	"action" "finding_review_action" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage_version" integer DEFAULT 1 NOT NULL,
	"account_id" uuid,
	"account_scope" text NOT NULL,
	"type" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"metric" text NOT NULL,
	"observed" text,
	"expected" text,
	"confidence" "finding_confidence" DEFAULT 'low' NOT NULL,
	"status" "context_signal_status" NOT NULL,
	"policy_version" text NOT NULL,
	"explanation" text,
	"evidence" jsonb NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_signals_account_scope_chk" CHECK (("context_signals"."account_id" IS NULL AND "context_signals"."account_scope" = 'all') OR ("context_signals"."account_id" IS NOT NULL AND "context_signals"."account_scope" = CAST("context_signals"."account_id" AS text)))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_status" "context_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_brief" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_validation" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_usage" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_error_code" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_timeout_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_prompt_version" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_stage_token" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_stage_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_signal_reviews" ADD CONSTRAINT "context_signal_reviews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_signals" ADD CONSTRAINT "context_signals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_signal_reviews_signal_idx" ON "context_signal_reviews" USING btree ("signal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "context_signals_run_stage_scope_type_period_metric_uniq" ON "context_signals" USING btree ("run_id","stage_version","account_scope","type","period_start","period_end","metric");--> statement-breakpoint
CREATE INDEX "context_signals_run_idx" ON "context_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_context_status_timeout_idx" ON "agent_runs" USING btree ("context_status","context_timeout_at");