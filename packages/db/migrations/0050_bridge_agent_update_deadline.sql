ALTER TABLE "vpn_bridge_agent_updates" DROP CONSTRAINT "vpn_bridge_agent_updates_state_valid";--> statement-breakpoint
ALTER TABLE "vpn_bridge_agent_updates" ADD COLUMN "not_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "vpn_bridge_agent_updates" ADD COLUMN "send_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vpn_bridge_agent_updates" ADD COLUMN "acknowledgement_overdue_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vpn_bridges" ADD COLUMN "agent_capabilities_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vpn_bridge_agent_updates" ADD CONSTRAINT "vpn_bridge_agent_updates_state_valid" CHECK ("vpn_bridge_agent_updates"."state" in ('queued', 'sent', 'acknowledged', 'running', 'succeeded', 'rolled_back', 'rollback_failed', 'failed', 'pickup_timeout'));