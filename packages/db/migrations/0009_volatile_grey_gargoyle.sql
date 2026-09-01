CREATE TABLE "global_route_overrides" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"payload" jsonb DEFAULT '{"ru_whitelist":{"add":{"cidrs":[],"domains":[]},"exclude":{"cidrs":[],"domains":[]}},"ru_blacklist":{"add":{"cidrs":[],"domains":[]},"exclude":{"cidrs":[],"domains":[]}}}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_route_overrides_singleton" CHECK ("global_route_overrides"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "portal_policy" ALTER COLUMN "allow_route_profile_selection" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "portal_policy" ALTER COLUMN "allow_custom_routes" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "name_show_node" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "name_show_label" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "name_show_number" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Keys issued before this migration were always named "<server> #<number>".
-- Pin their existing name so a redownload does not silently rename them; only
-- keys created from now on get the new "<server> <label>" default.
UPDATE "vpn_keys"
SET "name_show_node" = true,
    "name_show_label" = false,
    "name_show_number" = true;--> statement-breakpoint
-- The bundled starter rule lists are gone; drop the rows they created so no
-- deployment keeps serving a six-CIDR "base list" as an active route feed.
DELETE FROM "route_rule_versions" WHERE "source_url" = 'bundled://seed';--> statement-breakpoint
-- Materialize both singletons so a fresh install has real rows carrying the
-- column defaults instead of relying on the API's in-memory fallback.
INSERT INTO "portal_policy" ("id") VALUES (true) ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "global_route_overrides" ("id") VALUES (true) ON CONFLICT DO NOTHING;
