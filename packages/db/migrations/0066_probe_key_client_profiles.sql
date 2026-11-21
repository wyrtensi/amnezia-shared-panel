-- Probe service keys issued before client profiles existed measure with the
-- node's issued Jc, Jmin, Jmax and I-packet order, while every key issued
-- since carries its own profile. Give each live AWG 3 service key without one
-- a profile drawn like selectAwgClientProfile
-- (packages/vpn-config/src/awgClientProfile.ts): Jc 3-10, Jmin 40-100,
-- Jmax = Jmin + 30-200, one of six I-packet orders, revision 1. The profile
-- is client-side only, so the key is not reissued. Its target IDs change
-- once: a run in flight during the upgrade reports those targets as unknown,
-- so a probe run is queued to measure them again right away.
WITH "drawn" AS (
  SELECT "v"."id",
    3 + floor(random() * 8)::int AS "jc",
    40 + floor(random() * 61)::int AS "jmin",
    30 + floor(random() * 171)::int AS "gap",
    floor(random() * 6)::int AS "cps_order"
  FROM "vpn_keys" AS "v"
  JOIN "users" AS "u" ON "u"."id" = "v"."owner_id"
  WHERE "u"."service_account" = true
    AND "v"."protocol" = 'awg3'
    AND "v"."state" IN ('provisioning', 'active', 'disabled')
    AND "v"."awg_client_profile" IS NULL
), "profiled" AS (
  UPDATE "vpn_keys" AS "k"
  SET "awg_client_profile" = jsonb_build_object(
      'version', 1,
      'revision', 1,
      'jc', "d"."jc",
      'jmin', "d"."jmin",
      'jmax', "d"."jmin" + "d"."gap",
      'cpsOrder', "d"."cps_order"
    ),
    "updated_at" = now()
  FROM "drawn" AS "d"
  WHERE "k"."id" = "d"."id"
  RETURNING "k"."id"
)
UPDATE "reachability_probe"
SET "run_requested_at" = now(), "updated_at" = now()
WHERE "enabled" = true AND EXISTS (SELECT 1 FROM "profiled");
