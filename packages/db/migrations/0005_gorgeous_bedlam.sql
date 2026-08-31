ALTER TABLE "portal_policy" ADD COLUMN "allow_custom_routes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "custom_routes" jsonb;