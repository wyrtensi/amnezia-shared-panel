-- The status widget becomes one shared widget shown in every notification
-- chat: its id lives on the probe, its copy per chat in a table of its own.
ALTER TABLE "reachability_probe"
  ADD COLUMN "widget_shared_id" text;
--> statement-breakpoint
CREATE TABLE "reachability_widget_messages" (
  "chat_id" text PRIMARY KEY,
  "message_id" bigint NOT NULL,
  "widget_id" text,
  "sent_at" timestamp with time zone
);
--> statement-breakpoint
-- The widget message sent before sharing, so the next refresh unpins it in
-- its chat. A null widget id marks it as a copy to replace. The old columns
-- stay, unused, so an older image still starts.
INSERT INTO "reachability_widget_messages" ("chat_id", "message_id", "widget_id", "sent_at")
SELECT "widget_chat_id", "widget_message_id", NULL, "widget_sent_at"
FROM "reachability_probe"
WHERE "widget_chat_id" IS NOT NULL AND "widget_message_id" IS NOT NULL
ON CONFLICT ("chat_id") DO NOTHING;
