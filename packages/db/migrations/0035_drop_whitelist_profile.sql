-- Remove the unconfirmed ru_whitelist route profile from the repository
-- entirely. Only full_tunnel and ru_blacklist remain.
--
-- This migration must NEVER delete a vpn_keys row: a key row is what lets
-- reconcile and a revoke find the peer on its node. Deleting the row while a
-- peer still exists on a node would strand that peer forever, with nothing in
-- the panel pointing at it. So step 1 below does not delete anything — it
-- refuses to proceed while any key still uses the profile, and the operator's
-- job is to revoke those keys through the panel first (which removes the
-- peers from the nodes properly) before this migration is allowed to run.

-- 1. Refuse if any vpn_keys row still uses the profile being removed.
DO $$
DECLARE stuck bigint;
BEGIN
  SELECT count(*) INTO stuck FROM "vpn_keys" WHERE "route_profile" = 'ru_whitelist';
  IF stuck > 0 THEN
    RAISE EXCEPTION 'ru_whitelist is being removed but % vpn_keys still use it. Revoke those keys through the panel first so their peers are removed from the nodes; deleting the rows here would strand the peers.', stuck;
  END IF;
END $$;
--> statement-breakpoint
-- 2. Feed data, no peers involved: safe to drop outright.
DELETE FROM "route_rule_versions" WHERE "profile" = 'ru_whitelist';
--> statement-breakpoint
-- 3. Recreate the enum without the removed value. The guard above and the
-- delete above are what make the USING casts below safe: neither column can
-- hold 'ru_whitelist' by the time these run.
ALTER TYPE "public"."route_profile" RENAME TO "route_profile_old";--> statement-breakpoint
CREATE TYPE "public"."route_profile" AS ENUM('full_tunnel', 'ru_blacklist');--> statement-breakpoint
ALTER TABLE "vpn_keys" ALTER COLUMN "route_profile" TYPE "public"."route_profile" USING "route_profile"::text::"public"."route_profile";--> statement-breakpoint
ALTER TABLE "route_rule_versions" ALTER COLUMN "profile" TYPE "public"."route_profile" USING "profile"::text::"public"."route_profile";--> statement-breakpoint
DROP TYPE "public"."route_profile_old";--> statement-breakpoint
-- 4. Strip the retired key from stored JSON so an old payload keeps parsing
-- against the narrower contract shape, and update the default for new rows.
UPDATE "users" SET "custom_routes" = "custom_routes" - 'ru_whitelist'
  WHERE "custom_routes" ? 'ru_whitelist';--> statement-breakpoint
UPDATE "global_route_overrides" SET "payload" = "payload" - 'ru_whitelist'
  WHERE "payload" ? 'ru_whitelist';--> statement-breakpoint
ALTER TABLE "global_route_overrides" ALTER COLUMN "payload" SET DEFAULT '{"ru_blacklist":{"add":{"cidrs":[],"domains":[]},"exclude":{"cidrs":[],"domains":[]}}}'::jsonb;
