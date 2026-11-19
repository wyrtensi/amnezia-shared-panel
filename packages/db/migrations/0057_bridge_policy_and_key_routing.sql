ALTER TABLE "portal_policy" ADD COLUMN "use_bridge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "bridge_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD COLUMN "vpn_bridge_route_id" uuid;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_vpn_bridge_route_id_vpn_bridge_routes_id_fk" FOREIGN KEY ("vpn_bridge_route_id") REFERENCES "public"."vpn_bridge_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_bridge_mode_valid" CHECK ("vpn_keys"."bridge_mode" in ('inherit', 'direct', 'route'));--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_bridge_route_consistency" CHECK ("vpn_keys"."bridge_mode" = 'route' or "vpn_keys"."vpn_bridge_route_id" is null);