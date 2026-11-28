"use client";

import { ArrowUpRight } from "lucide-react";
import type { KeyEgressInfo } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n/provider";

/**
 * Admin-only badge for outbound egress routing on a key.
 * Regular users never receive `key.egress` from the API.
 */
export function KeyEgressBadge({ egress }: { egress?: KeyEgressInfo }) {
  const { t } = useT();
  if (!egress) return null;
  const label =
    egress.exitLabel ||
    egress.effectiveExitIp ||
    t(`egress.mode.${egress.mode}`);
  const dnsText = egress.dnsSecondary
    ? t("keyCard.egressDnsPair", {
        primary: egress.dnsPrimary,
        secondary: egress.dnsSecondary,
      })
    : t("keyCard.egressDns", { primary: egress.dnsPrimary });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="cursor-help gap-1 font-mono text-[11px]"
        >
          <ArrowUpRight className="h-3 w-3 shrink-0" />
          <span className="max-w-28 truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 space-y-0.5 text-xs">
        <p className="font-medium">{t("keyCard.egressTooltipTitle")}</p>
        <p>{t("keyCard.egressIp", { ip: egress.effectiveExitIp ?? "—" })}</p>
        <p>{dnsText}</p>
        <p>{t("keyCard.egressMode", { mode: t(`egress.mode.${egress.mode}`) })}</p>
      </TooltipContent>
    </Tooltip>
  );
}
