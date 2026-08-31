ALTER TABLE "portal_policy" ADD COLUMN "allowed_node_ids" jsonb;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_access_account_id" varchar(64);--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_access_app_id" varchar(64);--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_access_policy_id" varchar(64);--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_api_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_api_token_nonce" text;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_api_token_auth_tag" text;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "cf_api_token_key_version" integer;