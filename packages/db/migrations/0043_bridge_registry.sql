CREATE TABLE "vpn_bridge_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"bridge_id" uuid NOT NULL,
	"public_udp_port" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"frp_proxy_name" text NOT NULL,
	"observed_online" boolean,
	"observed_registration_marker" text,
	"observed_at" timestamp with time zone,
	"verification_method" text,
	"verified_registration_marker" text,
	"verified_at" timestamp with time zone,
	"verification_result" text,
	"verification_error" text,
	"activated_at" timestamp with time zone,
	"retiring_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vpn_bridge_routes_state_valid" CHECK ("vpn_bridge_routes"."state" in ('draft', 'active', 'retiring')),
	CONSTRAINT "vpn_bridge_routes_port_range" CHECK ("vpn_bridge_routes"."public_udp_port" between 1 and 65535),
	CONSTRAINT "vpn_bridge_routes_verification_method_valid" CHECK ("vpn_bridge_routes"."verification_method" is null or "vpn_bridge_routes"."verification_method" in ('probe', 'operator')),
	CONSTRAINT "vpn_bridge_routes_verification_result_valid" CHECK ("vpn_bridge_routes"."verification_result" is null or "vpn_bridge_routes"."verification_result" in ('success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "vpn_bridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"public_ipv4" text NOT NULL,
	"control_tcp_port" integer DEFAULT 7000 NOT NULL,
	"udp_port_start" integer DEFAULT 41000 NOT NULL,
	"udp_port_end" integer DEFAULT 41031 NOT NULL,
	"management_status" text DEFAULT 'pending_enrollment' NOT NULL,
	"last_observed_at" timestamp with time zone,
	"last_poll_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vpn_bridges_control_tcp_port_range" CHECK ("vpn_bridges"."control_tcp_port" between 1 and 65535),
	CONSTRAINT "vpn_bridges_udp_port_start_range" CHECK ("vpn_bridges"."udp_port_start" between 1 and 65535),
	CONSTRAINT "vpn_bridges_udp_port_end_range" CHECK ("vpn_bridges"."udp_port_end" between 1 and 65535),
	CONSTRAINT "vpn_bridges_udp_port_order" CHECK ("vpn_bridges"."udp_port_start" <= "vpn_bridges"."udp_port_end"),
	CONSTRAINT "vpn_bridges_management_status_valid" CHECK ("vpn_bridges"."management_status" in ('pending_enrollment', 'ok', 'down', 'stale', 'identity_mismatch', 'unsupported'))
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "vpn_endpoint_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD CONSTRAINT "vpn_bridge_routes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_bridge_routes" ADD CONSTRAINT "vpn_bridge_routes_bridge_id_vpn_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."vpn_bridges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_bridge_routes_bridge_port_unique" ON "vpn_bridge_routes" USING btree ("bridge_id","public_udp_port");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_bridge_routes_node_bridge_unique" ON "vpn_bridge_routes" USING btree ("node_id","bridge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_bridge_routes_node_active_unique" ON "vpn_bridge_routes" USING btree ("node_id") WHERE "vpn_bridge_routes"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_bridges_public_ipv4_unique" ON "vpn_bridges" USING btree ("public_ipv4");