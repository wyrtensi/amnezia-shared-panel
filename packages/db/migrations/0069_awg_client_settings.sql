-- AWG 3.1 client settings at every level: the client MTU on its own (null
-- inherits), a profile and an MTU per user and per key, and per-device-type
-- rules on each address. Only administrators set them.
ALTER TABLE "nodes" ADD COLUMN "awg_mtu" integer;
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_awg_mtu_range" CHECK ("awg_mtu" BETWEEN 1280 AND 1420);
--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "awg_mtu" integer;
--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD CONSTRAINT "node_vpn_endpoints_awg_mtu_range" CHECK ("awg_mtu" BETWEEN 1280 AND 1420);
--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "awg_device_rules" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "awg_generator" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "awg_mtu" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_awg_mtu_range" CHECK ("awg_mtu" BETWEEN 1280 AND 1420);
--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "awg_generator" jsonb;
--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "awg_mtu" integer;
--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_awg_mtu_range" CHECK ("awg_mtu" BETWEEN 1280 AND 1420);
--> statement-breakpoint
-- Every node and address with a saved profile keeps the MTU it exports today
-- as its own MTU, so an address with its own profile does not start taking
-- its node's MTU.
UPDATE "nodes" SET "awg_mtu" = coalesce(("awg_generator"->>'mtu')::integer, 1280)
WHERE "awg_generator" IS NOT NULL;
--> statement-breakpoint
UPDATE "node_vpn_endpoints" SET "awg_mtu" = coalesce(("awg_generator"->>'mtu')::integer, 1280)
WHERE "awg_generator" IS NOT NULL;
