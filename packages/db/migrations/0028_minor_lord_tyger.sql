ALTER TABLE "portal_policy" ADD COLUMN "cf_access_allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_access_synced_domains" jsonb;
