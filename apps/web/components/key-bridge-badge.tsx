"use client";

import { Cable, ArrowRight } from "lucide-react";
import type { KeyBridgeInfo } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { bridgeEntry } from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";

/**
 * Admin-only badge indicating whether a key currently exports through a bridge
 * (and which one) or is explicitly pinned to Direct. Regular users never
 * receive `key.bridge` from the API, so this renders nothing for them.
 */
export function KeyBridgeBadge({ bridge }: { bridge?: KeyBridgeInfo }) {
  const { t } = useT();
  if (!bridge) return null;

  if (bridge.effective) {
    const entry = bridgeEntry(
      bridge.effective.publicIpv4,
      bridge.effective.publicUdpPort,
    );
    const tipKey =
      bridge.effective.source === "key"
        ? "keyBridge.tipKey"
        : "keyBridge.tipPolicy";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="h-5 shrink-0 cursor-help gap-1 border border-primary/30 bg-primary/10 px-1.5 text-[11px] font-medium text-primary"
          >
            <Cable className="size-3 shrink-0" />
            <span className="max-w-28 truncate">{bridge.effective.bridgeName}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {t(tipKey, { name: bridge.effective.bridgeName, entry })}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (bridge.mode === "direct") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="h-5 shrink-0 cursor-help gap-1 px-1.5 text-[11px] text-muted-foreground"
          >
            <ArrowRight className="size-3 shrink-0" />
            {t("keyBridge.badgeDirectPinned")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {t("keyBridge.tipDirectPinned")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return null;
}
