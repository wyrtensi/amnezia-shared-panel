-- Bridge databases may have advanced past the timestamp of migration 0042a.
ALTER TABLE "reachability_probe" ADD COLUMN IF NOT EXISTS "widget_sent_at" timestamp with time zone;
