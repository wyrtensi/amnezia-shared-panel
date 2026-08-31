ALTER TABLE "vpn_keys" ADD COLUMN "key_number" integer;
--> statement-breakpoint
-- Backfill existing keys with a stable per-owner sequence, oldest first.
UPDATE "vpn_keys" AS k
SET "key_number" = seq.rn
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "owner_id" ORDER BY "created_at" ASC, "id" ASC
  ) AS rn
  FROM "vpn_keys"
) AS seq
WHERE k."id" = seq."id" AND k."key_number" IS NULL;
