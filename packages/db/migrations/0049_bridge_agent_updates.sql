CREATE TABLE "vpn_bridge_agent_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bridge_id" uuid NOT NULL,
	"image_repository" text NOT NULL,
	"image_digest" text NOT NULL,
	"image_version" text,
	"from_version" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"agent_state" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"contact_lost_since" timestamp with time zone,
	"error_code" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vpn_bridge_agent_updates_state_valid" CHECK ("vpn_bridge_agent_updates"."state" in ('queued', 'sent', 'acknowledged', 'running', 'succeeded', 'rolled_back', 'rollback_failed', 'failed', 'unsupported', 'pickup_timeout')),
	CONSTRAINT "vpn_bridge_agent_updates_digest_valid" CHECK ("vpn_bridge_agent_updates"."image_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "vpn_bridge_agent_updates" ADD CONSTRAINT "vpn_bridge_agent_updates_bridge_id_vpn_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."vpn_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_bridge_agent_updates_outstanding_unique" ON "vpn_bridge_agent_updates" USING btree ("bridge_id") WHERE "vpn_bridge_agent_updates"."state" in ('queued', 'sent', 'acknowledged', 'running');--> statement-breakpoint
CREATE INDEX "vpn_bridge_agent_updates_bridge_idx" ON "vpn_bridge_agent_updates" USING btree ("bridge_id","requested_at");