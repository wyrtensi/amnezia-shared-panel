-- Every address keeps its own reachability incident now, mass ones included,
-- so its kind is stored next to `probe_alerted_at` like a node's.
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "probe_alert_kind" "reachability_alert_kind";
