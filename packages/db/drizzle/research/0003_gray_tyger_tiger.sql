CREATE TYPE "public"."agent_requested_by_role" AS ENUM('officer', 'service');--> statement-breakpoint
ALTER TYPE "public"."agent_trigger" ADD VALUE 'auto';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "requested_by_role" "agent_requested_by_role" DEFAULT 'officer' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_event_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "applicant_user_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_trigger_event_uniq" ON "agent_runs" USING btree ("application_id","trigger","trigger_event_id") WHERE "agent_runs"."trigger_event_id" IS NOT NULL;