-- Set by each run when it judged the node by its addresses, so the status
-- widget keeps one row per address while they wait for their next check.
ALTER TABLE "node_reachability_state" ADD COLUMN "address_based" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Until the first run after the upgrade, the widget's old rule: a node whose
-- checked addresses already carry a verdict.
UPDATE "node_reachability_state" AS "state" SET "address_based" = true
WHERE EXISTS (
  SELECT 1 FROM "node_vpn_endpoints" AS "endpoint"
  WHERE "endpoint"."node_id" = "state"."node_id"
    AND "endpoint"."enabled" AND "endpoint"."reachability_enabled"
    AND "endpoint"."probe_status" IS NOT NULL
);
