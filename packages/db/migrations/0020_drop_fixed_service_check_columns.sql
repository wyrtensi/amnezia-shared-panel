-- Service checks become probe + assertions (see 0021, which adds them).
--
-- The five fixed columns below described exactly one shape of check: fetch a
-- URL, look for a substring. Every rule outside that shape - a substring COUNT,
-- a body size, a response header, a HEAD request - would have been another
-- column here, another field in the contract, the API, the UI and the CLI, and
-- another migration. They become two JSONB documents validated by
-- checkProbeSchema / checkAssertionSchema in @amnezia/contracts.
--
-- There is no data migration because this table has never been seeded and the
-- route that writes it does not exist yet. That is an assumption about the
-- deployment, not about the code, so it is CHECKED rather than assumed: on any
-- database where a row does exist, this fails loudly instead of dropping the
-- only description of what that check asserted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "node_service_checks") THEN
    RAISE EXCEPTION 'node_service_checks is not empty: write a data migration before dropping its columns';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "node_service_checks" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "node_service_checks" DROP COLUMN "expected_statuses";--> statement-breakpoint
ALTER TABLE "node_service_checks" DROP COLUMN "body_must_contain";--> statement-breakpoint
ALTER TABLE "node_service_checks" DROP COLUMN "body_must_not_contain";--> statement-breakpoint
ALTER TABLE "node_service_checks" DROP COLUMN "final_url_must_not_contain";