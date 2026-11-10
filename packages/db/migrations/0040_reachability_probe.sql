CREATE TYPE "public"."reachability_alert_kind" AS ENUM('node', 'mass');--> statement-breakpoint
CREATE TABLE "node_reachability_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "service_check_status" NOT NULL,
	"detail" varchar(300),
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_reachability_results" (
	"node_id" uuid NOT NULL,
	"protocol" "protocol_kind" NOT NULL,
	"status" "service_check_status" NOT NULL,
	"levels" jsonb NOT NULL,
	"egress_ip" text,
	"detail" varchar(300),
	"run_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "node_reachability_results_node_id_protocol_pk" PRIMARY KEY("node_id","protocol")
);
--> statement-breakpoint
CREATE TABLE "node_reachability_state" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"status" "service_check_status" NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"alert_kind" "reachability_alert_kind",
	"checked_at" timestamp with time zone NOT NULL,
	"detail" varchar(300)
);
--> statement-breakpoint
CREATE TABLE "reachability_probe" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"label" varchar(80) NOT NULL,
	"api_base_url" text NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"credentials_nonce" text NOT NULL,
	"credentials_auth_tag" text NOT NULL,
	"credentials_key_version" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"control_url" text NOT NULL,
	"egress_url" text DEFAULT 'https://api.ipify.org' NOT NULL,
	"interval_sec" integer DEFAULT 3600 NOT NULL,
	"fail_threshold" integer DEFAULT 2 NOT NULL,
	"stale_after_sec" integer DEFAULT 10800 NOT NULL,
	"run_requested_at" timestamp with time zone,
	"current_run_id" uuid,
	"current_run_started_at" timestamp with time zone,
	"last_result_at" timestamp with time zone,
	"last_ingested_run_id" uuid,
	"last_error" varchar(300),
	"last_error_at" timestamp with time zone,
	"stale_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reachability_probe_singleton" CHECK ("reachability_probe"."id" = 1),
	CONSTRAINT "reachability_probe_interval_range" CHECK ("reachability_probe"."interval_sec" >= 300 AND "reachability_probe"."interval_sec" <= 86400),
	CONSTRAINT "reachability_probe_threshold_range" CHECK ("reachability_probe"."fail_threshold" >= 1 AND "reachability_probe"."fail_threshold" <= 10),
	CONSTRAINT "reachability_probe_stale_range" CHECK ("reachability_probe"."stale_after_sec" >= 600 AND "reachability_probe"."stale_after_sec" <= 604800)
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "reachability_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "service_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_reachability_history" ADD CONSTRAINT "node_reachability_history_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_reachability_results" ADD CONSTRAINT "node_reachability_results_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_reachability_state" ADD CONSTRAINT "node_reachability_state_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_reachability_history_node_idx" ON "node_reachability_history" USING btree ("node_id","checked_at");