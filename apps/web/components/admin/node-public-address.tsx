"use client";

import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { isIpLiteral } from "@amnezia/contracts";

/**
 * Where clients reach the node, plus the IP the panel resolved it to when the
 * host is a DNS name. Three states an operator must not confuse: the agent
 * never told us; it told us and the name resolved; it told us and the name has
 * never resolved.
 *
 * Shared by the nodes page and the overview so the same address never gets two
 * spellings — the value cell of a card's "public address" row on both.
 */
export function NodePublicAddress({
  host,
  ip,
  resolvedAt,
}: {
  host: string | null;
  ip: string | null;
  resolvedAt: string | null;
}) {
  const { t, lang } = useT();
  if (host === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate text-muted-foreground">
            {t("nodes.publicAddressUnknown")}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("nodes.publicAddressUnknownHint")}</TooltipContent>
      </Tooltip>
    );
  }
  // An IP literal is its own answer; repeating it as a resolved address would
  // be noise, and there was no lookup to date-stamp.
  if (isIpLiteral(host)) {
    return <span className="truncate tabular">{host}</span>;
  }
  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5">
      <span className="truncate">{host}</span>
      {ip === null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Badge variant="outline" className="gap-1">
                <TriangleAlert className="h-3 w-3" />
                {t("nodes.publicIpUnresolved")}
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("nodes.publicIpUnresolvedHint")}</TooltipContent>
        </Tooltip>
      ) : (
        // The resolution time lives in the tooltip, not on the row: it says
        // when the panel learned the address, which an operator wants once and
        // never again. There is deliberately no staleness warning — the address
        // is resolved once because a node's public address does not change, so
        // a "this might be old" badge would fire on a condition that cannot
        // happen and would train the operator to ignore badges.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate tabular">{ip}</span>
          </TooltipTrigger>
          <TooltipContent>
            {t("nodes.publicIpResolvedAt", {
              when: formatDateTime(resolvedAt, lang),
            })}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
