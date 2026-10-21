CREATE TABLE "research_auto_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"trigger_event_id" text NOT NULL,
	"outcome" text NOT NULL,
	"run_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_auto_events_application_event_uniq" ON "research_auto_events" USING btree ("application_id","trigger_event_id");--> statement-breakpoint
CREATE INDEX "research_auto_events_application_idx" ON "research_auto_events" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "agent_runs_auto_caps_idx" ON "agent_runs" USING btree ("trigger","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_applicant_created_idx" ON "agent_runs" USING btree ("applicant_user_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "research_audit_log_no_modify"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'research_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "research_audit_log_no_modify" BEFORE UPDATE OR DELETE ON "research_audit_log" FOR EACH ROW EXECUTE FUNCTION "research_audit_log_no_modify"();