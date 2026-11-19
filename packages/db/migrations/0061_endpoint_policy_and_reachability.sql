ALTER TABLE "portal_policy"
  ADD COLUMN IF NOT EXISTS "allowed_endpoint_ids" jsonb,
  ADD COLUMN IF NOT EXISTS "endpoint_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "recommended_endpoint_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints"
  ADD COLUMN IF NOT EXISTS "reachability_enabled" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "probe_levels" jsonb,
  ADD COLUMN IF NOT EXISTS "probe_consecutive_failures" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "probe_failing_since" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "probe_alerted_at" timestamp with time zone;
