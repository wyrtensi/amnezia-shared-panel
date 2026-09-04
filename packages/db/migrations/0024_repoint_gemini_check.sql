-- Give the Gemini check assertions that are true of a working page.
--
-- 0023 disabled it: every marker it asserted on is absent from the SERVED HTML,
-- so it read `failed` - "unavailable" to a user - against a service that works
-- perfectly. An admin then re-enabled it from the panel, which made that false
-- reading visible again. This replaces the assertions rather than the enabled
-- flag: an operator's choice about what to run is theirs, and what the check
-- MEASURES is ours to get right.
--
-- The new assertions are measurements taken from the node, not guesses:
--
--   status 200                 the served response, confirmed
--   at least 65536 body bytes  gemini.google.com serves 822 KB, so the probe's
--                              64 KiB read cap is always reached. So are Flow
--                              (632 KB) and NotebookLM (933 KB). A country
--                              block, a /sorry/ interstitial and an error shell
--                              are all far SHORTER than 64 KiB, so "the read
--                              hit the cap" separates the app from a refusal
--                              without depending on any markup at all.
--   final url has no           the server-side redirect Google uses to refuse a
--   "unsupported"              region, confirmed on Flow and NotebookLM
--   final url has no "/sorry/" Google's interstitial for addresses it will not
--                              serve - which is the refusal a VPN exit node
--                              actually meets, far more often than a country
--                              block
--
-- What this does NOT detect: a refusal rendered INSIDE a full-size app shell.
-- Catching that needs a marker, and a marker needs a diff of two SERVED pages -
-- one from an accepted address and one from a refused one. Until someone
-- captures the refused side with scripts/calibrate-check.mjs, this is the
-- honest limit of what has been measured.
UPDATE "node_service_checks"
SET "assertions" = '[{"type":"statusIn","statuses":[200]},
                     {"type":"bodyBytesAtLeast","count":65536},
                     {"type":"finalUrlOmits","value":"unsupported"},
                     {"type":"finalUrlOmits","value":"/sorry/"}]'::jsonb,
    "updated_at" = now()
WHERE "name" = 'Google Gemini';
