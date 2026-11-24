-- One-time important rule update trigger per version, plus per-key rule delivery timestamp.
ALTER TABLE "route_rule_versions" ADD COLUMN "notified_at" timestamp with time zone;
ALTER TABLE "route_rule_versions" ADD COLUMN "notify_note" text;
ALTER TABLE "vpn_keys" ADD COLUMN "rules_delivered_at" timestamp with time zone;
CREATE INDEX "route_rule_versions_notified_idx" ON "route_rule_versions" USING btree ("profile", "notified_at") WHERE "route_rule_versions"."notified_at" is not null;
