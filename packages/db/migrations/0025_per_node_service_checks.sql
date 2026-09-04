ALTER TABLE "nodes" ADD COLUMN "checks_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "disabled_check_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;