ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "ipv6_reject_stub_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "ipv6_reject_stub_prefix" text DEFAULT 'fd6b:7c2e:4a91:9f::/64' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "ipv6_reject_stub_state" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "ipv6_reject_stub_reason" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "ipv6_reject_stub_observed_at" timestamp with time zone;
