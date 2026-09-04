"use client";

import { useT } from "@/lib/i18n/provider";
import type { ServiceCheckSummary } from "@/lib/types";

/**
 * What a user is told about the services reachable from one server: a name and
 * one of three words.
 *
 * Never a URL, never a failure detail, never an HTTP status - the API does not
 * send them here, and this component could not show them if it wanted to.
 *
 * `unknown` is its own word rather than a shade of "unavailable". It means the
 * node could not perform the check, or its last answer is too old to trust, so
 * nothing is known about the service. Telling someone a service is blocked when
 * the server never managed to look is worse than telling them nothing.
 *
 * Quiet on purpose. These sit under a server's name in a list of servers, and
 * the normal case is every service working - a row of filled green pills that
 * pulled the eye away from the server itself and from its traffic. Only
 * `unavailable` keeps its colour, because that is the one a reader has to act
 * on; the rest are muted text with a small dot. Colour marks the exception, not
 * the norm.
 */
export function ServiceCheckChips({
  checks,
}: {
  checks?: ServiceCheckSummary[] | null;
}) {
  const { t } = useT();
  if (!checks || checks.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {checks.map((check) => (
        <span
          key={check.name}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
            check.state === "unavailable"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border/60 bg-muted/40 text-muted-foreground"
          }`}
        >
          {/*
            The dot carries the state at a glance; the word carries it for
            everyone else. Colour is never the only signal - the text beside it
            says "works", "unavailable" or "unknown" in full.
          */}
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              check.state === "works"
                ? "bg-success"
                : check.state === "unavailable"
                  ? "bg-destructive"
                  : "bg-muted-foreground/40"
            }`}
          />
          {check.name}: {t(`checks.state.${check.state}`)}
        </span>
      ))}
    </span>
  );
}
