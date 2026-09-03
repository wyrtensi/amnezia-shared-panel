-- Device types become platforms: android / ios / macos / windows / linux.
-- "iphone" maps exactly onto the wider "ios" (it covers iPad too). The old
-- form-factor values named a shape, not a platform, and the panel never learned
-- which OS was behind them, so they become "unspecified" rather than "other":
-- "other" would claim the platform is outside the list, which is a fact this
-- panel does not have. "tablet" is absent because the enum never contained it.
ALTER TYPE "public"."device_type" RENAME TO "device_type_legacy";--> statement-breakpoint
CREATE TYPE "public"."device_type" AS ENUM('android', 'ios', 'macos', 'windows', 'linux', 'other', 'unspecified');--> statement-breakpoint
-- A key card shows its device LABEL, falling back to the raw type when there is
-- none. Rows created without a label used to print "laptop"/"desktop"/"phone";
-- keep those words on screen before the value behind them is dropped. Rows that
-- already carry a label are untouched. Must run before the type conversion.
UPDATE "vpn_keys"
SET "device_label" = initcap("device_type"::text)
WHERE "device_type"::text IN ('desktop', 'laptop', 'phone')
  AND ("device_label" IS NULL OR btrim("device_label") = '');--> statement-breakpoint
ALTER TABLE "vpn_keys" ALTER COLUMN "device_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "vpn_keys" ALTER COLUMN "device_type" SET DATA TYPE "public"."device_type" USING (
  CASE "device_type"::text
    WHEN 'iphone' THEN 'ios'
    WHEN 'desktop' THEN 'unspecified'
    WHEN 'laptop' THEN 'unspecified'
    WHEN 'phone' THEN 'unspecified'
    ELSE "device_type"::text
  END
)::"public"."device_type";--> statement-breakpoint
ALTER TABLE "vpn_keys" ALTER COLUMN "device_type" SET DEFAULT 'unspecified';--> statement-breakpoint
DROP TYPE "public"."device_type_legacy";
