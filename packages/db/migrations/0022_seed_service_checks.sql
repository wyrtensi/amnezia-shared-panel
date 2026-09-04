-- Service checks seeded from blocked-region evidence captured 2026-09-02 and a
-- working-page capture supplied 2026-09-03. Every marker below is a measured
-- substring count across two saved copies of served HTML - a blocked one and a
-- working one - never a guess.
--
-- RULE FOR ANYONE ADDING A FOURTH CHECK: derive the marker from a DIFF of two
-- captures. Scanning a single blocked page tells you only that one guessed
-- string is absent; it cannot tell a missing marker apart from missing
-- evidence. That mistake is how Gemini was written off as uncheckable for a
-- day. See docs/SERVICE-CHECKS.md.
--
-- Google Flow (failure markers). The blocked page is server-side rendered by
-- Next.js at the route /tools/flow/unsupported-country, so both the final URL
-- and the SSR payload carry the marker. Two independent assertions, either of
-- which fires.
--
-- NotebookLM (failure marker). From an IP Google does not accept,
-- notebooklm.google.com redirects server-side to
-- https://notebook.google/?location=unsupported - note the target domain is
-- notebook.google, not notebooklm.google.com. The final URL is the primary
-- assertion; the body hits are nav-link hrefs echoing the URL the browser is
-- already on (Angular queryParamsHandling="merge"), so they are redundancy
-- rather than independent evidence, and they are seeded as such.
--
-- Google Gemini (SUCCESS marker - the odd one out). Its blocked page carries no
-- usable failure TEXT, so this check asserts that the chat UI is PRESENT.
-- Measured, blocked page vs working page:
--     conversation-container        0  vs  20   <- asserted, threshold 10
--     account-rejected             24  vs   0   <- asserted, must be absent
--     above-input-area              0  vs  19   (usable alternative)
--     chat-history-list             0  vs   2   (usable alternative)
--
-- The count assertion rather than a plain "contains": 20 against 0 is the
-- measurement, and a threshold at half of it survives a restyle that drops a
-- few occurrences while still separating the two pages.
--
-- DO NOT assert on "input-area-container": 58 on the blocked page against 86 on
-- the working one. It is present on BOTH, so as a positive assertion it stays
-- green from a blocked node and as a negative one it goes red from a working
-- one. It reads like the right class and sits one word from "above-input-area",
-- which is discriminating - which is exactly why it is named here.
--
-- Both Gemini markers live in <head> inline Angular component styles, not in
-- class attributes; whether a plain fetch sees them at all is what the
-- calibration run in docs/runbooks/service-check-calibration.md confirms.
INSERT INTO "node_service_checks" ("name", "probe", "assertions", "interval_sec", "enabled")
VALUES
  (
    'Google Flow',
    '{"kind":"http","url":"https://labs.google/fx/tools/flow/","method":"GET","timeoutMs":10000}'::jsonb,
    '[{"type":"statusIn","statuses":[200]},
      {"type":"finalUrlOmits","value":"unsupported-country"},
      {"type":"bodyOmits","value":"/tools/flow/unsupported-country"}]'::jsonb,
    43200,
    true
  ),
  (
    'NotebookLM',
    '{"kind":"http","url":"https://notebooklm.google.com/","method":"GET","timeoutMs":10000}'::jsonb,
    '[{"type":"statusIn","statuses":[200]},
      {"type":"finalUrlOmits","value":"location=unsupported"},
      {"type":"bodyOmits","value":"location=unsupported"}]'::jsonb,
    43200,
    true
  ),
  (
    'Google Gemini',
    '{"kind":"http","url":"https://gemini.google.com/","method":"GET","timeoutMs":10000}'::jsonb,
    '[{"type":"statusIn","statuses":[200]},
      {"type":"bodyOccurrencesAtLeast","value":"conversation-container","count":10},
      {"type":"bodyOmits","value":"account-rejected"}]'::jsonb,
    43200,
    true
  )
-- Re-runnable, and - more importantly - an admin who has already renamed or
-- retuned these by hand does not get them silently reset.
ON CONFLICT ("name") DO NOTHING;
