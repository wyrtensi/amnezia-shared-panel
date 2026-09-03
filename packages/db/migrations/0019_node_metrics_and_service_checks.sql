CREATE TYPE "public"."service_check_status" AS ENUM('ok', 'failed', 'error');--> statement-breakpoint
CREATE TABLE "node_metrics_current" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"agent_latency_ms" integer,
	"uptime_sec" bigint,
	"cpu_cores" integer,
	"load1" real,
	"load5" real,
	"load15" real,
	"mem_total_bytes" bigint,
	"mem_available_bytes" bigint,
	"swap_total_bytes" bigint,
	"swap_used_bytes" bigint,
	"disk_total_bytes" bigint,
	"disk_available_bytes" bigint,
	"disk_used_percent" real,
	"agent_pids_current" integer,
	"agent_pids_max" integer,
	"awg3_up" boolean,
	"awg3_peers" integer,
	"awg2_up" boolean,
	"awg2_peers" integer,
	"public_host" varchar(253),
	"listen_ports" jsonb
);
--> statement-breakpoint
CREATE TABLE "node_metrics_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "node_metrics_samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"node_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"load1" real,
	"mem_available_bytes" bigint,
	"swap_used_bytes" bigint,
	"disk_used_percent" real,
	"agent_pids_current" integer,
	"awg3_peers" integer
);
--> statement-breakpoint
CREATE TABLE "node_service_check_results" (
	"node_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"status" "service_check_status" NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"detail" varchar(300),
	"final_url" varchar(500),
	"checked_at" timestamp with time zone NOT NULL,
	"failing_since" timestamp with time zone,
	CONSTRAINT "node_service_check_results_node_id_check_id_pk" PRIMARY KEY("node_id","check_id")
);
--> statement-breakpoint
CREATE TABLE "node_service_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"url" text NOT NULL,
	"expected_statuses" jsonb DEFAULT '[200]'::jsonb NOT NULL,
	"body_must_contain" varchar(200),
	"body_must_not_contain" varchar(200),
	"final_url_must_not_contain" varchar(200),
	"interval_sec" integer DEFAULT 43200 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_service_checks_interval_range" CHECK ("node_service_checks"."interval_sec" >= 60 AND "node_service_checks"."interval_sec" <= 86400)
);
--> statement-breakpoint
ALTER TABLE "portal_policy" ADD COLUMN "show_node_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "node_metrics_current" ADD CONSTRAINT "node_metrics_current_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_metrics_samples" ADD CONSTRAINT "node_metrics_samples_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_service_check_results" ADD CONSTRAINT "node_service_check_results_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_service_check_results" ADD CONSTRAINT "node_service_check_results_check_id_node_service_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."node_service_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_metrics_samples_node_sampled_idx" ON "node_metrics_samples" USING btree ("node_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "node_service_checks_name_unique" ON "node_service_checks" USING btree ("name");