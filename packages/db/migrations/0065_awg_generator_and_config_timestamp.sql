ALTER TABLE "nodes" ADD COLUMN "awg_generator" jsonb;
--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "awg_generator" jsonb;
--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "config_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "config_export_hashes" jsonb NOT NULL DEFAULT '{}'::jsonb;
