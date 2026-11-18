ALTER TABLE "reachability_probe" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "capabilities_checked_at" timestamp with time zone;