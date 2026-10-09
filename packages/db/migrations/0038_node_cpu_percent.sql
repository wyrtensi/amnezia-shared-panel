ALTER TABLE "node_metrics_current" ADD COLUMN "cpu_used_percent" real;--> statement-breakpoint
ALTER TABLE "node_metrics_current" ADD COLUMN "cpu_iowait_percent" real;--> statement-breakpoint
ALTER TABLE "node_metrics_current" ADD COLUMN "cpu_steal_percent" real;--> statement-breakpoint
ALTER TABLE "node_metrics_current" ADD COLUMN "cpu_per_core_percent" jsonb;--> statement-breakpoint
ALTER TABLE "node_metrics_samples" ADD COLUMN "cpu_used_percent" real;