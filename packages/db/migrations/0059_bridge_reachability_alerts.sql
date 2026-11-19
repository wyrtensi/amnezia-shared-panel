ALTER TABLE "vpn_bridges"
  ADD COLUMN "reachability_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes"
  ADD COLUMN "alert_consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN "alert_failing_since" timestamp with time zone,
  ADD COLUMN "alerted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "reachability_probe"
  ADD COLUMN "probe_direct_when_bridged" boolean NOT NULL DEFAULT false,
  ADD COLUMN "stealth_mode" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "node_reachability_state"
  ADD COLUMN "direct_status" "service_check_status",
  ADD COLUMN "direct_checked_at" timestamp with time zone,
  ADD COLUMN "direct_detail" varchar(300);
--> statement-breakpoint
CREATE TABLE "bridge_reachability_state" (
  "bridge_id" uuid PRIMARY KEY REFERENCES "vpn_bridges" ("id") ON DELETE CASCADE,
  "mgmt_status" "service_check_status",
  "mgmt_consecutive_failures" integer NOT NULL DEFAULT 0,
  "mgmt_failing_since" timestamp with time zone,
  "mgmt_alerted_at" timestamp with time zone,
  "mgmt_alert_detail" varchar(300),
  "probe_status" "service_check_status",
  "probe_levels" jsonb,
  "probe_checked_at" timestamp with time zone,
  "probe_consecutive_failures" integer NOT NULL DEFAULT 0,
  "probe_failing_since" timestamp with time zone,
  "probe_alerted_at" timestamp with time zone,
  "probe_detail" varchar(300)
);
