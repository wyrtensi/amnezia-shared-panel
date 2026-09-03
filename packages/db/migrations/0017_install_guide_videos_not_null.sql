-- Existing rows carry NULL: the column was added nullable in 0013 and only
-- written when an admin attached a video. SET NOT NULL would abort on exactly
-- those rows, so backfill first. NULL and '{}' already mean the same thing
-- ("no videos configured") everywhere that reads this column.
UPDATE "portal_policy" SET "install_guide_videos" = '{}'::jsonb WHERE "install_guide_videos" IS NULL;--> statement-breakpoint
ALTER TABLE "portal_policy" ALTER COLUMN "install_guide_videos" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "portal_policy" ALTER COLUMN "install_guide_videos" SET NOT NULL;