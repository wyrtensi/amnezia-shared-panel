CREATE TYPE "public"."device_type" AS ENUM('desktop', 'laptop', 'iphone', 'android', 'phone', 'other', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."key_state" AS ENUM('provisioning', 'active', 'disabled', 'revoking', 'revoked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."protocol_kind" AS ENUM('awg2', 'awg3');--> statement-breakpoint
CREATE TYPE "public"."quota_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."rollup_period" AS ENUM('hour', 'day');--> statement-breakpoint
CREATE TYPE "public"."route_profile" AS ENUM('full_tunnel', 'ru_whitelist');--> statement-breakpoint
CREATE TYPE "public"."rule_version_status" AS ENUM('active', 'superseded', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid,
	"actor_type" varchar(32) NOT NULL,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" text,
	"request_id" uuid,
	"ip_address" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(80) NOT NULL,
	"subject" varchar(512) NOT NULL,
	"email_at_login" varchar(320),
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(100) NOT NULL,
	"deduplication_key" varchar(200) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"api_base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"protocol" "protocol_kind" DEFAULT 'awg2' NOT NULL,
	"max_peers" integer DEFAULT 500 NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"credentials_nonce" text NOT NULL,
	"credentials_auth_tag" text NOT NULL,
	"credentials_key_version" integer NOT NULL,
	"label_secret_ciphertext" text NOT NULL,
	"label_secret_nonce" text NOT NULL,
	"label_secret_auth_tag" text NOT NULL,
	"label_secret_key_version" integer NOT NULL,
	"last_health_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_max_peers_positive" CHECK ("nodes"."max_peers" > 0)
);
--> statement-breakpoint
CREATE TABLE "peer_current" (
	"key_id" uuid PRIMARY KEY NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"endpoint" text,
	"latest_handshake_at" timestamp with time zone,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"sent_bytes" bigint DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peer_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "peer_samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key_id" uuid NOT NULL,
	"online" boolean NOT NULL,
	"endpoint" text,
	"latest_handshake_at" timestamp with time zone,
	"received_bytes" bigint NOT NULL,
	"sent_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_policy" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"default_key_limit" integer DEFAULT 5 NOT NULL,
	"allow_key_creation" boolean DEFAULT true NOT NULL,
	"allow_node_selection" boolean DEFAULT true NOT NULL,
	"allow_route_profile_selection" boolean DEFAULT false NOT NULL,
	"allow_config_redownload" boolean DEFAULT true NOT NULL,
	"allow_qr_download" boolean DEFAULT true NOT NULL,
	"allow_conf_download" boolean DEFAULT true NOT NULL,
	"allow_self_revoke" boolean DEFAULT true NOT NULL,
	"show_public_key" boolean DEFAULT false NOT NULL,
	"show_last_used" boolean DEFAULT true NOT NULL,
	"show_traffic" boolean DEFAULT true NOT NULL,
	"daily_retention_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_policy_singleton" CHECK ("portal_policy"."id" = true),
	CONSTRAINT "portal_policy_default_limit_positive" CHECK ("portal_policy"."default_key_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quota_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_limit" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "quota_request_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_requests_limit_positive" CHECK ("quota_requests"."requested_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "route_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile" "route_profile" NOT NULL,
	"version" varchar(96) NOT NULL,
	"source_url" text NOT NULL,
	"source_etag" text,
	"source_checksum" varchar(128) NOT NULL,
	"status" "rule_version_status" NOT NULL,
	"cidr_count" integer DEFAULT 0 NOT NULL,
	"domain_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"validation_report" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_rollups" (
	"key_id" uuid NOT NULL,
	"period" "rollup_period" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"sent_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "traffic_rollups_key_id_period_bucket_start_pk" PRIMARY KEY("key_id","period","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(160),
	"role" "role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"key_limit_override" integer,
	"policy_override" jsonb,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_key_limit_override_positive" CHECK ("users"."key_limit_override" is null or "users"."key_limit_override" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vpn_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"public_key" text,
	"node_label" varchar(80) NOT NULL,
	"protocol" "protocol_kind" NOT NULL,
	"state" "key_state" DEFAULT 'provisioning' NOT NULL,
	"device_type" "device_type" DEFAULT 'unspecified' NOT NULL,
	"device_label" varchar(80),
	"route_profile" "route_profile" NOT NULL,
	"route_rule_version_id" uuid,
	"config_ciphertext" text,
	"config_nonce" text,
	"config_auth_tag" text,
	"config_key_version" integer,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vpn_keys_config_envelope_complete" CHECK (("vpn_keys"."config_ciphertext" is null and "vpn_keys"."config_nonce" is null and "vpn_keys"."config_auth_tag" is null and "vpn_keys"."config_key_version" is null) or ("vpn_keys"."config_ciphertext" is not null and "vpn_keys"."config_nonce" is not null and "vpn_keys"."config_auth_tag" is not null and "vpn_keys"."config_key_version" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_current" ADD CONSTRAINT "peer_current_key_id_vpn_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."vpn_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_samples" ADD CONSTRAINT "peer_samples_key_id_vpn_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."vpn_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_requests" ADD CONSTRAINT "quota_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_requests" ADD CONSTRAINT "quota_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_rollups" ADD CONSTRAINT "traffic_rollups_key_id_vpn_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."vpn_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn_keys" ADD CONSTRAINT "vpn_keys_route_rule_version_id_route_rule_versions_id_fk" FOREIGN KEY ("route_rule_version_id") REFERENCES "public"."route_rule_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_provider_subject_unique" ON "identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_deduplication_unique" ON "job_outbox" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "job_outbox_poll_idx" ON "job_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_name_unique" ON "nodes" USING btree ("name");--> statement-breakpoint
CREATE INDEX "peer_samples_key_sampled_idx" ON "peer_samples" USING btree ("key_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_requests_one_pending_per_user" ON "quota_requests" USING btree ("user_id") WHERE "quota_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "quota_requests_status_created_idx" ON "quota_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "route_rule_versions_profile_version_unique" ON "route_rule_versions" USING btree ("profile","version");--> statement-breakpoint
CREATE INDEX "route_rule_versions_status_idx" ON "route_rule_versions" USING btree ("profile","status");--> statement-breakpoint
CREATE INDEX "traffic_rollups_period_bucket_idx" ON "traffic_rollups" USING btree ("period","bucket_start");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_keys_node_label_unique" ON "vpn_keys" USING btree ("node_id","node_label");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_keys_node_public_key_unique" ON "vpn_keys" USING btree ("node_id","public_key");--> statement-breakpoint
CREATE INDEX "vpn_keys_owner_state_idx" ON "vpn_keys" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "vpn_keys_node_state_idx" ON "vpn_keys" USING btree ("node_id","state");