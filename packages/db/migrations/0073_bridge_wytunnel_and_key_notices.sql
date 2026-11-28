ALTER TABLE "vpn_bridges" ADD COLUMN "default_transport" text DEFAULT 'frp_tcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "frps_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD CONSTRAINT "vpn_bridges_default_transport_valid" CHECK ("default_transport" IN ('frp_tcp', 'wytunnel'));--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD COLUMN "transport" text DEFAULT 'frp_tcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD COLUMN "transport_port" integer;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD COLUMN "transport_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD COLUMN "observed_telemetry" jsonb;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD CONSTRAINT "vpn_bridge_routes_transport_valid" CHECK ("transport" IN ('frp_tcp', 'wytunnel'));--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD CONSTRAINT "vpn_bridge_routes_transport_port_range" CHECK ("transport_port" IS NULL OR "transport_port" BETWEEN 1 AND 65535);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "key_update_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "key_update_notify_note" text;--> statement-breakpoint
ALTER TABLE "node_egress_ips" ADD COLUMN "key_update_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node_egress_ips" ADD COLUMN "key_update_notify_note" text;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "key_update_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "key_update_notify_note" text;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "enabled_protocols" jsonb;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "config_delivered_at" timestamp with time zone;
