ALTER TABLE "vpn_keys" ADD COLUMN "internal_name" varchar(80);--> statement-breakpoint
COMMENT ON COLUMN "vpn_keys"."internal_name" IS 'Operator-only label. Never rendered to the key owner and never part of a generated config.';
