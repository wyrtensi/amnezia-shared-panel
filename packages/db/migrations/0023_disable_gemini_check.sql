-- Disable the seeded Google Gemini check. It cannot work over plain HTTP, and
-- this is a measurement rather than a suspicion.
--
-- The check was derived from a DIFF of two browser-saved pages, which is the
-- right method - and the plan and the runbook both carried the caveat that a
-- page saved by a browser AFTER JavaScript ran is not evidence of what a plain
-- fetch sees. Calibrated on a live node 2026-09-04, against the actually served
-- HTML (822 KB, HTTP 200, from a node Google does not refuse):
--
--     conversation-container    0   (20 in the browser capture)
--     account-rejected          0   (24 in the browser capture)
--     above-input-area          0   (19 in the browser capture)
--     chat-history-list         0   (2  in the browser capture)
--     input-area-container     85   - the trap: present on BOTH pages, and its
--                                    first occurrence is past the probe's
--                                    64 KiB read cap anyway
--
-- Every marker in that table, including all three fallbacks the runbook lists,
-- exists only in the DOM the browser builds. None is in the served page. So the
-- honest outcome is the one the runbook names: disable it, record the finding,
-- and do NOT reach for a headless browser.
--
-- What would be needed to re-enable it: a diff of two SERVED pages - one fetched
-- from a node Google accepts and one from a node it refuses - and a marker that
-- separates them and appears in the first 64 KiB. Inventing a marker from the
-- working side alone is exactly the error this whole method exists to prevent.
--
-- Google Flow and NotebookLM are unaffected and stay enabled: both read `ok`
-- from an unblocked node in the same run, which is half their calibration done.
UPDATE "node_service_checks"
SET "enabled" = false,
    "updated_at" = now()
WHERE "name" = 'Google Gemini';
