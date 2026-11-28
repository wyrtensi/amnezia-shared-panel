ALTER TABLE "node_vpn_endpoints" ADD COLUMN "egress_auto_rotate_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "egress_auto_rotate_pool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD COLUMN "egress_auto_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node_vpn_endpoints" ADD CONSTRAINT "node_vpn_endpoints_egress_auto_rotate_pool_valid" CHECK (jsonb_typeof("egress_auto_rotate_pool_ids") = 'array');
