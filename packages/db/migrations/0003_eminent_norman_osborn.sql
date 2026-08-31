ALTER TABLE "nodes" ADD COLUMN "enabled_protocols" jsonb;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "allowed_protocols" jsonb DEFAULT '["awg3"]'::jsonb NOT NULL;