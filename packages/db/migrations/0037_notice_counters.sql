ALTER TABLE "portal_policy" ADD COLUMN "show_update_notice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "install_notice_acks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "update_notice_acks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Seed the install counter from what the panel could already see, so an
-- upgrade does not re-issue the first-key warning to every existing account.
-- `vpn_keys` rows survive revocation, so "has ever had a key row" is the same
-- population the old `key_number` rule had already stopped warning.
UPDATE "users" SET "install_notice_acks" = 1
WHERE EXISTS (
  SELECT 1 FROM "vpn_keys" WHERE "vpn_keys"."owner_id" = "users"."id"
);
