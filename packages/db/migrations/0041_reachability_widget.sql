ALTER TABLE "reachability_probe" ADD COLUMN "time_zone" varchar(64) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "last_run_mass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "widget_message_id" bigint;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "widget_chat_id" text;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "widget_version" varchar(64);--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "widget_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reachability_probe" ADD COLUMN "widget_last_error" varchar(300);