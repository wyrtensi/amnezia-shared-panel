CREATE TABLE "node_egress_ips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "node_id" uuid NOT NULL REFERENCES "nodes" ("id") ON DELETE CASCADE,
  "ipv4" text NOT NULL,
  "label" varchar(80),
  "interface_name" varchar(32),
  "gateway_ipv4" text,
  "routing_table_id" integer,
  "dns_primary" text DEFAULT '1.1.1.1' NOT NULL,
  "dns_secondary" text DEFAULT '1.0.0.1',
  "amnezia_dns_dnat" boolean DEFAULT true NOT NULL,
  "enforce_dns_dnat" boolean DEFAULT false NOT NULL,
  "allow_as_entry" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "host_state" text DEFAULT 'pending' NOT NULL,
  "host_detail" varchar(300),
  "observed_subnet_cidr" varchar(32),
  "detected_gateway_ipv4" text,
  "tx_bytes" bigint DEFAULT 0 NOT NULL,
  "tx_packets" bigint DEFAULT 0 NOT NULL,
  "host_observed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "node_egress_ips_routing_table_range" CHECK ("routing_table_id" IS NULL OR "routing_table_id" BETWEEN 200 AND 219),
  CONSTRAINT "node_egress_ips_host_state_valid" CHECK ("host_state" IN ('active', 'pending', 'missing_ip', 'gateway_error', 'daemon_offline', 'disabled'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "node_egress_ips_node_ipv4_unique" ON "node_egress_ips" ("node_id", "ipv4");--> statement-breakpoint
CREATE UNIQUE INDEX "node_egress_ips_node_table_unique" ON "node_egress_ips" ("node_id", "routing_table_id") WHERE "routing_table_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_mode" text DEFAULT 'masquerade' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_mode_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_mode_message" varchar(300);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_mode_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_daemon_version" varchar(64);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_daemon_state" text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_daemon_detail" varchar(300);--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_block_smtp" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_isolate_private" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_default_ip_id" uuid REFERENCES "node_egress_ips" ("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "host_network_report" jsonb;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "egress_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_egress_mode_valid" CHECK ("egress_mode" IN ('masquerade', 'routed'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_egress_mode_state_valid" CHECK ("egress_mode_state" IN ('idle', 'switching', 'failed'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_egress_daemon_state_valid" CHECK ("egress_daemon_state" IN ('unavailable', 'masquerade_ready', 'routed_active', 'conflict', 'degraded'));--> statement-breakpoint
DROP INDEX IF EXISTS "node_vpn_endpoints_address_unique";--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "entry_name" varchar(120);--> statement-breakpoint
UPDATE "node_vpn_endpoints" SET "entry_name" = "name" WHERE "entry_name" IS NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ALTER COLUMN "entry_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ALTER COLUMN "entry_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "custom_name" varchar(120);--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "variant_ordinal" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD CONSTRAINT "node_vpn_endpoints_variant_ordinal_positive" CHECK ("variant_ordinal" > 0);--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "egress_ip_id" uuid REFERENCES "node_egress_ips" ("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "probe_observed_egress_ip" text;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "probe_egress_match" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "node_vpn_endpoints_address_egress_unique" ON "node_vpn_endpoints" ("node_id", "address", "egress_ip_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX "node_vpn_endpoints_address_variant_unique" ON "node_vpn_endpoints" ("node_id", "address", "variant_ordinal");--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "tunnel_ipv4" text;--> statement-breakpoint
UPDATE "vpn_keys" AS "k"
SET "endpoint_id" = "e"."id"
FROM "node_vpn_endpoints" AS "e"
WHERE "k"."endpoint_id" IS NULL
  AND "k"."protocol" = 'awg3'
  AND "e"."node_id" = "k"."node_id"
  AND "e"."ordinal" = 1;--> statement-breakpoint
CREATE TABLE "node_egress_service_check_results" (
  "egress_ip_id" uuid NOT NULL REFERENCES "node_egress_ips" ("id") ON DELETE CASCADE,
  "check_id" uuid NOT NULL REFERENCES "node_service_checks" ("id") ON DELETE CASCADE,
  "status" "service_check_status" NOT NULL,
  "http_status" integer,
  "latency_ms" integer,
  "detail" varchar(300),
  "final_url" varchar(500),
  "checked_at" timestamp with time zone NOT NULL,
  "failing_since" timestamp with time zone,
  PRIMARY KEY ("egress_ip_id", "check_id")
);
