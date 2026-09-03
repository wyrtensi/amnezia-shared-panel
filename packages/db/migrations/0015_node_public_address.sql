ALTER TABLE "nodes" ADD COLUMN "public_host" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "public_ip" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "public_ip_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "show_node_address" boolean DEFAULT false NOT NULL;