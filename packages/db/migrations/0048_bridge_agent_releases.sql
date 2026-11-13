CREATE TABLE "bridge_agent_releases" (
	"repository" text PRIMARY KEY NOT NULL,
	"version" varchar(64) NOT NULL,
	"digest" varchar(80) NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL
);
