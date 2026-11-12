"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/provider";
import { blockedFirst } from "@/lib/node-reachability";
import type { NodeView, UserNodeReachability } from "@/lib/types";
import { cn } from "@/lib/utils";

const DOT: Record<UserNodeReachability["state"], { className: string; labelKey: string }> = {
  ok: { className: "bg-success", labelKey: "emp.serverOk" },
  blocked: { className: "bg-destructive", labelKey: "emp.serverBlocked" },
  // Grey, never red: no data is not a block.
  unknown: { className: "bg-muted-foreground/40", labelKey: "emp.serverUnknown" },
};

/**
 * The servers a user may use, one short row each: a status dot and the name,
 * the way the Telegram status widget lists nodes. A blocked server goes to the
 * top and says since when. The dot is left out when the API sends no verdict
 * (the policy hides node status), rather than drawn grey for every server.
 */
export function ServerStatusList({ nodes }: { nodes: readonly NodeView[] }) {
  const { t } = useT();
  return (
    <ul className="space-y-1.5" aria-label={t("emp.servers")}>
      {blockedFirst(nodes).map((node) => {
        const reachability = node.reachability;
        const dot = reachability ? DOT[reachability.state] : null;
        return (
          <li key={node.id} className="flex min-w-0 items-start gap-2">
            {dot ? (
              <span
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", dot.className)}
                title={t(dot.labelKey)}
              >
                <span className="sr-only">{t(dot.labelKey)}</span>
              </span>
            ) : null}
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm">{node.name}</span>
                {node.recommended ? (
                  <Badge
                    variant="success"
                    className="h-4 shrink-0 px-1 py-0 text-[10px] leading-none"
                  >
                    {t("wizard.recommended")}
                  </Badge>
                ) : null}
              </span>
              {reachability?.state === "blocked" && reachability.sinceText ? (
                <span className="block text-xs text-destructive">
                  {t("emp.blockedSince", { since: reachability.sinceText })}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
