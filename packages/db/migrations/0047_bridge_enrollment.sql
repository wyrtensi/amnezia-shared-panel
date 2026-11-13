ALTER TABLE "vpn_bridges" ADD COLUMN "management_api_url" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "management_credential_ciphertext" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "management_credential_nonce" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "management_credential_auth_tag" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "management_credential_key_version" integer;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "management_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "agent_api_version" integer;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "agent_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "frps_version" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "frps_reachable" boolean;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD CONSTRAINT "vpn_bridges_management_enrollment_complete" CHECK (("vpn_bridges"."management_api_url" is null and "vpn_bridges"."management_credential_ciphertext" is null and "vpn_bridges"."management_credential_nonce" is null and "vpn_bridges"."management_credential_auth_tag" is null and "vpn_bridges"."management_credential_key_version" is null and "vpn_bridges"."management_enrolled_at" is null) or ("vpn_bridges"."management_api_url" is not null and "vpn_bridges"."management_credential_ciphertext" is not null and "vpn_bridges"."management_credential_nonce" is not null and "vpn_bridges"."management_credential_auth_tag" is not null and "vpn_bridges"."management_credential_key_version" is not null and "vpn_bridges"."management_enrolled_at" is not null));