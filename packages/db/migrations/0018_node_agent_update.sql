CREATE TABLE "node_agent_releases" (
	"repository" text PRIMARY KEY NOT NULL,
	"version" varchar(64) NOT NULL,
	"digest" varchar(80) NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "agent_update_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "agent_update_image" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "agent_update_message" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "agent_update_log" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "agent_update_at" timestamp with time zone;