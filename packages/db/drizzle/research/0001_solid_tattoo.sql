ALTER TABLE "agent_run_views" ADD COLUMN "viewed_minute" timestamp with time zone;--> statement-breakpoint
UPDATE "agent_run_views" SET "viewed_minute" = date_trunc('minute', "viewed_at");--> statement-breakpoint
ALTER TABLE "agent_run_views" ALTER COLUMN "viewed_minute" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_views_run_officer_minute_uniq" ON "agent_run_views" USING btree ("run_id","officer_id","viewed_minute");
