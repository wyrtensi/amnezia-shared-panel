ALTER TABLE "node_vpn_endpoints"
  ADD COLUMN "bridge_mode" text DEFAULT 'inherit' NOT NULL,
  ADD CONSTRAINT "node_vpn_endpoints_bridge_mode_valid"
    CHECK ("bridge_mode" IN ('inherit', 'direct', 'bridge'));
