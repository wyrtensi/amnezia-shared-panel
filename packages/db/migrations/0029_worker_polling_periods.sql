ALTER TABLE "portal_policy" ADD COLUMN "telemetry_poll_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "node_metrics_sample_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "node_metrics_retention_days" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "peer_sample_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "maintenance_interval_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "agent_release_refresh_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "rule_fetch_interval_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "access_reconcile_sec" integer;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_telemetry_poll_range" CHECK ("portal_policy"."telemetry_poll_sec" IS NULL OR ("portal_policy"."telemetry_poll_sec" >= 30 AND "portal_policy"."telemetry_poll_sec" <= 86400));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_node_metrics_sample_range" CHECK ("portal_policy"."node_metrics_sample_sec" IS NULL OR ("portal_policy"."node_metrics_sample_sec" >= 30 AND "portal_policy"."node_metrics_sample_sec" <= 86400));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_node_metrics_retention_range" CHECK ("portal_policy"."node_metrics_retention_days" IS NULL OR ("portal_policy"."node_metrics_retention_days" >= 1 AND "portal_policy"."node_metrics_retention_days" <= 3650));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_peer_sample_range" CHECK ("portal_policy"."peer_sample_sec" IS NULL OR ("portal_policy"."peer_sample_sec" >= 60 AND "portal_policy"."peer_sample_sec" <= 86400));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_maintenance_interval_range" CHECK ("portal_policy"."maintenance_interval_sec" IS NULL OR ("portal_policy"."maintenance_interval_sec" >= 300 AND "portal_policy"."maintenance_interval_sec" <= 604800));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_agent_release_refresh_range" CHECK ("portal_policy"."agent_release_refresh_sec" IS NULL OR ("portal_policy"."agent_release_refresh_sec" >= 300 AND "portal_policy"."agent_release_refresh_sec" <= 604800));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_rule_fetch_interval_range" CHECK ("portal_policy"."rule_fetch_interval_sec" IS NULL OR ("portal_policy"."rule_fetch_interval_sec" >= 900 AND "portal_policy"."rule_fetch_interval_sec" <= 604800));--> statement-breakpoint
ALTER TABLE "portal_policy" ADD CONSTRAINT "portal_policy_access_reconcile_range" CHECK ("portal_policy"."access_reconcile_sec" IS NULL OR ("portal_policy"."access_reconcile_sec" >= 300 AND "portal_policy"."access_reconcile_sec" <= 604800));