"use client";

import { Badge } from "@/components/ui/badge";
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
        <Badge
          key={check.name}
          variant={
            check.state === "works"
              ? "success"
              : check.state === "unavailable"
                ? "destructive"
                : "outline"
          }
          className="shrink-0 font-normal"
        >
          {check.name}: {t(`checks.state.${check.state}`)}
        </Badge>
      ))}
    </span>
  );
}
