ALTER TYPE "public"."application_status" ADD VALUE 'draft' BEFORE 'submitted';
--> statement-breakpoint
ALTER TYPE "public"."document_file_kind" ADD VALUE 'payslip' BEFORE 'other';
--> statement-breakpoint
ALTER TYPE "public"."document_file_kind" ADD VALUE 'financial_statements' BEFORE 'other';

COMMIT;
BEGIN;
