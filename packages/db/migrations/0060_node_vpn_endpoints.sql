CREATE TABLE "node_vpn_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "node_id" uuid NOT NULL REFERENCES "nodes" ("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "address" text NOT NULL,
  "name" varchar(120) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "probe_status" "service_check_status",
  "probe_checked_at" timestamp with time zone,
  "probe_detail" varchar(300),
  CONSTRAINT "node_vpn_endpoints_ordinal_positive" CHECK ("ordinal" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "node_vpn_endpoints_ordinal_unique" ON "node_vpn_endpoints" ("node_id", "ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "node_vpn_endpoints_address_unique" ON "node_vpn_endpoints" ("node_id", "address");--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "endpoint_id" uuid REFERENCES "node_vpn_endpoints" ("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO "node_vpn_endpoints" ("node_id", "ordinal", "address", "name")
SELECT "id", 1, "public_ip", coalesce(nullif("public_name", ''), left("name", 118) || '-1')
FROM "nodes"
WHERE "public_ip" IS NOT NULL
  AND ("protocol" = 'awg3' OR "capabilities" ->> 'awg3' = 'true');
