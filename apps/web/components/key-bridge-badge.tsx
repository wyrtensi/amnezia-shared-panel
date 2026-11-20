"use client";

import { Cable, ArrowRight } from "lucide-react";
import type { KeyBridgeInfo } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { bridgeEntry, keyBridgeState } from "@/lib/bridge-ui";
import { useT } from "@/lib/i18n/provider";

/**
 * Admin-only badge for how a key uses a bridge. Solid when its device
 * connects through a bridge now; muted ("waiting for config") when the next
 * download would use a bridge but the device still runs its older direct
 * config; "Direct" when pinned so. Regular users never receive `key.bridge`
 * from the API, so this renders nothing for them.
 */
export function KeyBridgeBadge({ bridge }: { bridge?: KeyBridgeInfo }) {
  const { t } = useT();
  if (!bridge) return null;
  const state = keyBridgeState(bridge);
  const effective = bridge.effective;
  const entry = effective ? bridgeEntry(effective.publicIpv4, effective.publicUdpPort) : "";
  const name = effective?.bridgeName ?? t("keyBridge.badgeUserEnabled");

  if (state === "bridge") {
    const tip = effective
      ? t(effective.source === "key" ? "keyBridge.tipKey" : "keyBridge.tipPolicy", { name, entry })
      : t("keyBridge.tipConnectedUnassigned");
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="h-5 shrink-0 cursor-help gap-1 border border-primary/30 bg-primary/10 px-1.5 text-[11px] font-medium text-primary"
          >
            <Cable className="size-3 shrink-0" />
            <span className="max-w-28 truncate">{name}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tip}</TooltipContent>
      </Tooltip>
    );
  }

  if (state === "pending") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="h-5 shrink-0 cursor-help gap-1 border-dashed px-1.5 text-[11px] text-muted-foreground"
          >
            <Cable className="size-3 shrink-0" />
            <span className="max-w-40 truncate">
              {name} · {t("keyBridge.pendingSuffix")}
            </span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {t(bridge.observed === "direct" ? "keyBridge.tipPendingDirect" : "keyBridge.tipPendingNever", {
            name,
            entry,
          })}
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
