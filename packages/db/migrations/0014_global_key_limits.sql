CREATE TYPE "public"."key_limit_mode" AS ENUM('per_node', 'global');--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "key_limit_mode" "key_limit_mode" DEFAULT 'per_node' NOT NULL;