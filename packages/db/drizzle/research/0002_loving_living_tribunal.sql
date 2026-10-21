CREATE TYPE "public"."research_access_role" AS ENUM('assigned_officer', 'compliance', 'policy_owner', 'safeguarding');--> statement-breakpoint
CREATE TABLE "research_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_role" "research_access_role" NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"run_id" uuid,
	"actor_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_access_grants_active_application_user_uniq" ON "research_access_grants" USING btree ("application_id","user_id") WHERE "research_access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "research_access_grants_application_idx" ON "research_access_grants" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "research_audit_log_application_time_idx" ON "research_audit_log" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "research_audit_log_run_idx" ON "research_audit_log" USING btree ("run_id");